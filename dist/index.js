// src/index.ts
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

// src/config.ts
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parse as parseTOML } from "smol-toml";
import * as v from "valibot";

// src/package-manager.ts
var Distros = ["alpine", "debian"];
function getPackageManager(distro) {
  switch (distro) {
    case "alpine":
      return alpinePackageManager;
    case "debian":
      return debianPackageManager;
  }
}
function shellEscape(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function extractAlpinePkgName(versionedName) {
  const match = versionedName.match(/^(.+?)-\d/);
  return match ? match[1] : versionedName;
}
function isAuxiliaryPackage(name) {
  return /-(?:doc|dev|lang|dbg|bash-completion|zsh-completion|fish-completion|pyc)$/.test(name);
}
var alpinePackageManager = {
  distro: "alpine",
  label: "Alpine Linux",
  packageHosts: ["dl-cdn.alpinelinux.org"],
  installPackagesCommand: (packages) => `apk add --no-progress ${packages.map(shellEscape).join(" ")}`,
  installPackageCommand: (pkg) => `apk add --no-progress ${shellEscape(pkg)}`,
  prepareSearch: async (vm) => {
    const result = await vm.exec("apk update --quiet");
    if (!result.ok) return;
  },
  exactPackageInfoCommand: (query) => `apk search --exact ${shellEscape(query)}`,
  searchPackagesCommand: (query) => `apk search ${shellEscape(query)}`,
  descriptionCommand: (pkg) => `apk info --description ${shellEscape(pkg)}`,
  parseSearchResults: (stdout) => {
    const names = stdout.trim().split("\n").map((line) => extractAlpinePkgName(line.trim())).filter(Boolean).filter((name) => !isAuxiliaryPackage(name));
    return [...new Set(names)].map((name) => ({ name }));
  },
  parseDescription: (stdout) => stdout.trim().split("\n").find((line) => !line.includes("description:") && line.trim())?.trim()
};
var debianPackageManager = {
  distro: "debian",
  label: "Debian Linux",
  packageHosts: ["deb.debian.org", "security.debian.org", "ftp.debian.org"],
  installPackagesCommand: (packages) => [
    "apt-get update",
    `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.map(shellEscape).join(" ")}`
  ].join(" && "),
  installPackageCommand: (pkg) => [
    "apt-get update",
    `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${shellEscape(pkg)}`
  ].join(" && "),
  prepareSearch: async (vm) => {
    await vm.exec("apt-get update");
  },
  exactPackageInfoCommand: (query) => `apt-cache show ${shellEscape(query)}`,
  searchPackagesCommand: (query) => `apt-cache search ${shellEscape(query)}`,
  descriptionCommand: (pkg) => `apt-cache show ${shellEscape(pkg)}`,
  parseSearchResults: (stdout) => {
    const results = [];
    const seen = /* @__PURE__ */ new Set();
    for (const line of stdout.trim().split("\n")) {
      const match = line.match(/^([^\s]+)\s+-\s+(.*)$/);
      if (!match) continue;
      const [, name, description] = match;
      if (!name || seen.has(name) || isAuxiliaryPackage(name)) continue;
      seen.add(name);
      results.push({ name, description: description?.trim() });
    }
    return results;
  },
  parseDescription: (stdout) => {
    for (const line of stdout.split("\n")) {
      if (line.startsWith("Description: ")) return line.slice("Description: ".length).trim();
    }
    return void 0;
  }
};

// src/config.ts
var __dirname = dirname(fileURLToPath(import.meta.url));
function templatePath(...segments) {
  return join(__dirname, "..", "templates", ...segments);
}
var SecretDef = v.union([
  // Disable a secret inherited from a parent config
  v.literal(false),
  // Command source: run a host command, use stdout as value
  v.object({
    command: v.string(),
    hosts: v.array(v.string())
  }),
  // Env source: read from a host environment variable
  v.object({
    env: v.string(),
    hosts: v.array(v.string())
  })
]);
var EnvDef = v.union([
  // Static value
  v.string(),
  // From a host command
  v.object({ command: v.string() }),
  // From a host environment variable
  v.object({ env: v.string() })
]);
var UnmatchedPolicy = v.picklist(["prompt", "deny", "allow"]);
var GraphQLPolicy = v.object({
  endpoint: v.string(),
  allow: v.object({
    query: v.optional(v.array(v.string()), []),
    mutation: v.optional(v.array(v.string()), [])
  }),
  unmatched: v.optional(UnmatchedPolicy)
});
var HostAllow = v.record(v.string(), v.array(v.string()));
var HostDef = v.object({
  /** Which secret to inject for requests to this host (references a key in [secrets]) */
  secret: v.optional(v.string()),
  /** Allowed HTTP method + path patterns */
  allow: v.optional(HostAllow, {}),
  /** Paths that are always denied (overrides allow) */
  deny: v.optional(v.array(v.string()), []),
  /** What happens for requests that don't match allow or deny */
  unmatched: v.optional(UnmatchedPolicy, "allow"),
  /** GraphQL-specific policy for a specific endpoint */
  graphql: v.optional(GraphQLPolicy)
});
var AbsoluteGuestPath = v.pipe(
  v.string(),
  v.check((path2) => path2.startsWith("/"), "mount target must be an absolute guest path")
);
var MountDef = v.pipe(
  v.union([
    v.string(),
    v.object({
      path: v.string(),
      target: v.optional(AbsoluteGuestPath),
      readonly: v.optional(v.boolean(), false)
    })
  ]),
  v.transform((input) => typeof input === "string" ? { path: input, readonly: false } : input)
);
var GitCredentialDef = v.object({
  host: v.string(),
  username: v.string(),
  secret: v.string()
});
var FortFileConfig = v.object({
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
  setup: v.optional(v.string())
});
function readTomlFile(path2) {
  let raw;
  try {
    raw = readFileSync(path2, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    throw new Error(`pi-fort: failed to read config at ${path2}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = parseTOML(raw);
  } catch (err) {
    throw new Error(`pi-fort: invalid TOML at ${path2}: ${err.message}`);
  }
  try {
    return v.parse(FortFileConfig, parsed);
  } catch (err) {
    throw new Error(`pi-fort: invalid config at ${path2}: ${err.message}`);
  }
}
function collectConfigFiles(cwd) {
  const layers = [];
  const projectDir = resolve(cwd);
  const mainPath = projectConfigPath(projectDir);
  const mainConfig = readTomlFile(mainPath);
  if (mainConfig) {
    layers.push({ path: mainPath, config: mainConfig });
  }
  const dropInDir = projectDropInDir(projectDir);
  if (existsSync(dropInDir)) {
    const files = readdirSync(dropInDir).filter((f) => f.endsWith(".toml")).sort();
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
function isPathLikeImage(image) {
  return image === "~" || image.startsWith("~/") || image.startsWith("./") || image.startsWith("../") || image.startsWith("/");
}
function resolveImagePath(image, configPath) {
  if (!isPathLikeImage(image)) return image;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (image === "~") return home;
  if (image.startsWith("~/")) return join(home, image.slice(2));
  if (image.startsWith("/")) return image;
  if (!configPath) return image;
  return resolve(dirname(configPath), image);
}
function mergeConfigs(layers) {
  const merged = {
    enabled: void 0,
    allow_egress: false,
    image: void 0,
    distro: "alpine",
    packages: [],
    mounts: [],
    env: {},
    secrets: {},
    "git-credentials": [],
    hosts: {}
  };
  const mountsByTarget = /* @__PURE__ */ new Map();
  const gitCredsByHost = /* @__PURE__ */ new Map();
  const setupScripts = [];
  for (const inputLayer of layers) {
    const layer = "config" in inputLayer ? inputLayer.config : inputLayer;
    const layerPath = "config" in inputLayer ? inputLayer.path : void 0;
    if (layer.enabled !== void 0) {
      merged.enabled = layer.enabled;
    }
    if (layer.allow_egress !== void 0) {
      merged.allow_egress = layer.allow_egress;
    }
    if (layer.image !== void 0) {
      merged.image = resolveImagePath(layer.image, layerPath);
    }
    if (layer.distro !== void 0) {
      merged.distro = layer.distro;
    }
    if (layer.packages) {
      for (const pkg of layer.packages) {
        if (!merged.packages.includes(pkg)) {
          merged.packages.push(pkg);
        }
      }
    }
    if (layer.mounts) {
      for (const mount of layer.mounts) {
        mountsByTarget.set(mount.target ?? mount.path, mount);
      }
    }
    if (layer.env) {
      for (const [key, val] of Object.entries(layer.env)) {
        merged.env[key] = val;
      }
    }
    if (layer.secrets) {
      for (const [key, val] of Object.entries(layer.secrets)) {
        merged.secrets[key] = val;
      }
    }
    if (layer["git-credentials"]) {
      for (const cred of layer["git-credentials"]) {
        gitCredsByHost.set(cred.host, cred);
      }
    }
    if (layer.hosts) {
      for (const [key, val] of Object.entries(layer.hosts)) {
        merged.hosts[key] = val;
      }
    }
    if (layer.setup) {
      setupScripts.push(layer.setup);
    }
  }
  merged.mounts = [...mountsByTarget.values()];
  merged["git-credentials"] = [...gitCredsByHost.values()];
  if (setupScripts.length > 0) {
    merged.setup = setupScripts.join("\n");
  }
  return merged;
}
function resolveHostPolicies(config) {
  const result = /* @__PURE__ */ new Map();
  for (const [hostname, hostDef] of Object.entries(config.hosts ?? {})) {
    const allows = /* @__PURE__ */ new Map();
    for (const [method, patterns] of Object.entries(hostDef.allow ?? {})) {
      allows.set(method.toUpperCase(), patterns);
    }
    const hostUnmatched = hostDef.unmatched ?? "allow";
    let graphql;
    if (hostDef.graphql) {
      graphql = {
        endpoint: hostDef.graphql.endpoint,
        allow: {
          query: hostDef.graphql.allow.query ?? [],
          mutation: hostDef.graphql.allow.mutation ?? []
        },
        // GraphQL inherits host unmatched if not set
        unmatched: hostDef.graphql.unmatched ?? hostUnmatched
      };
    }
    result.set(hostname, {
      hostname,
      allows,
      deny: hostDef.deny ?? [],
      unmatched: hostUnmatched,
      graphql
    });
  }
  return result;
}
function loadConfig(cwd) {
  const projectDir = resolve(cwd);
  const layers = collectConfigFiles(projectDir);
  const merged = mergeConfigs(layers);
  const policies = resolveHostPolicies(merged);
  const projectPath = projectConfigPath(projectDir);
  const hasProjectConfig = layers.some((l) => l.path === projectPath);
  const dropInPrefix = `${projectDropInDir(projectDir)}/`;
  const dropIns = layers.filter((l) => l.path.startsWith(dropInPrefix)).map((l) => basename(l.path, ".toml"));
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
function projectConfigPath(cwd) {
  return join(resolve(cwd), ".pi", "fort.toml");
}
function projectDropInDir(cwd) {
  return join(resolve(cwd), ".pi", "fort.d");
}
function tildify(p) {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return p;
  if (p === home) return "~";
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}
function initProjectConfig(cwd) {
  const created = [];
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
function addPackageToConfig(cwd, pkg) {
  const configPath = projectConfigPath(cwd);
  let existing = {};
  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseTOML(content);
    const result = v.safeParse(FortFileConfig, parsed);
    if (result.success) existing = result.output;
  } catch {
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
      writeFileSync(configPath, `${packagesLine}
${raw}`, "utf-8");
    }
  } else {
    writeFileSync(configPath, `${packagesLine}
`, "utf-8");
  }
}

// src/secrets.ts
import { execSync } from "child_process";
function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function runCommand(command) {
  try {
    const result = execSync(command, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1e4
    });
    const trimmed = result.trim();
    return trimmed || void 0;
  } catch {
    return void 0;
  }
}
function resolveSource(name, source) {
  if (source === false) return void 0;
  if ("command" in source) {
    const binary = source.command.split(/\s+/)[0];
    if (binary && !commandExists(binary)) return void 0;
    const value = runCommand(source.command);
    if (!value) return void 0;
    return { name, value, hosts: source.hosts };
  }
  if ("env" in source) {
    const value = process.env[source.env];
    if (!value) return void 0;
    return { name, value, hosts: source.hosts };
  }
  return void 0;
}
function resolveSecrets(configSecrets = {}) {
  const resolved = [];
  for (const [name, source] of Object.entries(configSecrets)) {
    const secret = resolveSource(name, source);
    if (secret) resolved.push(secret);
  }
  return resolved;
}
function resolveEnv(configEnv = {}) {
  const resolved = {};
  for (const [name, def] of Object.entries(configEnv)) {
    if (typeof def === "string") {
      resolved[name] = def;
      continue;
    }
    if ("command" in def) {
      const binary = def.command.split(/\s+/)[0];
      if (binary && !commandExists(binary)) continue;
      const value = runCommand(def.command);
      if (value) resolved[name] = value;
      continue;
    }
    if ("env" in def) {
      const value = process.env[def.env];
      if (value) resolved[name] = value;
    }
  }
  return resolved;
}

// src/tools.ts
import path from "path";
function shQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function createVmReadOps(vm) {
  return {
    readFile: async (p) => {
      const r = await vm.exec(["/bin/cat", p]);
      if (!r.ok) throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
      return r.stdoutBuffer;
    },
    access: async (p) => {
      const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(p)}`]);
      if (!r.ok) throw new Error(`not readable: ${p}`);
    },
    detectImageMimeType: async (p) => {
      try {
        const r = await vm.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(p)}`]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    }
  };
}
function createVmWriteOps(vm) {
  return {
    writeFile: async (p, content) => {
      const dir = path.posix.dirname(p);
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const script = ["set -eu", `mkdir -p ${shQuote(dir)}`, `echo ${shQuote(b64)} | base64 -d > ${shQuote(p)}`].join(
        "\n"
      );
      const r = await vm.exec(["/bin/sh", "-lc", script]);
      if (!r.ok) throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
    },
    mkdir: async (dir) => {
      const r = await vm.exec(["/bin/mkdir", "-p", dir]);
      if (!r.ok) throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
    }
  };
}
function createVmEditOps(vm) {
  const r = createVmReadOps(vm);
  const w = createVmWriteOps(vm);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}
var ENV_PASSTHROUGH = /* @__PURE__ */ new Set(["TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "EDITOR", "VISUAL", "PAGER"]);
function sanitizeEnv(env) {
  if (!env) return void 0;
  const out = {};
  for (const [k, v2] of Object.entries(env)) {
    if (typeof v2 === "string" && ENV_PASSTHROUGH.has(k)) out[k] = v2;
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
function createVmBashOps(vm) {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = timeout && timeout > 0 ? setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeout * 1e3) : void 0;
      try {
        const proc = vm.exec(["/bin/sh", "-lc", command], {
          cwd,
          signal: ac.signal,
          env: sanitizeEnv(env),
          stdout: "pipe",
          stderr: "pipe"
        });
        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }
        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  };
}

// src/vm.ts
import { execSync as execSync2 } from "child_process";
import { existsSync as existsSync2 } from "fs";
import {
  createHttpHooks,
  ReadonlyProvider,
  RealFSProvider,
  VM
} from "@earendil-works/gondolin";

// src/graphql.ts
import { parse as parse2 } from "graphql";
function parseGraphQLBody(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return void 0;
  }
  const query = json.query;
  if (typeof query !== "string") return void 0;
  let doc;
  try {
    doc = parse2(query);
  } catch {
    return void 0;
  }
  const operations = [];
  for (const def of doc.definitions) {
    if (def.kind !== "OperationDefinition") continue;
    const opDef = def;
    const fields = [];
    for (const sel of opDef.selectionSet.selections) {
      if (sel.kind === "Field") {
        fields.push(sel.name.value);
      }
    }
    operations.push({
      type: opDef.operation,
      name: opDef.name?.value,
      fields
    });
  }
  return operations;
}
function checkGraphQLPolicy(operations, allow) {
  const denied = [];
  const deniedFields = [];
  for (const op of operations) {
    const patterns = op.type === "query" ? allow.query : op.type === "mutation" ? allow.mutation : void 0;
    if (!patterns || patterns.length === 0) {
      denied.push(op);
      deniedFields.push(...op.fields);
      continue;
    }
    const unmatchedFields = op.fields.filter((field) => !patterns.some((p) => globMatch(p, field)));
    if (unmatchedFields.length > 0) {
      denied.push(op);
      deniedFields.push(...unmatchedFields);
    }
  }
  if (denied.length === 0) return { allowed: true };
  return { allowed: false, denied, deniedFields };
}
function globMatch(pattern, value) {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

// src/policy.ts
function matchPath(pattern, path2) {
  const normPattern = pattern.startsWith("/") ? pattern : `/${pattern}`;
  const normPath = path2.startsWith("/") ? path2 : `/${path2}`;
  const patternParts = normPattern.split("/").filter(Boolean);
  const pathParts = normPath.split("/").filter(Boolean);
  let pi = 0;
  let pp = 0;
  while (pi < patternParts.length && pp < pathParts.length) {
    const pat = patternParts[pi];
    if (pat === "**") {
      return true;
    }
    if (pat === "*") {
      pi++;
      pp++;
      continue;
    }
    if (pat !== pathParts[pp]) {
      return false;
    }
    pi++;
    pp++;
  }
  if (pi < patternParts.length && patternParts[pi] === "**") {
    return true;
  }
  return pi === patternParts.length && pp === pathParts.length;
}
function checkPolicy(policy, method, path2) {
  const upperMethod = method.toUpperCase();
  for (const pattern of policy.deny) {
    if (matchPath(pattern, path2)) {
      return "deny";
    }
  }
  const allowedPatterns = policy.allows.get(upperMethod);
  if (allowedPatterns) {
    for (const pattern of allowedPatterns) {
      if (matchPath(pattern, path2)) {
        return "allow";
      }
    }
  }
  return policy.unmatched;
}
function evaluateRequest(policies, hostname, method, path2) {
  const policy = policies.get(hostname);
  if (!policy) return "allow";
  return checkPolicy(policy, method, path2);
}

// src/vm.ts
function createVfsMounts(workspaceDir, extraMounts) {
  const mounts = {
    [workspaceDir]: new RealFSProvider(workspaceDir)
  };
  const piDir = `${workspaceDir}/.pi`;
  if (existsSync2(piDir)) {
    mounts[piDir] = new ReadonlyProvider(new RealFSProvider(piDir));
  }
  for (const extra of extraMounts) {
    const target = extra.target ?? extra.path;
    if (mounts[target]) continue;
    if (!existsSync2(extra.path)) continue;
    const provider = new RealFSProvider(extra.path);
    mounts[target] = extra.readonly ? new ReadonlyProvider(provider) : provider;
  }
  return mounts;
}
var FortVM = class {
  vm;
  closed = false;
  options;
  /** Guest distro selected for package-manager behavior. */
  get distro() {
    return this.options.distro;
  }
  /** Access the underlying Gondolin VM for creating tool operations. */
  get rawVm() {
    if (!this.vm) throw new Error("pi-fort: VM not started");
    return this.vm;
  }
  constructor(options) {
    this.options = options;
  }
  /**
   * Start the VM. Call once before exec().
   */
  async start() {
    if (this.vm) return;
    if (this.closed) throw new Error("pi-fort: VM has been closed");
    const { workspaceDir, secrets, allowedHosts, policies, onPolicyPrompt, distro } = this.options;
    const packageManager = getPackageManager(distro);
    this.options.onStatus?.("Starting VM...");
    const secretDefs = {};
    for (const secret of secrets) {
      secretDefs[secret.name] = {
        hosts: secret.hosts,
        value: secret.value
      };
    }
    const hookOptions = {
      secrets: secretDefs,
      blockInternalRanges: true
    };
    if (allowedHosts) {
      hookOptions.allowedHosts = [...allowedHosts, ...packageManager.packageHosts];
    }
    if (policies.size > 0) {
      hookOptions.isRequestAllowed = async (request) => {
        const url = new URL(request.url);
        const hostPolicy = policies.get(url.hostname);
        if (hostPolicy?.graphql && request.method === "POST" && url.pathname === hostPolicy.graphql.endpoint) {
          return true;
        }
        const decision = evaluateRequest(policies, url.hostname, request.method, url.pathname);
        if (decision === "allow") return true;
        if (decision === "deny") return false;
        if (decision === "prompt" && onPolicyPrompt) {
          return onPolicyPrompt(request.method, request.url, url.hostname);
        }
        return false;
      };
    }
    hookOptions.onRequest = async (request) => {
      if (request.method !== "POST") return;
      const url = new URL(request.url);
      const hostPolicy = policies.get(url.hostname);
      if (!hostPolicy?.graphql || url.pathname !== hostPolicy.graphql.endpoint) return;
      const gqlPolicy = hostPolicy.graphql;
      let bodyText;
      try {
        const cloned = request.clone();
        bodyText = await cloned.text();
      } catch {
        return;
      }
      const operations = parseGraphQLBody(bodyText);
      if (!operations) {
        if (gqlPolicy.unmatched === "allow") return;
        return new Response(JSON.stringify({ errors: [{ message: "Blocked by pi-fort: unparseable GraphQL body" }] }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (operations.length === 0) return;
      const result = checkGraphQLPolicy(operations, gqlPolicy.allow);
      if (result.allowed) return;
      if (gqlPolicy.unmatched === "allow") return;
      if (gqlPolicy.unmatched === "deny") {
        return new Response(
          JSON.stringify({ errors: [{ message: `Blocked by pi-fort: ${result.deniedFields.join(", ")}` }] }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      if (onPolicyPrompt) {
        const fieldList = result.deniedFields.join(", ");
        const allowed = await onPolicyPrompt(
          "GRAPHQL",
          `${url.hostname}${gqlPolicy.endpoint}: ${fieldList}`,
          url.hostname
        );
        if (!allowed) {
          return new Response(JSON.stringify({ errors: [{ message: `Blocked by pi-fort: ${fieldList}` }] }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
          });
        }
      } else {
        return new Response(JSON.stringify({ errors: [{ message: "Blocked by pi-fort policy" }] }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }
    };
    const { httpHooks, env } = createHttpHooks(hookOptions);
    const mounts = createVfsMounts(workspaceDir, this.options.extraMounts);
    const qemuPath = qemuBinaryForHost();
    if (!qemuPath) {
      throw new Error(`pi-fort does not support host architecture: ${process.arch}`);
    }
    this.vm = await VM.create({
      sandbox: {
        ...this.options.image ? { imagePath: this.options.image } : {},
        qemuPath
      },
      dns: {
        mode: "synthetic"
      },
      httpHooks,
      env: {
        ...env,
        ...this.options.extraEnv,
        HOME: "/root",
        TERM: "xterm-256color"
      },
      vfs: {
        mounts
      },
      sessionLabel: "pi-fort"
    });
    this.options.onStatus?.("Installing packages...");
    const packages = this.options.packages;
    if (packages.length > 0) {
      const result = await this.vm.exec(packageManager.installPackagesCommand(packages));
      if (!result.ok) {
        this.options.onStatus?.(`Fort active (package install warning: ${result.stderr.trim().split("\n").pop()})`);
        return;
      }
    }
    for (const cred of this.options.gitCredentials) {
      await this.vm.exec(
        `git config --global credential.https://${shellEscape(cred.host)}.helper '!f() { echo "username=${shellEscape(cred.username)}"; echo "password=$${cred.secret}"; }; f'`
      );
    }
    if (this.options.setupScript) {
      this.options.onStatus?.("Running setup...");
      const result = await this.vm.exec(this.options.setupScript);
      if (!result.ok) {
        this.options.onStatus?.(`Fort active (setup warning: ${result.stderr.trim().split("\n").pop()})`);
        return;
      }
    }
    this.options.onStatus?.("VM ready");
  }
  /**
   * Install additional packages at runtime.
   */
  async installPackage(pkg) {
    if (!this.vm) throw new Error("pi-fort: VM not started");
    return this.vm.exec(getPackageManager(this.options.distro).installPackageCommand(pkg));
  }
  /**
   * Check if the VM is running.
   */
  get isRunning() {
    return this.vm !== void 0 && !this.closed;
  }
  /**
   * Shut down the VM.
   */
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.vm) {
      await this.vm.close();
      this.vm = void 0;
    }
  }
};
function qemuBinaryForHost() {
  if (process.arch === "arm64") return "qemu-system-aarch64";
  if (process.arch === "x64") return "qemu-system-x86_64";
  return void 0;
}
function checkQemuAvailable() {
  const qemuBinary = qemuBinaryForHost();
  if (!qemuBinary) {
    return {
      available: false,
      message: `pi-fort does not support host architecture: ${process.arch}`
    };
  }
  try {
    execSync2(`which ${qemuBinary}`, { stdio: "ignore" });
    return { available: true };
  } catch {
    const platform = process.platform;
    let installHint;
    if (platform === "darwin") {
      installHint = "Install with: brew install qemu";
    } else if (platform === "linux") {
      const debianPackage = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86";
      installHint = `Install with: sudo apt install ${debianPackage} (Debian/Ubuntu) or sudo pacman -S qemu-full (Arch)`;
    } else {
      installHint = "QEMU is required but your platform may not be supported.";
    }
    return {
      available: false,
      message: `pi-fort requires QEMU but ${qemuBinary} was not found.
${installHint}`
    };
  }
}

// src/index.ts
async function handleAddPackage(query, fortVm, cwd, ctx) {
  const vm = fortVm.rawVm;
  const packageManager = getPackageManager(fortVm.distro);
  await packageManager.prepareSearch?.(vm);
  const exactResult = await vm.exec(packageManager.exactPackageInfoCommand(query));
  let targetPkg;
  if (exactResult.ok && exactResult.stdout.trim()) {
    const info = exactResult.stdout.trim() || `Package: ${query}`;
    const ok = await ctx.ui.confirm(`\u{1F9CA} Install ${query}?`, info);
    if (ok) targetPkg = query;
  } else {
    const searchResult = await vm.exec(packageManager.searchPackagesCommand(query));
    const results = searchResult.ok ? packageManager.parseSearchResults(searchResult.stdout).slice(0, 10) : [];
    if (results.length === 0) {
      ctx.ui.notify(`No packages found for "${query}".`, "warning");
      return;
    }
    const options = [];
    for (const result of results) {
      let desc = result.description;
      if (!desc) {
        const descResult = await vm.exec(packageManager.descriptionCommand(result.name));
        desc = descResult.ok ? packageManager.parseDescription(descResult.stdout) : void 0;
      }
      options.push(desc ? `${result.name} \u2014 ${desc.trim()}` : result.name);
    }
    options.push("Cancel");
    const choice = await ctx.ui.select(`\u{1F9CA} No exact match for "${query}". Select a package:`, options);
    if (!choice || choice === "Cancel") return;
    targetPkg = choice.split(" \u2014 ")[0];
  }
  if (!targetPkg) return;
  const installResult = await fortVm.installPackage(targetPkg);
  if (!installResult.ok) {
    ctx.ui.notify(`\u274C Failed to install ${targetPkg}: ${installResult.stderr.slice(0, 200)}`, "error");
    return;
  }
  addPackageToConfig(cwd, targetPkg);
  ctx.ui.notify(`\u2705 Installed ${targetPkg} and added it to .pi/fort.toml`);
}
var SESSION_ENTRY_TYPE = "fort:active";
function index_default(pi) {
  const qemu = checkQemuAvailable();
  if (!qemu.available) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(qemu.message, "error");
    });
    return;
  }
  const localCwd = process.cwd();
  const { merged, policies, hasProjectConfig, dropIns } = loadConfig(localCwd);
  const image = merged.image;
  const distro = merged.distro ?? "alpine";
  const packages = merged.packages ?? [];
  const extraMounts = merged.mounts ?? [];
  const gitCredentials = merged["git-credentials"] ?? [];
  const allowEgress = merged.allow_egress ?? false;
  const extraEnv = resolveEnv(merged.env);
  const setupScript = merged.setup;
  let secrets;
  try {
    secrets = resolveSecrets(merged.secrets);
  } catch (err) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`pi-fort: failed to resolve secrets: ${err.message}`, "error");
    });
    return;
  }
  const policyHosts = [...policies.keys()];
  const secretHosts = secrets.flatMap((s) => s.hosts);
  const allowedHosts = allowEgress ? void 0 : [.../* @__PURE__ */ new Set([...secretHosts, ...policyHosts])];
  const configEnabled = merged.enabled;
  let sessionOverride;
  function isActive() {
    if (sessionOverride !== void 0) return sessionOverride;
    return configEnabled === true;
  }
  function getSessionActivation(ctx) {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === SESSION_ENTRY_TYPE) {
        return entry.data;
      }
    }
    return void 0;
  }
  let fortVm;
  let vmStarting;
  async function shutdownVm() {
    if (fortVm) {
      await fortVm.close();
      fortVm = void 0;
    }
    vmStarting = void 0;
  }
  async function ensureVm(ctx) {
    if (!isActive()) return null;
    if (fortVm?.isRunning) return fortVm;
    if (vmStarting) return vmStarting;
    vmStarting = (async () => {
      ctx.ui.setStatus("fort", "\u{1F9CA} Starting VM...");
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
            `${method} ${url}
Host: ${hostname}

Allow this request?`
          );
        },
        onStatus: (message) => {
          ctx.ui.setStatus("fort", `\u{1F9CA} ${message}`);
        }
      });
      await instance.start();
      fortVm = instance;
      ctx.ui.setStatus("fort", "\u{1F9CA} Fort active");
      setTimeout(() => ctx.ui.setStatus("fort", void 0), 5e3);
      return instance;
    })();
    return vmStarting;
  }
  pi.on("session_start", async (_event, ctx) => {
    const prev = getSessionActivation(ctx);
    if (prev !== void 0) {
      sessionOverride = prev;
    }
    if (isActive()) {
      ensureVm(ctx);
      if (!isLastHintActive(ctx)) {
        sendFortHint();
      }
    } else if (configEnabled === void 0 && sessionOverride === void 0) {
      ctx.ui.notify("\u{1F9CA} pi-fort is installed but not enabled. Run /fort init to set up.");
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await shutdownVm();
    ctx.ui.setStatus("fort", void 0);
  });
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
    }
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
        onUpdate
      );
    }
  });
  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const vm = await ensureVm(ctx);
      if (!vm) return localEdit.execute(id, params, signal, onUpdate);
      return createEditTool(localCwd, { operations: createVmEditOps(vm.rawVm) }).execute(id, params, signal, onUpdate);
    }
  });
  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const vm = await ensureVm(ctx);
      if (!vm) return localBash.execute(id, params, signal, onUpdate);
      return createBashTool(localCwd, { operations: createVmBashOps(vm.rawVm) }).execute(id, params, signal, onUpdate);
    }
  });
  pi.on("user_bash", (_event, _ctx) => {
    if (!fortVm?.isRunning) return;
    return { operations: createVmBashOps(fortVm.rawVm) };
  });
  const FORT_HINT = `\u{1F9CA} Fort active. All tools are running inside an isolated ${getPackageManager(distro).label} VM. If a command is not found, install it with \`/fort add <package>\`. Package names are distro-native and may differ from binary names.`;
  function isLastHintActive(ctx) {
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
      { customType: "fort:off", content: "\u{1F9CA} Fort disabled. Tools are running on the host.", display: true },
      { deliverAs: "nextTurn" }
    );
  }
  pi.registerCommand("fort", {
    description: "Manage fort: /fort [status|init|on|off|restart|add <pkg>]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || "status";
      switch (subcommand) {
        case "status": {
          const lines = [];
          if (fortVm?.isRunning) {
            lines.push("\u{1F9CA} Fort active");
          } else if (isActive()) {
            lines.push("\u{1F9CA} Enabled, VM starts on next tool use");
          } else {
            lines.push("\u{1F9CA} Not enabled");
          }
          lines.push("");
          const configLines = [];
          if (hasProjectConfig) configLines.push(`  ${tildify(projectConfigPath(localCwd))}`);
          if (dropIns.length) configLines.push(`  ${tildify(projectDropInDir(localCwd))}/*`);
          if (configLines.length) {
            lines.push("Config:");
            lines.push(...configLines);
          } else {
            lines.push("Config: none");
          }
          lines.push("");
          lines.push(`Distro:    ${distro}`);
          lines.push(`Packages:  ${packages.join(", ")}`);
          const secretNames = secrets.map((s) => s.name).join(", ");
          if (secretNames) lines.push(`Secrets:   ${secretNames}`);
          const envNames = Object.keys(extraEnv).join(", ");
          if (envNames) lines.push(`Env:       ${envNames}`);
          lines.push(`Egress:    ${allowEgress ? "allow all HTTP hosts" : "configured hosts only"}`);
          const hostNames = [...policies.keys()].join(", ");
          if (hostNames) lines.push(`Policies:  ${hostNames}`);
          ctx.ui.notify(lines.join("\n"));
          break;
        }
        case "init": {
          const created = initProjectConfig(localCwd);
          const messages = [];
          for (const path2 of created) {
            messages.push(`Created ${tildify(path2)}`);
          }
          if (created.length === 0) {
            messages.push(".pi/fort.toml and .pi/fort.d already exist");
          } else {
            sessionOverride = true;
            pi.appendEntry(SESSION_ENTRY_TYPE, true);
          }
          ctx.ui.notify(`\u{1F9CA} ${messages.join("\n")}`);
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
          ctx.ui.setStatus("fort", void 0);
          sendFortOff();
          break;
        }
        case "restart": {
          await shutdownVm();
          ctx.ui.notify("\u{1F9CA} pi-fort: VM will restart on next tool use.");
          break;
        }
        case "add": {
          const query = parts.slice(1).join(" ");
          if (!query) {
            ctx.ui.notify("Usage: /fort add <package-name>", "warning");
            return;
          }
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
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!fortVm) return;
    ctx.ui.setStatus("fort", "\u{1F9CA} Stopping fort...");
    await shutdownVm();
  });
}
export {
  index_default as default
};
