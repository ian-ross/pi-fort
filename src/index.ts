/**
 * pi-fort
 *
 * VM-isolated fort for pi with automatic secret protection.
 * All pi tools (bash, read, write, edit) execute inside a Gondolin micro-VM.
 * Secrets never enter the VM; the HTTP proxy injects them on the wire.
 *
 * See README.md for architecture and configuration details.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import type { ResolvedSecret } from "./config.js";
import {
	addPackageToConfig,
	initProjectConfig,
	loadConfig,
	projectConfigPath,
	projectDropInDir,
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
	const { merged, policies, hasProjectConfig, dropIns } = loadConfig(localCwd);
	const image = merged.image;
	const distro = merged.distro ?? "alpine";
	const packages = merged.packages ?? [];
	const extraMounts = merged.mounts ?? [];
	const gitCredentials = merged["git-credentials"] ?? [];
	// Network allowlist is derived from secret hosts (Gondolin builds the allowlist)
	const allowedHosts: string[] | undefined = undefined;

	// Resolve env vars from config (non-secret, injected as real VM env vars)
	const extraEnv = resolveEnv(merged.env);
	const setupScript = merged.setup;

	let secrets: ResolvedSecret[];
	try {
		secrets = resolveSecrets(merged.secrets);
	} catch (err) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`pi-fort: failed to resolve secrets: ${(err as Error).message}`, "error");
		});
		return;
	}

	// -----------------------------------------------------------------------
	// Activation state
	// -----------------------------------------------------------------------
	// enabled from config (undefined = not configured)
	const configEnabled = merged.enabled;
	// session override (set by /fort on|off, or from session log on resume)
	let sessionOverride: boolean | undefined;

	function isActive(): boolean {
		if (sessionOverride !== undefined) return sessionOverride;
		return configEnabled === true;
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
				image,
				distro,
				packages,
				extraMounts,
				secrets,
				gitCredentials,
				extraEnv,
				setupScript,
				allowedHosts,
				policies,
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
		} else if (configEnabled === undefined && sessionOverride === undefined) {
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
	const FORT_HINT = `🧊 Fort active. All tools are running inside an isolated ${getPackageManager(distro).label} VM. If a command is not found, install it with \`/fort add <package>\`. Package names are distro-native and may differ from binary names.`;

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
		pi.sendMessage({ customType: "fort:info", content: FORT_HINT, display: true }, { deliverAs: "nextTurn" });
	}

	function sendFortOff() {
		pi.sendMessage(
			{ customType: "fort:off", content: "🧊 Fort disabled. Tools are running on the host.", display: true },
			{ deliverAs: "nextTurn" },
		);
	}

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------
	pi.registerCommand("fort", {
		description: "Manage fort: /fort [status|init|on|off|restart|add <pkg>]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
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
					if (hasProjectConfig) configLines.push(`  ${tildify(projectConfigPath(localCwd))}`);
					if (dropIns.length) configLines.push(`  ${tildify(projectDropInDir(localCwd))}/*`);
					if (configLines.length) {
						lines.push("Config:");
						lines.push(...configLines);
					} else {
						lines.push("Config: none");
					}
					lines.push("");

					// What's inside
					lines.push(`Distro:    ${distro}`);
					lines.push(`Packages:  ${packages.join(", ")}`);

					const secretNames = secrets.map((s) => s.name).join(", ");
					if (secretNames) lines.push(`Secrets:   ${secretNames}`);

					const envNames = Object.keys(extraEnv).join(", ");
					if (envNames) lines.push(`Env:       ${envNames}`);

					const hostNames = [...policies.keys()].join(", ");
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
						ctx.ui.notify("Reload with /reload to apply the new config.", "info");
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
					break;
				}

				default:
					ctx.ui.notify("Usage: /fort [status|init|on|off|restart|add <pkg>]", "warning");
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
