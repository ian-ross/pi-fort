/**
 * pi-fort
 *
 * VM-isolated fort for pi with automatic secret protection.
 * All pi tools (bash, read, write, edit) execute inside a Gondolin micro-VM.
 * Secrets never enter the VM; the HTTP proxy injects them on the wire.
 *
 * See README.md for architecture and configuration details.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import type { FortFileConfig, ResolvedHostPolicy, ResolvedSecret } from "./config.js";
import {
	addPackageToConfig,
	effectiveHostPathForCommandInput,
	effectiveMounts,
	initProjectConfig,
	loadConfig,
	projectConfigPath,
	projectDropInDir,
	removeMountConfig,
	requireProjectConfig,
	resetContainerConfig,
	setContainerConfig,
	setMountConfig,
	setNetworkConfig,
	storedPathForCommandInput,
	tildify,
} from "./config.js";
import { getPackageManager } from "./package-manager.js";
import { resolveEnv, resolveSecrets } from "./secrets.js";
import { createVmBashOps, createVmEditOps, createVmReadOps, createVmWriteOps } from "./tools.js";
import { checkQemuAvailable, FortVM } from "./vm.js";

// ---------------------------------------------------------------------------
// /fort add: search, confirm, install, persist
// ---------------------------------------------------------------------------

async function handleAddPackage(
	query: string,
	fortVm: FortVM,
	cwd: string,
	ctx: {
		ui: {
			notify: (message: string, level?: "info" | "warning" | "error") => void;
			confirm: (title: string, message: string) => Promise<boolean>;
			select: (title: string, options: string[]) => Promise<string | undefined>;
		};
	},
): Promise<void> {
	const vm = fortVm.rawVm;
	const packageManager = getPackageManager(fortVm.distro);

	await packageManager.prepareSearch?.(vm);

	const exactResult = await vm.exec(packageManager.exactPackageInfoCommand(query));

	let targetPkg: string | undefined;

	if (exactResult.ok && exactResult.stdout.trim()) {
		const info = exactResult.stdout.trim() || `Package: ${query}`;
		const ok = await ctx.ui.confirm(`🧊 Install ${query}?`, info);
		if (ok) targetPkg = query;
	} else {
		const searchResult = await vm.exec(packageManager.searchPackagesCommand(query));
		const results = searchResult.ok ? packageManager.parseSearchResults(searchResult.stdout).slice(0, 10) : [];

		if (results.length === 0) {
			ctx.ui.notify(`No packages found for "${query}".`, "warning");
			return;
		}

		const options: string[] = [];
		for (const result of results) {
			let desc = result.description;
			if (!desc) {
				const descResult = await vm.exec(packageManager.descriptionCommand(result.name));
				desc = descResult.ok ? packageManager.parseDescription(descResult.stdout) : undefined;
			}
			options.push(desc ? `${result.name} — ${desc.trim()}` : result.name);
		}
		options.push("Cancel");

		const choice = await ctx.ui.select(`🧊 No exact match for "${query}". Select a package:`, options);
		if (!choice || choice === "Cancel") return;

		targetPkg = choice.split(" — ")[0];
	}

	if (!targetPkg) return;

	// Install
	const installResult = await fortVm.installPackage(targetPkg);
	if (!installResult.ok) {
		ctx.ui.notify(`\u274C Failed to install ${targetPkg}: ${installResult.stderr.slice(0, 200)}`, "error");
		return;
	}

	addPackageToConfig(cwd, targetPkg);
	ctx.ui.notify(`✅ Installed ${targetPkg} and added it to .pi/fort.toml`);
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export function parseFortArgs(args: string): string[] {
	const result: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	let inToken = false;

	for (const ch of args.trim()) {
		if (escaped) {
			current += ch;
			escaped = false;
			inToken = true;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			inToken = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			inToken = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			inToken = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (inToken) {
				result.push(current);
				current = "";
				inToken = false;
			}
			continue;
		}
		current += ch;
		inToken = true;
	}
	if (escaped) current += "\\";
	if (quote) throw new Error("Unterminated quote");
	if (inToken) result.push(current);
	return result;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/** Session entry type for recording per-session on/off toggle. */
const SESSION_ENTRY_TYPE = "fort:active";

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// Pre-flight: check QEMU
	// -----------------------------------------------------------------------
	const qemu = checkQemuAvailable();
	if (!qemu.available) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(qemu.message!, "error");
		});
		return;
	}

	// -----------------------------------------------------------------------
	// Load config and secrets
	// -----------------------------------------------------------------------
	const localCwd = process.cwd();
	type RuntimeConfig = {
		merged: FortFileConfig;
		policies: Map<string, ResolvedHostPolicy>;
		hasProjectConfig: boolean;
		dropIns: string[];
		secrets: ResolvedSecret[];
		extraEnv: Record<string, string>;
		allowedHosts: string[] | undefined;
	};

	function buildRuntimeConfig(): RuntimeConfig {
		const loaded = loadConfig(localCwd);
		const secrets = resolveSecrets(loaded.merged.secrets);
		const policyHosts = [...loaded.policies.keys()];
		const secretHosts = secrets.flatMap((s) => s.hosts);
		const allowEgress = loaded.merged.allow_egress ?? false;
		return {
			...loaded,
			secrets,
			extraEnv: resolveEnv(loaded.merged.env),
			allowedHosts: allowEgress ? undefined : [...new Set([...secretHosts, ...policyHosts])],
		};
	}

	let runtime: RuntimeConfig;
	try {
		runtime = buildRuntimeConfig();
	} catch (err) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`pi-fort: failed to load config: ${(err as Error).message}`, "error");
		});
		return;
	}

	function reloadRuntimeConfig(): void {
		runtime = buildRuntimeConfig();
	}

	// -----------------------------------------------------------------------
	// Activation state
	// -----------------------------------------------------------------------
	// enabled from config (undefined = not configured)
	// session override (set by /fort on|off, or from session log on resume)
	let sessionOverride: boolean | undefined;

	function isActive(): boolean {
		if (sessionOverride !== undefined) return sessionOverride;
		return runtime.merged.enabled === true;
	}

	function getSessionActivation(ctx: ExtensionContext): boolean | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === SESSION_ENTRY_TYPE) {
				return entry.data as boolean;
			}
		}
		return undefined;
	}

	// -----------------------------------------------------------------------
	// VM lifecycle
	// -----------------------------------------------------------------------
	let fortVm: FortVM | undefined;
	let vmStarting: Promise<FortVM> | undefined;

	async function shutdownVm() {
		if (fortVm) {
			await fortVm.close();
			fortVm = undefined;
		}
		vmStarting = undefined;
	}

	async function ensureVm(ctx: ExtensionContext): Promise<FortVM | null> {
		if (!isActive()) return null;

		if (fortVm?.isRunning) return fortVm;
		if (vmStarting) return vmStarting;

		vmStarting = (async () => {
			ctx.ui.setStatus("fort", "🧊 Starting VM...");

			const instance = new FortVM({
				workspaceDir: localCwd,
				image: runtime.merged.image,
				distro: runtime.merged.distro ?? "alpine",
				packages: runtime.merged.packages ?? [],
				extraMounts: runtime.merged.mounts ?? [],
				secrets: runtime.secrets,
				gitCredentials: runtime.merged["git-credentials"] ?? [],
				extraEnv: runtime.extraEnv,
				setupScript: runtime.merged.setup,
				allowedHosts: runtime.allowedHosts,
				policies: runtime.policies,
				onPolicyPrompt: async (method, url, hostname) => {
					if (!ctx.hasUI) return false;
					return ctx.ui.confirm(
						"Network request needs approval",
						`${method} ${url}\nHost: ${hostname}\n\nAllow this request?`,
					);
				},
				onStatus: (message) => {
					ctx.ui.setStatus("fort", `🧊 ${message}`);
				},
			});

			await instance.start();
			fortVm = instance;
			ctx.ui.setStatus("fort", "🧊 Fort active");
			setTimeout(() => ctx.ui.setStatus("fort", undefined), 5000);

			return instance;
		})();

		return vmStarting;
	}

	// -----------------------------------------------------------------------
	// Session start: restore override, show hint if not configured
	// -----------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// Restore session override from log (handles resume)
		const prev = getSessionActivation(ctx);
		if (prev !== undefined) {
			sessionOverride = prev;
		}

		if (isActive()) {
			// Start VM eagerly so it's ready when the first tool runs
			ensureVm(ctx);
			// Send hint if not already in this session's history
			if (!isLastHintActive(ctx)) {
				sendFortHint();
			}
		} else if (runtime.merged.enabled === undefined && sessionOverride === undefined) {
			ctx.ui.notify("🧊 pi-fort is installed but not enabled. Run /fort init to set up.");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await shutdownVm();
		ctx.ui.setStatus("fort", undefined);
	});

	// -----------------------------------------------------------------------
	// Register VM-backed tools
	// -----------------------------------------------------------------------
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await ensureVm(ctx);
			if (!vm) return localRead.execute(id, params, signal, onUpdate);
			return createReadTool(localCwd, { operations: createVmReadOps(vm.rawVm) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await ensureVm(ctx);
			if (!vm) return localWrite.execute(id, params, signal, onUpdate);
			return createWriteTool(localCwd, { operations: createVmWriteOps(vm.rawVm) }).execute(
				id,
				params,
				signal,
				onUpdate,
			);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await ensureVm(ctx);
			if (!vm) return localEdit.execute(id, params, signal, onUpdate);
			return createEditTool(localCwd, { operations: createVmEditOps(vm.rawVm) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await ensureVm(ctx);
			if (!vm) return localBash.execute(id, params, signal, onUpdate);
			return createBashTool(localCwd, { operations: createVmBashOps(vm.rawVm) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", (_event, _ctx) => {
		if (!fortVm?.isRunning) return;
		return { operations: createVmBashOps(fortVm.rawVm) };
	});

	// -----------------------------------------------------------------------
	// Fort context messages (added to conversation, not system prompt)
	// -----------------------------------------------------------------------
	function fortHint(): string {
		return `🧊 Fort active. All tools are running inside an isolated ${getPackageManager(runtime.merged.distro ?? "alpine").label} VM. If a command is not found, install it with \`/fort add <package>\`. Package names are distro-native and may differ from binary names.`;
	}

	/** Check if the most recent fort message is an "on" hint (not an "off"). */
	function isLastHintActive(ctx: ExtensionContext): boolean {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom_message" && e.customType === "fort:info") return true;
			if (e.type === "custom_message" && e.customType === "fort:off") return false;
		}
		return false;
	}

	function sendFortHint() {
		pi.sendMessage({ customType: "fort:info", content: fortHint(), display: true }, { deliverAs: "nextTurn" });
	}

	function sendFortOff() {
		pi.sendMessage(
			{ customType: "fort:off", content: "🧊 Fort disabled. Tools are running on the host.", display: true },
			{ deliverAs: "nextTurn" },
		);
	}

	async function afterPersistentConfigChange(ctx: ExtensionContext): Promise<void> {
		reloadRuntimeConfig();
		if (fortVm?.isRunning || vmStarting) {
			await shutdownVm();
			ctx.ui.notify("🧊 Config updated. VM will restart on next tool use.");
		}
	}

	function ensureInitializedForCommand(ctx: ExtensionContext): boolean {
		try {
			requireProjectConfig(localCwd);
			return true;
		} catch (err) {
			ctx.ui.notify((err as Error).message, "warning");
			return false;
		}
	}

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------
	pi.registerCommand("fort", {
		description:
			"Manage fort: /fort [status|init|on|off|restart|add <pkg>|network allow|deny|container <path>|default|mount <host> [guest]|mount-writable <host> [guest]|list-mounts|unmount <guest>]",
		handler: async (args, ctx) => {
			let parts: string[];
			try {
				parts = parseFortArgs(args);
			} catch (err) {
				ctx.ui.notify(`pi-fort: ${(err as Error).message}`, "warning");
				return;
			}
			const subcommand = parts[0] || "status";

			switch (subcommand) {
				case "status": {
					const lines: string[] = [];

					// State
					if (fortVm?.isRunning) {
						lines.push("🧊 Fort active");
					} else if (isActive()) {
						lines.push("🧊 Enabled, VM starts on next tool use");
					} else {
						lines.push("🧊 Not enabled");
					}
					lines.push("");

					// Config sources
					const configLines: string[] = [];
					if (runtime.hasProjectConfig) configLines.push(`  ${tildify(projectConfigPath(localCwd))}`);
					if (runtime.dropIns.length) configLines.push(`  ${tildify(projectDropInDir(localCwd))}/*`);
					if (configLines.length) {
						lines.push("Config:");
						lines.push(...configLines);
					} else {
						lines.push("Config: none");
					}
					lines.push("");

					// What's inside
					lines.push(`Distro:    ${runtime.merged.distro ?? "alpine"}`);
					lines.push(`Packages:  ${(runtime.merged.packages ?? []).join(", ")}`);

					const secretNames = runtime.secrets.map((s) => s.name).join(", ");
					if (secretNames) lines.push(`Secrets:   ${secretNames}`);

					const envNames = Object.keys(runtime.extraEnv).join(", ");
					if (envNames) lines.push(`Env:       ${envNames}`);

					lines.push(`Egress:    ${runtime.merged.allow_egress ? "allow all HTTP hosts" : "configured hosts only"}`);

					const hostNames = [...runtime.policies.keys()].join(", ");
					if (hostNames) lines.push(`Policies:  ${hostNames}`);

					ctx.ui.notify(lines.join("\n"));
					break;
				}

				case "init": {
					const created = initProjectConfig(localCwd);

					const messages: string[] = [];
					for (const path of created) {
						messages.push(`Created ${tildify(path)}`);
					}
					if (created.length === 0) {
						messages.push(".pi/fort.toml and .pi/fort.d already exist");
					} else {
						// Activate for this session too
						sessionOverride = true;
						pi.appendEntry(SESSION_ENTRY_TYPE, true);
					}

					ctx.ui.notify(`🧊 ${messages.join("\n")}`);

					if (created.length > 0) {
						reloadRuntimeConfig();
						ctx.ui.notify("pi-fort initialized. VM will start on next tool use.", "info");
					}
					break;
				}

				case "on": {
					sessionOverride = true;
					pi.appendEntry(SESSION_ENTRY_TYPE, true);
					sendFortHint();
					break;
				}

				case "off": {
					sessionOverride = false;
					pi.appendEntry(SESSION_ENTRY_TYPE, false);
					await shutdownVm();
					ctx.ui.setStatus("fort", undefined);
					sendFortOff();
					break;
				}

				case "restart": {
					await shutdownVm();
					ctx.ui.notify("🧊 pi-fort: VM will restart on next tool use.");
					break;
				}

				case "network": {
					if (!ensureInitializedForCommand(ctx)) return;
					const mode = parts[1];
					if (mode !== "allow" && mode !== "deny") {
						ctx.ui.notify("Usage: /fort network allow|deny", "warning");
						return;
					}
					setNetworkConfig(localCwd, mode === "allow");
					await afterPersistentConfigChange(ctx);
					ctx.ui.notify(`🧊 Network egress ${mode === "allow" ? "allowed" : "restricted to configured hosts"}.`);
					break;
				}

				case "container": {
					if (!ensureInitializedForCommand(ctx)) return;
					const imagePath = parts[1];
					if (!imagePath || parts.length > 2) {
						ctx.ui.notify("Usage: /fort container <container-path>|default", "warning");
						return;
					}
					if (imagePath === "default") {
						resetContainerConfig(localCwd);
						await afterPersistentConfigChange(ctx);
						ctx.ui.notify("🧊 Container reset to default Alpine image.");
					} else {
						setContainerConfig(localCwd, imagePath);
						await afterPersistentConfigChange(ctx);
						ctx.ui.notify(`🧊 Container set to Debian image ${storedPathForCommandInput(localCwd, imagePath)}.`);
					}
					break;
				}

				case "mount":
				case "mount-writable": {
					if (!ensureInitializedForCommand(ctx)) return;
					const hostPath = parts[1];
					const guestPath = parts[2];
					if (!hostPath || parts.length > 3) {
						ctx.ui.notify(`Usage: /fort ${subcommand} <host-path> [<vm-path>]`, "warning");
						return;
					}
					if (guestPath && !guestPath.startsWith("/")) {
						ctx.ui.notify(`VM path must be absolute. Usage: /fort ${subcommand} <host-path> [<vm-path>]`, "warning");
						return;
					}
					setMountConfig(localCwd, hostPath, guestPath, subcommand === "mount");
					await afterPersistentConfigChange(ctx);
					const effectiveHostPath = effectiveHostPathForCommandInput(localCwd, hostPath);
					const effectiveGuestPath = guestPath ?? effectiveHostPath;
					const warning = existsSync(effectiveHostPath)
						? ""
						: "\nWarning: host path does not currently exist, so it will be skipped until created.";
					ctx.ui.notify(
						`🧊 Added ${subcommand === "mount" ? "read-only" : "read-write"} mount ${effectiveGuestPath} ← ${effectiveHostPath}.${warning}`,
					);
					break;
				}

				case "list-mounts": {
					const lines = ["VM mounts:"];
					for (const mount of effectiveMounts(localCwd)) {
						const mode = mount.readonly ? "read-only" : "read-write";
						const source = mount.builtIn ? "built-in" : tildify(mount.source);
						const missing = mount.exists ? "" : "  missing/skipped";
						const fixed = mount.builtIn ? "  not unmountable" : "";
						lines.push(`  ${mount.target} ← ${mount.path}  ${mode}  ${source}${fixed}${missing}`);
					}
					ctx.ui.notify(lines.join("\n"));
					break;
				}

				case "unmount": {
					if (!ensureInitializedForCommand(ctx)) return;
					const guestPath = parts[1];
					if (!guestPath || parts.length > 2) {
						ctx.ui.notify("Usage: /fort unmount <guest-path>", "warning");
						return;
					}
					if (!guestPath.startsWith("/")) {
						ctx.ui.notify("Guest path must be absolute. Usage: /fort unmount <guest-path>", "warning");
						return;
					}
					if (guestPath === localCwd) {
						ctx.ui.notify("Cannot unmount the default workspace mount.", "warning");
						return;
					}
					const removed = removeMountConfig(localCwd, guestPath);
					if (!removed) {
						ctx.ui.notify(`No .pi/fort.toml mount found for guest path ${guestPath}.`, "warning");
						return;
					}
					await afterPersistentConfigChange(ctx);
					ctx.ui.notify(`🧊 Unmounted ${guestPath}.`);
					break;
				}

				case "add": {
					const query = parts.slice(1).join(" ");
					if (!query) {
						ctx.ui.notify("Usage: /fort add <package-name>", "warning");
						return;
					}

					// Enable for this session if not already
					if (!isActive()) {
						sessionOverride = true;
						pi.appendEntry(SESSION_ENTRY_TYPE, true);
					}

					const vmForAdd = await ensureVm(ctx);
					if (!vmForAdd) {
						ctx.ui.notify("Failed to start VM.", "error");
						return;
					}
					await handleAddPackage(query, vmForAdd, localCwd, ctx);
					reloadRuntimeConfig();
					break;
				}

				default:
					ctx.ui.notify(
						"Usage: /fort [status|init|on|off|restart|add <pkg>|network allow|deny|container <path>|default|mount <host> [guest]|mount-writable <host> [guest]|list-mounts|unmount <guest>]",
						"warning",
					);
			}
		},
	});

	// -----------------------------------------------------------------------
	// Shutdown
	// -----------------------------------------------------------------------
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!fortVm) return;
		ctx.ui.setStatus("fort", "🧊 Stopping fort...");
		await shutdownVm();
	});
}
