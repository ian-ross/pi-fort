/**
 * Configuration schema and resolution for pi-fort.
 *
 * Config is TOML, loaded from `.pi/fort.toml` and `.pi/fort.d/*.toml` in the current project.
 * The agent never influences config resolution.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseTOML } from "smol-toml";
import * as v from "valibot";
import { Distros } from "./package-manager.js";

// ---------------------------------------------------------------------------
// Template directory resolution
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve a path within the templates/ directory. Works from both src/ and dist/. */
function templatePath(...segments: string[]): string {
	// From dist/: ../templates/  From src/: ../templates/
	return join(__dirname, "..", "templates", ...segments);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Secret definition: how to obtain a credential and which hosts receive it. */
const SecretDef = v.union([
	// Disable a secret inherited from a parent config
	v.literal(false),
	// Command source: run a host command, use stdout as value
	v.object({
		command: v.string(),
		hosts: v.array(v.string()),
	}),
	// Env source: read from a host environment variable
	v.object({
		env: v.string(),
		hosts: v.array(v.string()),
	}),
]);
export type SecretDef = v.InferOutput<typeof SecretDef>;

/** Environment variable definition: static value, host command, or host env var. */
const EnvDef = v.union([
	// Static value
	v.string(),
	// From a host command
	v.object({ command: v.string() }),
	// From a host environment variable
	v.object({ env: v.string() }),
]);
export type EnvDef = v.InferOutput<typeof EnvDef>;

const UnmatchedPolicy = v.picklist(["prompt", "deny", "allow"]);
export type UnmatchedPolicy = v.InferOutput<typeof UnmatchedPolicy>;

/** GraphQL endpoint policy. */
const GraphQLPolicy = v.object({
	endpoint: v.string(),
	allow: v.object({
		query: v.optional(v.array(v.string()), []),
		mutation: v.optional(v.array(v.string()), []),
	}),
	unmatched: v.optional(UnmatchedPolicy),
});
export type GraphQLPolicy = v.InferOutput<typeof GraphQLPolicy>;

/** Per-host allow rules: METHOD -> path patterns. */
const HostAllow = v.record(v.string(), v.array(v.string()));

/** Per-host policy. Key = quoted hostname in TOML. */
const HostDef = v.object({
	/** Which secret to inject for requests to this host (references a key in [secrets]) */
	secret: v.optional(v.string()),
	/** Allowed HTTP method + path patterns */
	allow: v.optional(HostAllow, {}),
	/** Paths that are always denied (overrides allow) */
	deny: v.optional(v.array(v.string()), []),
	/** What happens for requests that don't match allow or deny */
	unmatched: v.optional(UnmatchedPolicy, "allow"),
	/** GraphQL-specific policy for a specific endpoint */
	graphql: v.optional(GraphQLPolicy),
});
export type HostDef = v.InferOutput<typeof HostDef>;

const AbsoluteGuestPath = v.pipe(
	v.string(),
	v.check((path) => path.startsWith("/"), "mount target must be an absolute guest path"),
);

/** Additional directory to mount in the VM. Bare string = read-write mount at the same path. */
const MountDef = v.pipe(
	v.union([
		v.string(),
		v.object({
			path: v.string(),
			target: v.optional(AbsoluteGuestPath),
			readonly: v.optional(v.boolean(), false),
		}),
	]),
	v.transform((input) => (typeof input === "string" ? { path: input, readonly: false } : input)),
);

/** Git credential helper configuration. */
const GitCredentialDef = v.object({
	host: v.string(),
	username: v.string(),
	secret: v.string(),
});
export type GitCredentialDef = v.InferOutput<typeof GitCredentialDef>;

/** Top-level fort config file schema. */
export const FortFileConfig = v.object({
	enabled: v.optional(v.boolean()),
	allow_egress: v.optional(v.boolean()),
	image: v.optional(v.string()),
	distro: v.optional(v.picklist(Distros)),
	packages: v.optional(v.array(v.string())),
	mounts: v.optional(v.array(MountDef), []),
	env: v.optional(v.record(v.string(), EnvDef), {}),
	secrets: v.optional(v.record(v.string(), SecretDef), {}),
	"git-credentials": v.optional(v.array(GitCredentialDef), []),
	hosts: v.optional(v.record(v.string(), HostDef), {}),
	setup: v.optional(v.string()),
});
export type FortFileConfig = v.InferOutput<typeof FortFileConfig>;

// ---------------------------------------------------------------------------
// Resolved config (after merging all layers)
// ---------------------------------------------------------------------------

export interface ResolvedSecret {
	name: string;
	value: string;
	hosts: string[];
}

export interface ResolvedGraphQLPolicy {
	endpoint: string;
	allow: { query: string[]; mutation: string[] };
	unmatched: UnmatchedPolicy;
}

export interface ResolvedHostPolicy {
	hostname: string;
	allows: Map<string, string[]>; // METHOD -> path patterns
	deny: string[];
	unmatched: UnmatchedPolicy;
	graphql?: ResolvedGraphQLPolicy;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function normalizeLegacyMisplacedTopLevel(parsed: unknown): unknown {
	// Older command writers appended absent top-level settings after [env], which
	// TOML interprets as env.mounts/env.image/etc. Move those known fort keys back
	// before schema validation so affected configs remain recoverable.
	if (!parsed || typeof parsed !== "object") return parsed;
	const obj = parsed as Record<string, unknown>;
	const env = obj.env;
	if (!env || typeof env !== "object" || Array.isArray(env)) return parsed;
	const envObj = env as Record<string, unknown>;
	for (const key of ["allow_egress", "image", "distro", "packages", "mounts"] as const) {
		if (obj[key] === undefined && envObj[key] !== undefined) {
			obj[key] = envObj[key];
			delete envObj[key];
		}
	}
	return parsed;
}

function readTomlFile(path: string): FortFileConfig | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`pi-fort: failed to read config at ${path}: ${(err as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = normalizeLegacyMisplacedTopLevel(parseTOML(raw));
	} catch (err) {
		throw new Error(`pi-fort: invalid TOML at ${path}: ${(err as Error).message}`);
	}

	try {
		return v.parse(FortFileConfig, parsed);
	} catch (err) {
		throw new Error(`pi-fort: invalid config at ${path}: ${(err as Error).message}`);
	}
}

/**
 * Collect config files from the current project only.
 *
 * Merge order:
 * 1. `.pi/fort.d/*.toml` in alphabetical order
 * 2. `.pi/fort.toml`
 *
 * Drop-ins provide integration defaults; the project config is authoritative.
 */
export interface ConfigLayer {
	path: string;
	config: FortFileConfig;
}

export function collectConfigFiles(cwd: string): ConfigLayer[] {
	const layers: ConfigLayer[] = [];
	const projectDir = resolve(cwd);

	const mainPath = projectConfigPath(projectDir);

	const dropInDir = projectDropInDir(projectDir);
	if (existsSync(dropInDir)) {
		const files = readdirSync(dropInDir)
			.filter((f) => f.endsWith(".toml"))
			.sort();
		for (const file of files) {
			const filePath = join(dropInDir, file);
			const config = readTomlFile(filePath);
			if (config) {
				layers.push({ path: filePath, config });
			}
		}
	}

	const mainConfig = readTomlFile(mainPath);
	if (mainConfig) {
		layers.push({ path: mainPath, config: mainConfig });
	}

	return layers;
}

function isPathLikeImage(image: string): boolean {
	return (
		image === "~" ||
		image.startsWith("~/") ||
		image.startsWith("./") ||
		image.startsWith("../") ||
		image.startsWith("/")
	);
}

function resolveConfigPath(path: string, configPath: string | undefined): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	if (path.startsWith("/")) return path;
	if (!configPath) return path;
	return resolve(dirname(configPath), path);
}

function resolveImagePath(image: string, configPath: string | undefined): string {
	if (!isPathLikeImage(image)) return image;

	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (image === "~") return home;
	if (image.startsWith("~/")) return join(home, image.slice(2));
	if (image.startsWith("/")) return image;
	if (!configPath) return image;
	return resolve(dirname(configPath), image);
}

/**
 * Merge config layers. Later layers override earlier ones.
 * Secrets and hosts are merged by key (later wins).
 * Packages accumulate across layers and are deduplicated.
 */
export function mergeConfigs(layers: FortFileConfig[] | ConfigLayer[]): FortFileConfig {
	const merged: FortFileConfig = {
		enabled: undefined,
		allow_egress: false,
		image: undefined,
		distro: "debian",
		packages: [],
		mounts: [],
		env: {},
		secrets: {},
		"git-credentials": [],
		hosts: {},
	};

	// Track mounts and git-credentials by key to deduplicate (later layer wins)
	const mountsByTarget = new Map<string, { path: string; target?: string; readonly: boolean }>();
	const gitCredsByHost = new Map<string, GitCredentialDef>();
	// Collect setup scripts in order (each file's script runs sequentially)
	const setupScripts: string[] = [];

	for (const inputLayer of layers) {
		const layer = "config" in inputLayer ? inputLayer.config : inputLayer;
		const layerPath = "config" in inputLayer ? inputLayer.path : undefined;

		if (layer.enabled !== undefined) {
			merged.enabled = layer.enabled;
		}
		if (layer.allow_egress !== undefined) {
			merged.allow_egress = layer.allow_egress;
		}
		if (layer.image !== undefined) {
			merged.image = resolveImagePath(layer.image, layerPath);
		}
		if (layer.distro !== undefined) {
			merged.distro = layer.distro;
		}
		if (layer.packages) {
			for (const pkg of layer.packages) {
				if (!merged.packages!.includes(pkg)) {
					merged.packages!.push(pkg);
				}
			}
		}
		if (layer.mounts) {
			for (const mount of layer.mounts) {
				const resolvedMount = { ...mount, path: resolveConfigPath(mount.path, layerPath) };
				mountsByTarget.set(resolvedMount.target ?? resolvedMount.path, resolvedMount);
			}
		}
		if (layer.env) {
			for (const [key, val] of Object.entries(layer.env)) {
				merged.env![key] = val;
			}
		}
		if (layer.secrets) {
			for (const [key, val] of Object.entries(layer.secrets)) {
				merged.secrets![key] = val;
			}
		}
		if (layer["git-credentials"]) {
			for (const cred of layer["git-credentials"]) {
				gitCredsByHost.set(cred.host, cred);
			}
		}
		if (layer.hosts) {
			for (const [key, val] of Object.entries(layer.hosts)) {
				merged.hosts![key] = val;
			}
		}
		if (layer.setup) {
			setupScripts.push(layer.setup);
		}
	}

	merged.mounts = [...mountsByTarget.values()];
	merged["git-credentials"] = [...gitCredsByHost.values()];
	// Concatenate all setup scripts (each separated by newline)
	if (setupScripts.length > 0) {
		merged.setup = setupScripts.join("\n");
	}

	return merged;
}

/**
 * Parse a merged config into resolved host policies.
 * Only hosts with actual policy rules (allow, deny, unmatched != default, or graphql)
 * are included.
 */
export function resolveHostPolicies(config: FortFileConfig): Map<string, ResolvedHostPolicy> {
	const result = new Map<string, ResolvedHostPolicy>();

	for (const [hostname, hostDef] of Object.entries(config.hosts ?? {})) {
		const allows = new Map<string, string[]>();
		for (const [method, patterns] of Object.entries(hostDef.allow ?? {})) {
			allows.set(method.toUpperCase(), patterns);
		}

		const hostUnmatched = hostDef.unmatched ?? "allow";

		let graphql: ResolvedGraphQLPolicy | undefined;
		if (hostDef.graphql) {
			graphql = {
				endpoint: hostDef.graphql.endpoint,
				allow: {
					query: hostDef.graphql.allow.query ?? [],
					mutation: hostDef.graphql.allow.mutation ?? [],
				},
				// GraphQL inherits host unmatched if not set
				unmatched: hostDef.graphql.unmatched ?? hostUnmatched,
			};
		}

		result.set(hostname, {
			hostname,
			allows,
			deny: hostDef.deny ?? [],
			unmatched: hostUnmatched,
			graphql,
		});
	}

	return result;
}

/**
 * Load the fully resolved config for a given cwd.
 * Does NOT resolve secrets (that requires running commands).
 */
export function loadConfig(cwd: string): {
	merged: FortFileConfig;
	policies: Map<string, ResolvedHostPolicy>;
	hasProjectConfig: boolean;
	hasExplicitDistro: boolean;
	dropIns: string[];
} {
	const projectDir = resolve(cwd);
	const layers = collectConfigFiles(projectDir);
	const merged = mergeConfigs(layers);
	const policies = resolveHostPolicies(merged);
	const hasExplicitDistro = layers.some((l) => l.config.distro !== undefined);

	const projectPath = projectConfigPath(projectDir);
	const hasProjectConfig = layers.some((l) => l.path === projectPath);

	// Collect project drop-in file names (without extension, for display)
	const dropInPrefix = `${projectDropInDir(projectDir)}/`;
	const dropIns = layers.filter((l) => l.path.startsWith(dropInPrefix)).map((l) => basename(l.path, ".toml"));

	return { merged, policies, hasProjectConfig, hasExplicitDistro, dropIns };
}

// ---------------------------------------------------------------------------
// Config paths and modification
// ---------------------------------------------------------------------------

export function projectConfigPath(cwd: string): string {
	return join(resolve(cwd), ".pi", "fort.toml");
}

export function projectDropInDir(cwd: string): string {
	return join(resolve(cwd), ".pi", "fort.d");
}

/** Replace the home directory prefix with ~ for display. */
export function tildify(p: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home) return p;
	if (p === home) return "~";
	if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
	return p;
}

// ---------------------------------------------------------------------------
// Config file creation (copies from templates/)
// ---------------------------------------------------------------------------

/**
 * Create the project config and drop-in directory if they don't exist.
 * Copies from templates/. Returns list of created files for display.
 */
export function initProjectConfig(cwd: string): string[] {
	const created: string[] = [];

	const configPath = projectConfigPath(cwd);
	if (!existsSync(configPath)) {
		mkdirSync(dirname(configPath), { recursive: true });
		cpSync(templatePath("fort.toml"), configPath);
		created.push(configPath);
	}

	const dropInDir = projectDropInDir(cwd);
	mkdirSync(dropInDir, { recursive: true });

	const templateDropInDir = templatePath("fort.d");
	for (const file of readdirSync(templateDropInDir).filter((f) => f.endsWith(".toml"))) {
		const dest = join(dropInDir, file);
		if (!existsSync(dest)) {
			cpSync(join(templateDropInDir, file), dest);
			created.push(dest);
		}
	}

	return created;
}

/**
 * Persist a package in config so future fort starts install it automatically.
 * Creates the config file if needed.
 */
export function addPackageToConfig(cwd: string, pkg: string): void {
	const configPath = projectConfigPath(cwd);

	let existing: Partial<FortFileConfig> = {};
	try {
		const content = readFileSync(configPath, "utf-8");
		const parsed = parseTOML(content);
		const result = v.safeParse(FortFileConfig, parsed);
		if (result.success) existing = result.output;
	} catch {
		// File doesn't exist or is invalid, start fresh
	}

	const packages = existing.packages ?? [];
	if (!packages.includes(pkg)) {
		packages.push(pkg);
	}

	const dir = dirname(configPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const packagesLine = `packages = [${packages.map((p) => `"${p}"`).join(", ")}]`;

	if (existsSync(configPath)) {
		const raw = readFileSync(configPath, "utf-8");
		if (raw.match(/^packages\s*=/m)) {
			writeFileSync(configPath, raw.replace(/^packages\s*=.*$/m, packagesLine), "utf-8");
		} else {
			writeFileSync(configPath, `${packagesLine}\n${raw}`, "utf-8");
		}
	} else {
		writeFileSync(configPath, `${packagesLine}\n`, "utf-8");
	}
}

export type WritableMountDef = { path: string; target?: string; readonly: boolean };

export interface EffectiveMount {
	path: string;
	target: string;
	readonly: boolean;
	source: "built-in" | string;
	exists: boolean;
	builtIn: boolean;
}

export function requireProjectConfig(cwd: string): string {
	const configPath = projectConfigPath(cwd);
	if (!existsSync(configPath)) {
		throw new Error("pi-fort needs to be initialized first. Run /fort init.");
	}
	return configPath;
}

function readProjectConfigForEdit(cwd: string): { configPath: string; raw: string; config: FortFileConfig } {
	const configPath = requireProjectConfig(cwd);
	const raw = readFileSync(configPath, "utf-8");
	const parsed = normalizeLegacyMisplacedTopLevel(parseTOML(raw));
	const config = v.parse(FortFileConfig, parsed);
	return { configPath, raw, config };
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function topLevelScalarLine(key: string, value: string): string {
	return `${key} = ${value}`;
}

function insertTopLevelBlock(raw: string, block: string): string {
	const lines = raw.split(/(?<=\n)/);
	const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
	if (firstTable < 0) return raw.endsWith("\n") ? `${raw}${block}` : `${raw}\n${block}`;
	lines.splice(firstTable, 0, block);
	return lines.join("");
}

function removeKeyAssignments(raw: string, key: string): string {
	const lines = raw.split(/(?<=\n)/);
	for (let i = 0; i < lines.length; i++) {
		if (!new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) continue;
		let end = i;
		let balance = bracketBalance(lines[i]);
		while (balance > 0 && end + 1 < lines.length) {
			end++;
			balance += bracketBalance(lines[end]);
		}
		lines.splice(i, end - i + 1);
		i--;
	}
	return lines.join("");
}

function upsertTopLevelScalar(raw: string, key: string, value: string): string {
	const line = topLevelScalarLine(key, value);
	const lines = raw.split(/(?<=\n)/);
	const firstTable = lines.findIndex((entry) => /^\s*\[/.test(entry));
	const topLevelEnd = firstTable < 0 ? lines.length : firstTable;
	const re = new RegExp(`^\\s*#?\\s*${key}\\s*=.*$`);
	for (let i = 0; i < topLevelEnd; i++) {
		if (re.test(lines[i])) {
			lines[i] = `${line}${lines[i].endsWith("\n") ? "\n" : ""}`;
			return lines.join("");
		}
	}
	return insertTopLevelBlock(removeKeyAssignments(raw, key), `${line}\n`);
}

function removeTopLevelScalar(raw: string, key: string): string {
	return raw.replace(new RegExp(`^\\s*${key}\\s*=.*(?:\\n|$)`, "m"), "");
}

function bracketBalance(line: string): number {
	let balance = 0;
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const ch of line) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote === '"' && ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "[") balance++;
		else if (ch === "]") balance--;
	}
	return balance;
}

function replaceMountsBlock(raw: string, mounts: WritableMountDef[]): string {
	let lines = raw.split(/(?<=\n)/);
	let start = -1;
	let end = -1;
	const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
	const topLevelEnd = firstTable < 0 ? lines.length : firstTable;
	for (let i = 0; i < topLevelEnd; i++) {
		if (!/^\s*mounts\s*=/.test(lines[i])) continue;
		start = i;
		let balance = bracketBalance(lines[i]);
		end = i;
		while (balance > 0 && end + 1 < topLevelEnd) {
			end++;
			balance += bracketBalance(lines[end]);
		}
		break;
	}

	const block = formatMountsBlock(mounts);
	if (start >= 0) {
		lines.splice(start, end - start + 1, block);
		return lines.join("");
	}

	// Convert older [[mounts]] array-of-table syntax to the command-managed
	// inline object array. This avoids writing a duplicate TOML key.
	lines = lines.filter((line, index) => {
		if (!/^\s*\[\[mounts\]\]\s*$/.test(line)) return true;
		let next = index + 1;
		while (next < lines.length && !/^\s*\[/.test(lines[next])) next++;
		for (let i = index; i < next; i++) lines[i] = "";
		return false;
	});
	const withoutMountTables = removeKeyAssignments(lines.join(""), "mounts");
	return insertTopLevelBlock(withoutMountTables, block);
}

function formatMountsBlock(mounts: WritableMountDef[]): string {
	if (mounts.length === 0) return "mounts = []\n";
	const lines = ["mounts = ["];
	for (const mount of mounts) {
		const parts = [`path = ${tomlString(mount.path)}`];
		if (mount.target) parts.push(`target = ${tomlString(mount.target)}`);
		parts.push(`readonly = ${mount.readonly ? "true" : "false"}`);
		lines.push(`\t{ ${parts.join(", ")} },`);
	}
	lines.push("]");
	return `${lines.join("\n")}\n`;
}

export function storedPathForCommandInput(cwd: string, input: string): string {
	if (input === "~" || input.startsWith("~/") || isAbsolute(input)) return input;
	const absolute = resolve(cwd, input);
	return relative(dirname(projectConfigPath(cwd)), absolute) || ".";
}

export function effectiveHostPathFromStored(cwd: string, storedPath: string): string {
	return resolveConfigPath(storedPath, projectConfigPath(cwd));
}

export function effectiveHostPathForCommandInput(cwd: string, input: string): string {
	if (input === "~" || input.startsWith("~/")) return resolveConfigPath(input, projectConfigPath(cwd));
	return isAbsolute(input) ? input : resolve(cwd, input);
}

export function setNetworkConfig(cwd: string, allow: boolean): void {
	const { configPath, raw } = readProjectConfigForEdit(cwd);
	writeFileSync(configPath, upsertTopLevelScalar(raw, "allow_egress", allow ? "true" : "false"), "utf-8");
}

export function setContainerConfig(cwd: string, imagePath: string): void {
	const { configPath, raw } = readProjectConfigForEdit(cwd);
	const stored = storedPathForCommandInput(cwd, imagePath);
	let next = upsertTopLevelScalar(raw, "distro", tomlString("debian"));
	next = upsertTopLevelScalar(next, "image", tomlString(stored));
	writeFileSync(configPath, next, "utf-8");
}

export function resetContainerConfig(cwd: string): void {
	const { configPath, raw } = readProjectConfigForEdit(cwd);
	let next = removeTopLevelScalar(raw, "distro");
	next = removeTopLevelScalar(next, "image");
	writeFileSync(configPath, next, "utf-8");
}

export function setMountConfig(
	cwd: string,
	hostPathInput: string,
	guestPath: string | undefined,
	readonly: boolean,
): void {
	const { configPath, raw, config } = readProjectConfigForEdit(cwd);
	const storedHostPath = storedPathForCommandInput(cwd, hostPathInput);
	const target = guestPath ?? effectiveHostPathForCommandInput(cwd, hostPathInput);
	const currentMounts = (config.mounts ?? []) as WritableMountDef[];
	const nextMounts = currentMounts.filter((m) => (m.target ?? effectiveHostPathFromStored(cwd, m.path)) !== target);
	const mount: WritableMountDef = { path: storedHostPath, readonly };
	if (target !== effectiveHostPathForCommandInput(cwd, hostPathInput)) mount.target = target;
	nextMounts.push(mount);
	writeFileSync(configPath, replaceMountsBlock(raw, nextMounts), "utf-8");
}

export function removeMountConfig(cwd: string, guestPath: string): boolean {
	const { configPath, raw, config } = readProjectConfigForEdit(cwd);
	const currentMounts = (config.mounts ?? []) as WritableMountDef[];
	const nextMounts = currentMounts.filter((m) => (m.target ?? effectiveHostPathFromStored(cwd, m.path)) !== guestPath);
	if (nextMounts.length === currentMounts.length) return false;
	writeFileSync(configPath, replaceMountsBlock(raw, nextMounts), "utf-8");
	return true;
}

export function effectiveMounts(cwd: string): EffectiveMount[] {
	const projectDir = resolve(cwd);
	const mountsByTarget = new Map<string, EffectiveMount>();
	const layers = collectConfigFiles(projectDir);
	for (const layer of layers) {
		for (const mount of layer.config.mounts ?? []) {
			const path = resolveConfigPath(mount.path, layer.path);
			const target = mount.target ?? path;
			mountsByTarget.set(target, {
				path,
				target,
				readonly: mount.readonly,
				source: layer.path,
				exists: existsSync(path),
				builtIn: false,
			});
		}
	}
	return [
		{
			path: projectDir,
			target: projectDir,
			readonly: false,
			source: "built-in",
			exists: existsSync(projectDir),
			builtIn: true,
		},
		...mountsByTarget.values(),
	];
}
