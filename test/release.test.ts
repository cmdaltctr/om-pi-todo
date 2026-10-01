import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf-8");
const pkg = JSON.parse(read("package.json"));

/** What `npm publish` would upload, according to npm itself. */
function packedFiles(): string[] {
	const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: ROOT,
		encoding: "utf-8",
	});
	return (JSON.parse(out)[0].files as Array<{ path: string }>).map((f) => f.path);
}

describe("the package is ready to publish", () => {
	it("has a public name, a real version and is not private", () => {
		expect(pkg.name).toBe("pi-todo-openspec");
		expect(pkg.private).toBeUndefined();
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.version).not.toBe("0.0.0");
		expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
		expect(pkg.license).toBe("MIT");
	});

	it("is findable as a Pi package", () => {
		expect(pkg.keywords).toContain("pi-package");
		expect(pkg.pi).toEqual({ extensions: ["./src/extension.ts"] });
	});

	it("ships source, docs and licence, and nothing else", () => {
		const files = packedFiles();
		expect(files).toContain("src/extension.ts");
		expect(files).toContain("package.json");
		for (const required of [
			"README.md",
			"LICENSE",
			"NOTICE.md",
			"docs/INSTALL.md",
			"docs/USAGE.md",
			"docs/UNINSTALL.md",
		])
			expect(files, required).toContain(required);
		const allowed = /^(src\/.+\.ts|docs\/[A-Z-]+\.md|README\.md|LICENSE|NOTICE\.md|CHANGELOG\.md|package\.json)$/;
		expect(files.filter((f) => !allowed.test(f))).toEqual([]);
	});

	it("leaves out tests, CI, hooks, tooling config, lock files and local state", () => {
		const files = packedFiles();
		for (const banned of [
			/^test\//,
			/^\.github\//,
			/^\.husky\//,
			/^scripts\//,
			/^\.pi-host/,
			/bun\.lock/,
			/^bunfig/,
			/^tsconfig/,
			/^vitest/,
			/^\.ox/,
			/^AGENTS\.md$/,
			/node_modules/,
			/\.tmp$/,
			/\.DS_Store/,
		]) {
			expect(
				files.filter((f) => banned.test(f)),
				String(banned),
			).toEqual([]);
		}
	});

	it("every file the manifest and the entry import is in the package", () => {
		const files = new Set(packedFiles());
		const seen = new Set<string>();
		const visit = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			expect(files.has(file), `${file} is imported but not packed`).toBe(true);
			const text = read(file);
			for (const m of text.matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
				const target = join(dirname(file), m[1]).replace(/\.js$/, ".ts");
				visit(target);
			}
		};
		for (const entry of pkg.pi.extensions) visit(join("src", entry.replace("./src/", "")));
		expect(seen.size).toBeGreaterThan(20);
	});

	it("needs no runtime dependency, and keeps Pi's packages as wildcard peers", () => {
		expect(pkg.dependencies).toBeUndefined();
		expect(Object.keys(pkg.peerDependencies).sort()).toEqual([
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
			"typebox",
		]);
		for (const range of Object.values(pkg.peerDependencies)) expect(range).toBe("*");
	});

	it("the changelog has an entry for the current version", () => {
		expect(existsSync(join(ROOT, "CHANGELOG.md"))).toBe(true);
		expect(read("CHANGELOG.md")).toMatch(new RegExp(`^## ${pkg.version.replaceAll(".", "\\.")} `, "m"));
	});
});

describe("the release workflow", () => {
	const workflow = read(".github/workflows/release.yml");

	it("runs only on a version tag, and publishes with provenance", () => {
		expect(workflow).toMatch(/tags:\s*\n\s*- "v\*\.\*\.\*"/);
		expect(workflow).not.toMatch(/branches:/);
		expect(workflow).toContain("npm publish --provenance --access public");
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
	});

	it("refuses to publish when the tag and package.json disagree", () => {
		expect(workflow).toContain("GITHUB_REF_NAME");
		expect(workflow).toMatch(/package\.json/);
		expect(workflow).toContain("exit 1");
	});

	it("runs the same gate as CI before it publishes", () => {
		const gate = workflow.indexOf("bun run ci");
		const publish = workflow.indexOf("npm publish");
		expect(gate).toBeGreaterThan(-1);
		expect(publish).toBeGreaterThan(gate);
		expect(workflow).toContain("bun run setup:host");
		expect(workflow).toContain("@fission-ai/openspec@1.13.1");
	});

	it("pins every action to a commit SHA, uses a registry URL and never echoes the token", () => {
		for (const m of workflow.matchAll(/uses:\s*(\S+)/g)) expect(m[1], m[1]).toMatch(/@[0-9a-f]{40}$/);
		expect(workflow).toContain("registry-url: https://registry.npmjs.org");
		expect(workflow).not.toMatch(/echo[^\n]*NPM_TOKEN/);
		expect(workflow).toContain("persist-credentials: false");
	});
});
