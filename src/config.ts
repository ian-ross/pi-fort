/**
 * Configuration schema and resolution for pi-fort.
 *
 * Config is TOML, loaded from `.pi/fort.toml` and `.pi/fort.d/*.toml` in the current project.
 * The agent never influences config resolution.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

/** Additional directory to mount in the VM. Bare string = read-write mount. */
const MountDef = v.pipe(
	v.union([
		v.string(),
		v.object({
			path: v.string(),
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
		parsed = parseTOML(raw);
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
 * 1. `.pi/fort.toml`
 * 2. `.pi/fort.d/*.toml` in alphabetical order
 */
export function collectConfigFiles(cwd: string): { path: string; config: FortFileConfig }[] {
	const layers: { path: string; config: FortFileConfig }[] = [];
	const projectDir = resolve(cwd);

	const mainPath = projectConfigPath(projectDir);
	const mainConfig = readTomlFile(mainPath);
	if (mainConfig) {
		layers.push({ path: mainPath, config: mainConfig });
	}

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

	return layers;
}

/**
 * Merge config layers. Later layers override earlier ones.
 * Secrets and hosts are merged by key (later wins).
 * Packages accumulate across layers and are deduplicated.
 */
export function mergeConfigs(layers: FortFileConfig[]): FortFileConfig {
	const merged: FortFileConfig = {
		enabled: undefined,
		image: undefined,
		distro: "alpine",
		packages: [],
		mounts: [],
		env: {},
		secrets: {},
		"git-credentials": [],
		hosts: {},
	};

	// Track mounts and git-credentials by key to deduplicate (later layer wins)
	const mountsByPath = new Map<string, { path: string; readonly: boolean }>();
	const gitCredsByHost = new Map<string, GitCredentialDef>();
	// Collect setup scripts in order (each file's script runs sequentially)
	const setupScripts: string[] = [];

	for (const layer of layers) {
		if (layer.enabled !== undefined) {
			merged.enabled = layer.enabled;
		}
		if (layer.image !== undefined) {
			merged.image = layer.image;
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
				mountsByPath.set(mount.path, mount);
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

	merged.mounts = [...mountsByPath.values()];
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
	dropIns: string[];
} {
	const projectDir = resolve(cwd);
	const layers = collectConfigFiles(projectDir);
	const merged = mergeConfigs(layers.map((l) => l.config));
	const policies = resolveHostPolicies(merged);

	const projectPath = projectConfigPath(projectDir);
	const hasProjectConfig = layers.some((l) => l.path === projectPath);

	// Collect project drop-in file names (without extension, for display)
	const dropInPrefix = `${projectDropInDir(projectDir)}/`;
	const dropIns = layers.filter((l) => l.path.startsWith(dropInPrefix)).map((l) => basename(l.path, ".toml"));

	// Resolve mount paths: expand ~, resolve relative paths against cwd
	if (merged.mounts) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		merged.mounts = merged.mounts.map((m) => {
			let p = m.path;
			if (p === "~") p = home;
			else if (p.startsWith("~/")) p = join(home, p.slice(2));
			else if (!p.startsWith("/")) p = join(projectDir, p);
			return { ...m, path: p };
		});
	}

	return { merged, policies, hasProjectConfig, dropIns };
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
