/**
 * Integration tests for config loading, file creation, and package management.
 * Uses a temp directory to avoid touching real config files.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addPackageToConfig,
	collectConfigFiles,
	effectiveMounts,
	initProjectConfig,
	loadConfig,
	projectConfigPath,
	projectDropInDir,
	removeMountConfig,
	resetContainerConfig,
	setContainerConfig,
	setMountConfig,
	setNetworkConfig,
	storedPathForCommandInput,
} from "../src/config.js";

// Override HOME so we don't touch real config
let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	tmpDir = join(import.meta.dirname ?? ".", `.test-tmp-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env.HOME = tmpDir;
});

afterEach(() => {
	process.env.HOME = origHome;
	// Clean up
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("initProjectConfig", () => {
	it("creates project config and drop-in files from templates", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(projectDir, { recursive: true });
		const created = initProjectConfig(projectDir);
		expect(created.length).toBeGreaterThan(0);
		expect(existsSync(join(projectDir, ".pi", "fort.toml"))).toBe(true);
		expect(existsSync(join(projectDir, ".pi", "fort.d", "git.toml"))).toBe(true);
		expect(existsSync(join(projectDir, ".pi", "fort.d", "github.toml"))).toBe(true);
		expect(existsSync(join(projectDir, ".pi", "fort.d", "jj.toml"))).toBe(false);

		const content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content).toContain("enabled = true");
		expect(content).toContain("# allow_egress = false");
		expect(content).toContain('packages = ["git", "curl", "jq"]');
	});

	it("does not overwrite existing files", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi", "fort.d"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), 'packages = ["custom"]\n');
		writeFileSync(join(projectDir, ".pi", "fort.d", "git.toml"), 'packages = ["custom-git"]\n');

		initProjectConfig(projectDir);

		expect(readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8")).toContain("custom");
		expect(readFileSync(join(projectDir, ".pi", "fort.d", "git.toml"), "utf-8")).toContain("custom-git");
		expect(existsSync(join(projectDir, ".pi", "fort.d", "github.toml"))).toBe(true);
	});
});

describe("collectConfigFiles with drop-ins", () => {
	it("loads project config and project drop-in files", () => {
		const projectDir = join(tmpDir, "project");
		initProjectConfig(projectDir);
		const layers = collectConfigFiles(projectDir);
		const paths = layers.map((l) => l.path);
		expect(paths).toEqual([
			join(projectDir, ".pi", "fort.d", "git.toml"),
			join(projectDir, ".pi", "fort.d", "github.toml"),
			join(projectDir, ".pi", "fort.toml"),
		]);
	});

	it("ignores old global config files", () => {
		mkdirSync(join(tmpDir, ".pi", "agent", "extensions", "pi-fort.d"), { recursive: true });
		writeFileSync(join(tmpDir, ".pi", "agent", "extensions", "pi-fort.toml"), 'packages = ["global-only"]\n');
		writeFileSync(join(tmpDir, ".pi", "agent", "extensions", "pi-fort.d", "old.toml"), 'packages = ["old-dropin"]\n');

		const { merged } = loadConfig(tmpDir);
		expect(merged.packages).not.toContain("global-only");
		expect(merged.packages).not.toContain("old-dropin");
	});

	it("merges packages from project layers additively", () => {
		const projectDir = join(tmpDir, "project");
		initProjectConfig(projectDir);
		const { merged } = loadConfig(projectDir);
		const pkgs = merged.packages ?? [];
		expect(pkgs).toContain("curl");
		expect(pkgs).toContain("jq");
		expect(pkgs).toContain("git");
		expect(pkgs).not.toContain("github-cli");
		expect(pkgs).not.toContain("jujutsu");
	});

	it("collects setup scripts from drop-ins", () => {
		const projectDir = join(tmpDir, "project");
		initProjectConfig(projectDir);
		const { merged } = loadConfig(projectDir);
		expect(merged.setup).toContain("safe.directory");
		expect(merged.setup).not.toContain("jj config set");
	});

	it("reports config sources accurately", () => {
		const projectDir = join(tmpDir, "project");
		initProjectConfig(projectDir);

		const result = loadConfig(projectDir);
		expect(result.hasProjectConfig).toBe(true);
		expect(result.dropIns).toEqual(["git", "github"]);
	});

	it("lets the main project config override drop-ins", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi", "fort.d"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), 'enabled = true\nimage = "main:latest"\n');
		writeFileSync(join(projectDir, ".pi", "fort.d", "image.toml"), 'image = "dropin:latest"\n');

		const { merged } = loadConfig(projectDir);
		expect(merged.image).toBe("main:latest");
	});

	it("resolves relative image paths against the config file that sets them", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi", "fort.d"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), 'enabled = true\nimage = "./images/main"\n');
		writeFileSync(join(projectDir, ".pi", "fort.d", "image.toml"), 'image = "../images/dropin"\n');

		const { merged } = loadConfig(projectDir);
		expect(merged.image).toBe(join(projectDir, ".pi", "images/main"));
	});

	it("leaves image tags unchanged", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), 'enabled = true\nimage = "pi-fort-debian:latest"\n');

		const { merged } = loadConfig(projectDir);
		expect(merged.image).toBe("pi-fort-debian:latest");
	});

	it("does not walk ancestor directories", () => {
		const parent = join(tmpDir, "parent");
		const child = join(parent, "child");
		mkdirSync(join(parent, ".pi"), { recursive: true });
		mkdirSync(child, { recursive: true });
		writeFileSync(join(parent, ".pi", "fort.toml"), "enabled = true\n");

		const result = loadConfig(child);
		expect(result.hasProjectConfig).toBe(false);
		expect(result.merged.enabled).toBeUndefined();
	});
});

describe("addPackageToConfig", () => {
	it("adds a package to an existing project config", () => {
		const projectDir = join(tmpDir, "project");
		initProjectConfig(projectDir);
		addPackageToConfig(projectDir, "ripgrep");
		const content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content).toContain("ripgrep");
		expect(content).toContain("curl");
	});

	it("does not duplicate existing packages", () => {
		const projectDir = join(tmpDir, "project");
		initProjectConfig(projectDir);
		addPackageToConfig(projectDir, "curl");
		const content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		const matches = content.match(/curl/g);
		expect(matches).toHaveLength(1);
	});

	it("creates project config when needed", () => {
		const projectDir = join(tmpDir, "project");
		addPackageToConfig(projectDir, "ripgrep");
		const content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content).toContain('packages = ["ripgrep"]');
		expect(existsSync(projectDropInDir(projectDir))).toBe(false);
	});
});

describe("persistent config commands", () => {
	it("stores command-relative paths relative to .pi/fort.toml", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		expect(storedPathForCommandInput(projectDir, "images/debian")).toBe("../images/debian");
		expect(dirname(projectConfigPath(projectDir))).toBe(join(projectDir, ".pi"));
	});

	it("sets network egress while preserving comments", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), "# keep me\n# allow_egress = false\n");
		setNetworkConfig(projectDir, true);
		const content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content).toContain("# keep me");
		expect(content).toContain("allow_egress = true");
	});

	it("adds absent scalar settings before table sections", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), '[env]\nFOO = "bar"\n');
		setNetworkConfig(projectDir, true);
		const content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content.indexOf("allow_egress = true")).toBeLessThan(content.indexOf("[env]"));
		expect(loadConfig(projectDir).merged.allow_egress).toBe(true);
	});

	it("sets and resets Debian container config", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), "enabled = true\n");
		setContainerConfig(projectDir, "images/debian");
		let content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content).toContain('distro = "debian"');
		expect(content).toContain('image = "../images/debian"');
		resetContainerConfig(projectDir);
		content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content).not.toContain("distro =");
		expect(content).not.toContain("image =");
	});

	it("converts array-of-table mounts when updating command-managed mounts", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "fort.toml"),
			'enabled = true\n\n[[mounts]]\npath = "../old"\ntarget = "/mnt/old"\nreadonly = true\n',
		);
		setMountConfig(projectDir, "host", "/mnt/host", true);
		const content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content).not.toContain("[[mounts]]");
		expect(content).toContain('target = "/mnt/old"');
		expect(content).toContain('target = "/mnt/host"');
	});

	it("adds mounts before table sections so they remain top-level", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "fort.toml"),
			'enabled = true\n\n[env]\nUSER_NAME = { command = "git config user.name" }\n',
		);

		setMountConfig(projectDir, "/data/concord", undefined, true);
		const content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content.indexOf("mounts = [")).toBeLessThan(content.indexOf("[env]"));
		expect(loadConfig(projectDir).merged.mounts?.[0]).toEqual({ path: "/data/concord", readonly: true });
	});

	it("repairs mounts that an older command wrote under env", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "fort.toml"),
			'enabled = true\n\n[env]\nUSER_NAME = { command = "git config user.name" }\nmounts = [\n\t{ path = "/data/concord", readonly = true },\n]\n',
		);

		expect(loadConfig(projectDir).merged.mounts?.[0]).toEqual({ path: "/data/concord", readonly: true });
		setMountConfig(projectDir, "/data/concord", undefined, false);
		const content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content.indexOf("mounts = [")).toBeLessThan(content.indexOf("[env]"));
		expect(content.slice(content.indexOf("[env]")).includes("mounts = [")).toBe(false);
		expect(loadConfig(projectDir).merged.mounts?.[0]?.readonly).toBe(false);
	});

	it("adds, updates, lists, and removes mounts by guest path", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi", "fort.d"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), "enabled = true\n");
		writeFileSync(
			join(projectDir, ".pi", "fort.d", "data.toml"),
			'mounts = [{ path = "../drop", target = "/mnt/data", readonly = true }]\n',
		);

		setMountConfig(projectDir, "host-a", "/mnt/data", true);
		setMountConfig(projectDir, "host-b", "/mnt/data", false);
		let content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content).toContain('path = "../host-b"');
		expect(content).toContain('target = "/mnt/data"');
		expect(content).toContain("readonly = false");
		expect(content).not.toContain("host-a");

		let mounts = effectiveMounts(projectDir);
		expect(mounts.find((m) => m.target === "/mnt/data")?.source).toBe(join(projectDir, ".pi", "fort.toml"));

		expect(removeMountConfig(projectDir, "/mnt/data")).toBe(true);
		content = readFileSync(join(projectDir, ".pi", "fort.toml"), "utf-8");
		expect(content).toContain("mounts = []");
		mounts = effectiveMounts(projectDir);
		expect(mounts.find((m) => m.target === "/mnt/data")?.source).toBe(join(projectDir, ".pi", "fort.d", "data.toml"));
	});
});

describe("mount path resolution", () => {
	it("expands ~ to HOME in mount paths", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), 'enabled = true\n\n[[mounts]]\npath = "~/dev/.jj"\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "dev/.jj"));
	});

	it("expands ~ in bare string mounts", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), 'enabled = true\nmounts = ["~/dev/.jj", "~/dev/.git"]\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts).toHaveLength(2);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "dev/.jj"));
		expect(merged.mounts?.[1]?.path).toBe(join(tmpDir, "dev/.git"));
	});

	it("resolves relative paths against the config file that sets them", () => {
		const projectDir = join(tmpDir, "project", "sub");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), 'enabled = true\nmounts = ["../.jj", "../.git"]\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts).toHaveLength(2);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "project", "sub", ".jj"));
		expect(merged.mounts?.[1]?.path).toBe(join(tmpDir, "project", "sub", ".git"));
	});

	it("resolves nested relative paths against cwd", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), 'enabled = true\nmounts = ["../shared/data"]\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "project", "shared/data"));
	});

	it("preserves absolute guest target paths", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "fort.toml"),
			'enabled = true\n\n[[mounts]]\npath = "../shared/config"\ntarget = "/mnt/config"\nreadonly = true\n',
		);
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts?.[0]).toEqual({
			path: join(tmpDir, "project", "shared/config"),
			target: "/mnt/config",
			readonly: true,
		});
	});

	it("leaves absolute paths unchanged", () => {
		const projectDir = join(tmpDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "fort.toml"), 'enabled = true\nmounts = ["/tmp/shared"]\n');
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts?.[0]?.path).toBe("/tmp/shared");
	});

	it("resolves relative paths in object mount syntax", () => {
		const projectDir = join(tmpDir, "project", "sub");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "fort.toml"),
			'enabled = true\n\n[[mounts]]\npath = "../.jj"\nreadonly = true\n',
		);
		const { merged } = loadConfig(projectDir);
		expect(merged.mounts?.[0]?.path).toBe(join(tmpDir, "project", "sub", ".jj"));
		expect(merged.mounts?.[0]?.readonly).toBe(true);
	});
});
