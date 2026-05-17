import { describe, expect, it } from "vitest";
import { getPackageManager } from "../src/package-manager.js";

describe("package managers", () => {
	it("generates Alpine commands", () => {
		const pm = getPackageManager("alpine");
		expect(pm.packageHosts).toEqual(["dl-cdn.alpinelinux.org"]);
		expect(pm.installPackagesCommand(["git", "curl"])).toBe("apk add --no-progress 'git' 'curl'");
		expect(pm.installPackageCommand("ripgrep")).toBe("apk add --no-progress 'ripgrep'");
		expect(pm.exactPackageInfoCommand("gh")).toBe("apk search --exact 'gh'");
		expect(pm.searchPackagesCommand("gh")).toBe("apk search 'gh'");
	});

	it("generates Debian commands", () => {
		const pm = getPackageManager("debian");
		expect(pm.packageHosts).toEqual(["deb.debian.org", "security.debian.org", "ftp.debian.org"]);
		expect(pm.installPackagesCommand(["git", "curl"])).toBe(
			"apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends 'git' 'curl'",
		);
		expect(pm.installPackageCommand("ripgrep")).toBe(
			"apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends 'ripgrep'",
		);
		expect(pm.exactPackageInfoCommand("gh")).toBe("apt-cache show 'gh'");
		expect(pm.searchPackagesCommand("gh")).toBe("apt-cache search 'gh'");
	});

	it("parses Alpine search results", () => {
		const pm = getPackageManager("alpine");
		expect(pm.parseSearchResults("ripgrep-14.1.1-r0\nripgrep-doc-14.1.1-r0\n")).toEqual([{ name: "ripgrep" }]);
	});

	it("parses Debian search results", () => {
		const pm = getPackageManager("debian");
		expect(pm.parseSearchResults("ripgrep - recursively searches directories\nripgrep-doc - docs\n")).toEqual([
			{ name: "ripgrep", description: "recursively searches directories" },
		]);
	});
});
