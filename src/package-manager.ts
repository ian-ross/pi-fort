import type { ExecResult, VM } from "@earendil-works/gondolin";

export const Distros = ["alpine", "debian"] as const;
export type Distro = (typeof Distros)[number];

export interface PackageSearchResult {
	name: string;
	description?: string;
}

export interface PackageManager {
	distro: Distro;
	label: string;
	packageHosts: string[];
	installPackagesCommand(packages: string[]): string;
	installPackageCommand(pkg: string): string;
	prepareSearch?(vm: VM): Promise<void>;
	exactPackageInfoCommand(query: string): string;
	searchPackagesCommand(query: string): string;
	descriptionCommand(pkg: string): string;
	parseSearchResults(stdout: string): PackageSearchResult[];
	parseDescription(stdout: string): string | undefined;
}

export function getPackageManager(distro: Distro): PackageManager {
	switch (distro) {
		case "alpine":
			return alpinePackageManager;
		case "debian":
			return debianPackageManager;
	}
}

export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function extractAlpinePkgName(versionedName: string): string {
	const match = versionedName.match(/^(.+?)-\d/);
	return match ? match[1] : versionedName;
}

function isAuxiliaryPackage(name: string): boolean {
	return /-(?:doc|dev|lang|dbg|bash-completion|zsh-completion|fish-completion|pyc)$/.test(name);
}

export const alpinePackageManager: PackageManager = {
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
		const names = stdout
			.trim()
			.split("\n")
			.map((line) => extractAlpinePkgName(line.trim()))
			.filter(Boolean)
			.filter((name) => !isAuxiliaryPackage(name));
		return [...new Set(names)].map((name) => ({ name }));
	},
	parseDescription: (stdout) =>
		stdout
			.trim()
			.split("\n")
			.find((line) => !line.includes("description:") && line.trim())
			?.trim(),
};

export const debianPackageManager: PackageManager = {
	distro: "debian",
	label: "Debian Linux",
	packageHosts: ["deb.debian.org", "security.debian.org", "ftp.debian.org"],
	installPackagesCommand: (packages) =>
		[
			"apt-get update",
			`DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.map(shellEscape).join(" ")}`,
		].join(" && "),
	installPackageCommand: (pkg) =>
		[
			"apt-get update",
			`DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${shellEscape(pkg)}`,
		].join(" && "),
	prepareSearch: async (vm) => {
		await vm.exec("apt-get update");
	},
	exactPackageInfoCommand: (query) => `apt-cache show ${shellEscape(query)}`,
	searchPackagesCommand: (query) => `apt-cache search ${shellEscape(query)}`,
	descriptionCommand: (pkg) => `apt-cache show ${shellEscape(pkg)}`,
	parseSearchResults: (stdout) => {
		const results: PackageSearchResult[] = [];
		const seen = new Set<string>();
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
		return undefined;
	},
};

export function formatExecError(result: ExecResult): string {
	return (result.stderr || result.stdout).trim().slice(0, 200);
}
