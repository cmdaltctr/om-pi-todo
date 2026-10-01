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
	it("has a public name, a semantic version and is not private", () => {
		expect(pkg.name).toBe("pi-todo-openspec");
		expect(pkg.private).toBeUndefined();
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
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

	it("the changelog exists, and has an entry for the current version once one is released", () => {
		expect(existsSync(join(ROOT, "CHANGELOG.md"))).toBe(true);
		const baseline = JSON.parse(read(".release-please-manifest.json"))["."];
		// Release Please writes the entry and bumps the version in one pull request.
		if (pkg.version !== "0.0.0")
			expect(read("CHANGELOG.md")).toMatch(new RegExp(`^## \\[?${pkg.version.replaceAll(".", "\\.")}\\]?[ (]`, "m"));
		expect(baseline).toBe(pkg.version);
	});
});

describe("Release Please is configured", () => {
	const config = JSON.parse(read("release-please-config.json"));
	const manifest = JSON.parse(read(".release-please-manifest.json"));

	it("manages one root Node package, with tags like v0.1.0", () => {
		expect(Object.keys(config.packages)).toEqual(["."]);
		const root = config.packages["."];
		expect(root["release-type"]).toBe("node");
		expect(root["include-component-in-tag"]).toBe(false);
		expect(root["changelog-path"] ?? "CHANGELOG.md").toBe("CHANGELOG.md");
		expect(Object.keys(manifest)).toEqual(["."]);
	});

	it("never forces a version, which would block every later release", () => {
		expect(JSON.stringify(config)).not.toContain("release-as");
	});

	it("does not bump the major version before 1.0.0 for a breaking change", () => {
		expect(config["bump-minor-pre-major"]).toBe(true);
	});
});

describe("the release workflow", () => {
	const workflow = read(".github/workflows/release.yml");

	it("runs on pushes to main only, and hands every release to Release Please", () => {
		expect(workflow).toMatch(/branches:\s*\n\s*- main/);
		expect(workflow).not.toMatch(/tags:/);
		expect(workflow).toContain("googleapis/release-please-action@");
		expect(workflow).toContain("release-please-config.json");
		expect(workflow).toContain(".release-please-manifest.json");
	});

	it("gives each job only the permissions it needs", () => {
		expect(workflow).not.toMatch(/^permissions:\s*\n\s+\S/m); // no workflow-wide grants
		const rp = /release-please:[\s\S]*?publish:/.exec(workflow)![0];
		expect(rp).toMatch(/contents: write/);
		expect(rp).toMatch(/pull-requests: write/);
		expect(rp).not.toContain("id-token");
		const publish = /\n  publish:[\s\S]*$/.exec(workflow)![0];
		expect(publish).toMatch(/contents: read/);
		expect(publish).toContain("id-token: write");
		expect(publish).not.toContain("contents: write");
	});

	it("publishes only when a release was created, from the release tag", () => {
		expect(workflow).toContain("needs: release-please");
		expect(workflow).toMatch(/if: \$\{\{ needs\.release-please\.outputs\.release_created == 'true' \}\}/);
		expect(workflow).toContain("ref: ${{ needs.release-please.outputs.tag_name }}");
	});

	it("refuses to publish a placeholder version or a tag that disagrees with package.json", () => {
		expect(workflow).toContain("needs.release-please.outputs.tag_name");
		expect(workflow).toMatch(/if \[ "\$\{version\}" = "0\.0\.0" \]; then\s*\n[^\n]*\n\s*exit 1/);
		expect(workflow).toMatch(/if \[ "\$\{TAG\}" != "v\$\{version\}" \]; then\s*\n[^\n]*\n\s*exit 1/);
	});

	it("runs the same gate as CI before it publishes, with provenance", () => {
		const gate = workflow.indexOf("bun run ci");
		const publish = workflow.indexOf("npm publish");
		expect(gate).toBeGreaterThan(-1);
		expect(publish).toBeGreaterThan(gate);
		expect(workflow).toContain("bun run setup:host");
		expect(workflow).toContain("@fission-ai/openspec@1.13.1");
		expect(workflow).toContain("npm publish --provenance --access public");
		expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
	});

	it("pins every action to a commit SHA, uses the registry URL and never echoes the token", () => {
		for (const m of workflow.matchAll(/uses:\s*(\S+)/g)) expect(m[1], m[1]).toMatch(/@[0-9a-f]{40}$/);
		expect(workflow).toContain("registry-url: https://registry.npmjs.org");
		expect(workflow).not.toMatch(/echo[^\n]*NPM_TOKEN/);
		expect(workflow).toContain("persist-credentials: false");
	});
});
