import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Project root under test. `PI_TODO_ROOT` points the scan at a fixture copy. */
const ROOT = process.env.PI_TODO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HOST_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
const FORBIDDEN_SPECIFIER = /rpiv|juicesharp|node_modules|agent\/npm/;
const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
	"bundledDependencies",
];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

/** Every module specifier: static, re-export, dynamic, and `require` forms. */
function specifiers(source: string): string[] {
	const found: string[] = [];
	for (const m of source.matchAll(/(?:\bfrom|\bimport\s*\(|\brequire\s*\(|\bimport)\s*["']([^"']+)["']/g))
		found.push(m[1]);
	return found;
}

function manifest(): Record<string, any> {
	return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
}

const imported = sourceFiles(join(ROOT, "src")).flatMap((file) => specifiers(readFileSync(file, "utf-8")));
const bare = imported.filter((s) => !s.startsWith(".") && !s.startsWith("node:"));

describe("standalone packaging", () => {
	it("imports no rpiv package, installed-package path, or node_modules path", () => {
		expect(imported.filter((s) => FORBIDDEN_SPECIFIER.test(s))).toEqual([]);
	});

	it("imports only declared host packages from outside the project", () => {
		expect([...new Set(bare)].sort()).toEqual(HOST_PACKAGES.filter((p) => bare.includes(p)).sort());
	});

	it("declares no rpiv package in any dependency field", () => {
		const pkg = manifest();
		const names = DEP_FIELDS.flatMap((field) => {
			const value = pkg[field];
			return Array.isArray(value) ? value : Object.keys(value ?? {});
		});
		expect(names.filter((n) => FORBIDDEN_SPECIFIER.test(n))).toEqual([]);
		expect(Object.keys(pkg.peerDependenciesMeta ?? {}).filter((n) => FORBIDDEN_SPECIFIER.test(n))).toEqual([]);
	});

	it("lists every imported host package as a wildcard peer and nothing else", () => {
		const peers = manifest().peerDependencies ?? {};
		const expected = HOST_PACKAGES.filter((p) => bare.includes(p)).sort();
		expect(Object.keys(peers).sort()).toEqual(expected);
		expect(Object.values(peers).every((range) => range === "*")).toBe(true);
		expect(peers.typebox).toBe("*");
	});

	it("keeps host packages out of runtime dependencies", () => {
		const pkg = manifest();
		for (const field of ["dependencies", "optionalDependencies", "bundledDependencies"]) {
			const value = pkg[field];
			const names = Array.isArray(value) ? value : Object.keys(value ?? {});
			expect(names.filter((n) => HOST_PACKAGES.includes(n))).toEqual([]);
		}
	});

	it("has no private copy of a host package under node_modules", () => {
		const present = HOST_PACKAGES.filter((p) => existsSync(join(ROOT, "node_modules", p)));
		expect(present).toEqual([]);
	});
});
