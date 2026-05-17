import { defineConfig } from "vitest/config";

export default defineConfig({
	cacheDir: ".vitest",
	test: {
		include: ["test/**/*.test.ts"],
	},
});
