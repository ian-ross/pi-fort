import { describe, expect, it } from "vitest";
import { parseFortArgs } from "../src/index.js";

describe("parseFortArgs", () => {
	it("parses shell-style quoted paths", () => {
		expect(parseFortArgs('mount "host path" "/mnt/guest path"')).toEqual(["mount", "host path", "/mnt/guest path"]);
	});

	it("supports backslash escapes", () => {
		expect(parseFortArgs("mount host\\ path /mnt/data")).toEqual(["mount", "host path", "/mnt/data"]);
	});

	it("rejects unterminated quotes", () => {
		expect(() => parseFortArgs('mount "oops')).toThrow("Unterminated quote");
	});
});
