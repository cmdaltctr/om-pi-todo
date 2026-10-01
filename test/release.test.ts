import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf-8");
const pkg = JSON.parse(read("package.json"));

/**
 * The JSON part of `npm pack --json` output. npm 10 runs the `prepare` script even with
 * `--ignore-scripts`, and Husky then prints a line such as `HUSKY=0 skip install` ahead of the JSON.
 */
export function packJson(out: string): Array<{ files: Array<{ path: string }> }> {
	const start = out.indexOf("[\n");
	if (start === -1) throw new Error(`npm pack printed no JSON: ${out.slice(0, 200)}`);
	return JSON.parse(out.slice(start));
}

/** What `npm publish` would upload, according to npm itself. */
function packedFiles(): string[] {
	const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: ROOT,
		encoding: "utf-8",
	});
	return packJson(out)[0].files.map((f) => f.path);
}

describe("reading npm pack output", () => {
	const json = '[\n  {\n    "files": [{ "path": "src/a.ts" }]\n  }\n]\n';

	it("reads clean output", () => {
		expect(packJson(json)[0].files).toEqual([{ path: "src/a.ts" }]);
	});

	it("reads output with a script's message printed in front of it, with or without a newline", () => {
		expect(packJson(`HUSKY=0 skip install${json}`)[0].files).toHaveLength(1);
		expect(packJson(`> prepare\n> husky || true\n\nsome notice\n${json}`)[0].files).toHaveLength(1);
	});

	it("fails loudly, with the text it saw, when there is no JSON", () => {
		expect(() => packJson("npm error something broke")).toThrow(/printed no JSON: npm error something broke/);
	});
});

describe("the package is ready to publish", () => {
	it("has a public name, a semantic version and is not private", () => {
		expect(pkg.name).toBe("om-pi-todo");
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
	const releaseJob = /\n  release-please:[\s\S]*?\n  publish:/.exec(workflow)![0];
	const publishJob = /\n  publish:[\s\S]*$/.exec(workflow)![0];

	it("runs on pushes to main only, and hands every release to Release Please", () => {
		expect(workflow).toMatch(/branches:\s*\n\s*- main/);
		expect(workflow).not.toMatch(/tags:/);
		expect(workflow).toContain("googleapis/release-please-action@");
		expect(workflow).toContain("release-please-config.json");
		expect(workflow).toContain(".release-please-manifest.json");
	});

	it("stays off until the repository variable switches it on, so a missing secret cannot fail every push", () => {
		expect(releaseJob).toContain("if: ${{ vars.RELEASE_PLEASE_ENABLED == 'true' }}");
	});

	it("signs in as the release GitHub App, so release pull requests start the CI checks", () => {
		expect(releaseJob).toContain("actions/create-github-app-token@");
		expect(releaseJob).toContain("client-id: ${{ secrets.RELEASE_APP_ID }}");
		expect(releaseJob).toContain("private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}");
		expect(releaseJob).toContain("token: ${{ steps.app-token.outputs.token }}");
	});

	it("uses no npm token anywhere", () => {
		expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
		expect(workflow).not.toMatch(/secrets\.NPM/);
	});

	it("gives each job only the permissions it needs, and none for the whole workflow", () => {
		expect(workflow).toMatch(/^permissions:\s*\n\s+contents: read\s*$/m);
		expect(releaseJob).not.toMatch(/write/);
		expect(releaseJob).not.toContain("id-token");
		expect(publishJob).toContain("contents: write"); // to add the approval note to the GitHub Release
		expect(publishJob).toContain("id-token: write"); // npm trusted publishing (OIDC)
		expect(publishJob).not.toMatch(/pull-requests|packages: write|actions: write/);
	});

	it("publishes only when a release was created, in the protected npm-publish environment", () => {
		expect(publishJob).toContain("needs: release-please");
		expect(publishJob).toMatch(/if: \$\{\{ needs\.release-please\.outputs\.release_created == 'true' \}\}/);
		expect(publishJob).toContain("environment: npm-publish");
	});

	it("builds exactly the release commit, not whatever main has become", () => {
		expect(releaseJob).toContain("sha: ${{ steps.release.outputs.sha }}");
		expect(publishJob).toContain("ref: ${{ needs.release-please.outputs.sha }}");
		expect(publishJob).not.toContain("ref: main");
	});

	it("stages the version on npm for approval, never publishing it directly", () => {
		expect(publishJob).toContain("npm stage publish --access public");
		expect(workflow).not.toMatch(/npm publish/);
		expect(publishJob).toContain("npm install -g npm@^11.15.0");
		expect(publishJob).toContain("2FA");
		expect(publishJob).toContain("npm stage approve");
	});

	it("refuses a placeholder version or a version that disagrees with the release", () => {
		expect(publishJob).toMatch(/if \[ "\$\{PACKAGE_VERSION\}" = "0\.0\.0" \]; then\s*\n[^\n]*\n\s*exit 1/);
		expect(publishJob).toMatch(
			/if \[ "\$\{PACKAGE_VERSION\}" != "\$\{RELEASE_VERSION\}" \]; then\s*\n[^\n]*\n\s*exit 1/,
		);
		expect(publishJob).toContain("RELEASE_VERSION: ${{ needs.release-please.outputs.version }}");
	});

	it("runs the same gate as CI before it stages anything", () => {
		const gate = publishJob.indexOf("bun run ci");
		const stage = publishJob.indexOf("npm stage publish");
		expect(gate).toBeGreaterThan(-1);
		expect(stage).toBeGreaterThan(gate);
		expect(publishJob).toContain("bun run setup:host");
		expect(publishJob).toContain("@fission-ai/openspec@1.13.1");
	});

	it("pins every action to a commit SHA, uses the registry URL and keeps no credentials on disk", () => {
		for (const m of workflow.matchAll(/uses:\s*(\S+)/g)) expect(m[1], m[1]).toMatch(/@[0-9a-f]{40}$/);
		expect(workflow).toContain("registry-url: https://registry.npmjs.org");
		expect(workflow).toContain("persist-credentials: false");
	});
});
