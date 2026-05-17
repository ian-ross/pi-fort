import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVfsMounts } from "../src/vm.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = join(import.meta.dirname ?? ".", `.test-tmp-vm-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("createVfsMounts", () => {
	it("mounts the workspace at its host path", () => {
		const workspace = join(tmpDir, "workspace");
		mkdirSync(workspace, { recursive: true });

		const mounts = createVfsMounts(workspace, []);

		expect(Object.keys(mounts)).toEqual([workspace]);
		expect(mounts[workspace]?.readonly).toBe(false);
	});

	it("mounts the workspace .pi directory as readable but read-only", async () => {
		const workspace = join(tmpDir, "workspace");
		const piDir = join(workspace, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "fort.toml"), "enabled = true\n");

		const mounts = createVfsMounts(workspace, []);
		const piProvider = mounts[piDir]!;

		expect(piProvider).toBeDefined();
		expect(piProvider.readonly).toBe(true);
		await expect(piProvider.readFile("/fort.toml", "utf-8")).resolves.toBe("enabled = true\n");
		await expect(piProvider.writeFile("/fort.toml", "enabled = false")).rejects.toThrow();
		await expect(piProvider.mkdir("/new-dir", { recursive: true })).rejects.toThrow();
	});

	it("uses target as the guest mount path for extra mounts", () => {
		const workspace = join(tmpDir, "workspace");
		const shared = join(tmpDir, "shared");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(shared, { recursive: true });

		const mounts = createVfsMounts(workspace, [{ path: shared, target: "/mnt/shared", readonly: false }]);

		expect(mounts[shared]).toBeUndefined();
		expect(mounts["/mnt/shared"]).toBeDefined();
		expect(mounts["/mnt/shared"]?.readonly).toBe(false);
	});

	it("wraps readonly extra mounts with a readonly provider", () => {
		const workspace = join(tmpDir, "workspace");
		const shared = join(tmpDir, "shared");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(shared, { recursive: true });

		const mounts = createVfsMounts(workspace, [{ path: shared, target: "/mnt/shared", readonly: true }]);

		expect(mounts["/mnt/shared"]?.readonly).toBe(true);
	});

	it("skips missing extra mount paths", () => {
		const workspace = join(tmpDir, "workspace");
		const missing = join(tmpDir, "missing");
		mkdirSync(workspace, { recursive: true });

		const mounts = createVfsMounts(workspace, [{ path: missing, target: "/mnt/missing", readonly: false }]);

		expect(mounts["/mnt/missing"]).toBeUndefined();
	});
});
