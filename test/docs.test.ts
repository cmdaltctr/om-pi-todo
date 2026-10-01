import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TodoParamsSchema } from "../src/tool/types.js";
import { registerTodosCommand, registerTodoTool } from "../src/todo.js";
import { registerTodoSettingsCommand } from "../src/settings.js";
import { createRuntime } from "../src/sync/runtime.js";
import { callTool, createCtx, createHost, scriptedUi, useCleanEnvironment } from "./helpers.js";
import { setSessionMode } from "../src/session-mode.js";
import { getState } from "../src/state/store.js";
import { refreshPreferences } from "../src/preferences.js";

useCleanEnvironment();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf-8");
const readme = read("README.md");
const install = read("docs/INSTALL.md");
const usage = read("docs/USAGE.md");
const uninstall = read("docs/UNINSTALL.md");
const all = [readme, install, usage, uninstall].join("\n");
const pkg = JSON.parse(read("package.json"));

const blocks = [...all.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], text: m[2].trim() }));
const json = blocks.filter((b) => b.lang === "json");
const parse = (text: string) => JSON.parse(text.startsWith("{") || text.startsWith("[") ? text : `[${text}]`);
const isCall = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && "action" in v;
const calls = json.map((b) => parse(b.text)).filter(isCall);
const REPO = "github.com/cmdaltctr/ompts-todo";
const OLD_REPO_NAME = "opinionated-modular-pi-todo-system-ompts";

describe("tool examples in the docs match the product", () => {
	it("every JSON example parses", () => {
		expect(json.length).toBeGreaterThanOrEqual(8);
		for (const b of json) expect(() => parse(b.text), b.text).not.toThrow();
	});

	it("every tool call uses only real parameters and a real action", () => {
		const props = Object.keys((TodoParamsSchema as any).properties);
		const actions = (TodoParamsSchema as any).properties.action.enum as string[];
		expect(calls).toHaveLength(6);
		for (const call of calls) {
			expect(actions).toContain(call.action);
			for (const key of Object.keys(call)) expect(props, key).toContain(key);
		}
	});

	it("each example behaves as the docs say through the real tool", async () => {
		const host = createHost();
		registerTodoTool(host.pi);
		const ctx = createCtx("s1", []);
		expect((await callTool(host, ctx, calls[0])).text).toBe("Created #1: Write tests (pending)");
		await callTool(host, ctx, { action: "create", subject: "Second" });
		expect((await callTool(host, ctx, { ...calls[4], id: 2 })).text).toBe("Updated #2");
		expect(getState("s1").tasks[1].waitingReason).toBe("approval from the owner");
		expect((await callTool(host, ctx, { ...calls[5], id: 2 })).text).toBe("Updated #2");
		expect(getState("s1").tasks[1].waitingReason).toBeUndefined();
	});

	it("the incidental example is accepted in sync mode", async () => {
		setSessionMode("sync", { mode: "openspec", binding: { root: "/none", change: "a" } });
		const runtime = createRuntime({
			getOrdinary: (id) => getState(id).tasks,
			run: async () => ({ ok: false, kind: "spawn", message: "none" }),
		});
		const host = createHost();
		registerTodoTool(host.pi, runtime);
		const example = calls.find((v) => v.scope === "incidental")!;
		expect((await callTool(host, createCtx("sync", []), example)).text).toBe(
			"Created #1: Debug flaky test (pending) [incidental]",
		);
		runtime.stopAll();
	});
});

describe("commands and menus in the docs match the product", () => {
	it("every slash command named is ours or Pi's /reload, and each of ours is registered", () => {
		const host = createHost();
		registerTodosCommand(host.pi);
		registerTodoSettingsCommand(host.pi, async () => ({ ok: false, error: "x" }));
		const mentioned = new Set([...all.matchAll(/`\/([a-z-]+)(?: [a-z]+)?`/g)].map((m) => m[1]));
		mentioned.delete("reload");
		for (const name of mentioned) expect([...host.commands.keys()], name).toContain(name);
		expect(mentioned).toEqual(new Set(["todos", "todo-settings"]));
		expect(new Set([...all.matchAll(/`\/todos ([a-z]+)`/g)].map((m) => m[1]))).toEqual(new Set(["refresh"]));
	});

	it("`/todos refresh` is recognised by the command", async () => {
		const host = createHost();
		registerTodosCommand(host.pi);
		const notes: string[] = [];
		await host.commands
			.get("todos")
			.handler("refresh", createCtx("s1", [], { hasUI: true, ui: { notify: (m: string) => notes.push(m) } }));
		expect(notes).toEqual(["Todo panel refreshed."]);
	});

	it("the settings menu offers the four settings the guide names", async () => {
		await refreshPreferences();
		const host = createHost();
		registerTodoSettingsCommand(host.pi, async () => ({ ok: false, error: "x" }));
		const script = scriptedUi({ select: ["Done"] });
		await host.commands.get("todo-settings").handler("", createCtx("s1", [], { hasUI: true, ui: script.ui }));
		const options = script.calls[0].args[1] as string[];
		for (const label of ["Session mode", "Default mode for new sessions", "Panel line budget", "Collapse key"]) {
			expect(
				options.some((o) => o.startsWith(label)),
				label,
			).toBe(true);
			expect(usage, label).toContain(`**${label}**`);
		}
	});

	it("the marks the guide explains are marks the product draws", () => {
		const src = ["src/todo-overlay.ts", "src/view/format.ts", "src/view/presentation.ts"].map(read).join("\n");
		for (const mark of [
			"⚠",
			"↻",
			"Idle",
			"Paused",
			"Blocked by",
			"all completed",
			"OpenSpec",
			"incidental",
			"completed hidden",
		]) {
			expect(src, mark).toContain(mark);
		}
		for (const mark of ["⚠ stale", "↻", "`Idle`", "`Paused`", "Blocked by #3", "all completed"])
			expect(usage, mark).toContain(mark);
	});

	it("the limits and file names it states are enforced by the code", async () => {
		const { lockPathFor } = await import("../src/openspec/lock.js");
		expect(lockPathFor("/x/tasks.md")).toBe("/x/tasks.md.pi-todo.lock");
		expect(usage).toContain("tasks.md.pi-todo.lock");
		const { preferencesPath } = await import("../src/preferences.js");
		expect(preferencesPath().endsWith(join("pi-todo", "config.json"))).toBe(true);
		expect(usage).toContain("~/.config/pi-todo/config.json");
		expect(uninstall).toContain("~/.config/pi-todo/config.json");
		const { checkStatus } = await import("../src/openspec/discover.js");
		const other = checkStatus(
			{
				schemaName: "custom",
				changeRoot: "/r/c",
				artifactPaths: { tasks: { existingOutputPaths: ["/r/c/tasks.md"] } },
				root: { path: "/r" },
			},
			{ path: "/r" },
		);
		expect(other).toMatchObject({ supported: false, reason: expect.stringContaining("spec-driven") });
		expect(usage).toContain("`spec-driven`");
	});
});

describe("the agent snippet in the README is accurate", () => {
	const snippet = /```markdown\n([\s\S]*?)```/.exec(readme)![1];

	it("every tool field and action it names exists", () => {
		const props = Object.keys((TodoParamsSchema as any).properties);
		const actions = (TodoParamsSchema as any).properties.action.enum as string[];
		const statuses = (TodoParamsSchema as any).properties.status.enum as string[];
		for (const field of ["expectedRevision", "scope", "reason", "waitingReason", "failureReason"]) {
			expect(snippet, field).toMatch(new RegExp(`\`${field}[\`:]`));
			expect(props, field).toContain(field);
		}
		expect(actions).toEqual(expect.arrayContaining(["list", "get"]));
		for (const status of ["in_progress", "completed"]) expect(statuses).toContain(status);
		expect(snippet).toContain('`scope: "incidental"`');
	});

	it("the rules it gives are rules the tool's own guidance gives", async () => {
		const { DEFAULT_PROMPT_GUIDELINES } = await import("../src/todo.js");
		const guidance = DEFAULT_PROMPT_GUIDELINES.join("\n");
		expect(guidance).toContain("expectedRevision");
		expect(guidance).toContain('scope "incidental"');
		expect(guidance).toContain("waitingReason");
		expect(guidance).toContain("never paraphrase a plan task");
		expect(guidance).toMatch(/not proof that tests passed/);
	});

	it("is short enough to paste", () => {
		expect(snippet.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(7);
		expect(snippet.split(/\s+/).length).toBeLessThan(200);
	});
});

describe("install and uninstall guides match the package", () => {
	it("the npm install and remove commands name the published package, in every guide", () => {
		expect(readme).toContain(`pi install npm:${pkg.name}`);
		expect(install).toContain(`pi install npm:${pkg.name}`);
		expect(uninstall).toContain(`pi remove npm:${pkg.name}`);
		expect(install).toMatch(new RegExp(`pi install npm:${pkg.name}@\\d+\\.\\d+\\.\\d+`));
	});

	it("the git install command is the same everywhere and matches package.json", () => {
		const command = `pi install git:${REPO}`;
		expect(install).toContain(command);
		expect(readme).toContain("(docs/INSTALL.md)"); // the README sends GitHub installs to the guide
		expect(uninstall).toContain(`pi remove git:${REPO}`);
		expect(pkg.repository.url).toBe(`git+https://${REPO}.git`);
		expect(install).toContain(`git clone https://${REPO}.git`);
	});

	it("the manifest declares an entry file that exists", () => {
		expect(pkg.pi).toEqual({ extensions: ["./src/extension.ts"] });
		for (const entry of pkg.pi.extensions) expect(existsSync(join(ROOT, entry)), entry).toBe(true);
	});

	it("the rpiv-todo settings snippets have the shapes Pi documents", () => {
		const objects = json.map((b) => b.text).filter((t) => t.includes('"extensions": []'));
		expect(objects).toHaveLength(2); // once to disable, once shown again to restore
		for (const o of objects) expect(JSON.parse(o)).toEqual({ source: "npm:@juicesharp/rpiv-todo", extensions: [] });
		const plain = json.map((b) => b.text).filter((t) => t === '"npm:@juicesharp/rpiv-todo"');
		expect(plain).toHaveLength(2);
	});

	it("the requirements it states are declared", () => {
		expect(readme).toContain("Node.js 22");
		expect(pkg.engines.node).toBe(">=22");
		expect(readme).toContain("1.13.1");
		expect(read(".github/workflows/ci.yml")).toContain("@fission-ai/openspec@1.13.1");
		expect(readme).toContain("0.99.1");
		expect(read("scripts/setup-host.sh")).toContain('PI_HOST_VERSION="${PI_HOST_VERSION:-0.99.1}"');
	});

	it("the host packages it lists are exactly the declared peers", () => {
		const sentence = /Pi supplies these host packages[^:]*: ([^.]*)\./.exec(readme)![1];
		const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
		expect(new Set(listed)).toEqual(new Set(Object.keys(pkg.peerDependencies)));
		expect(listed).toHaveLength(Object.keys(pkg.peerDependencies).length);
	});

	it("every doc the README links to exists", () => {
		const links = [...readme.matchAll(/\]\(([\w./-]+\.md)\)/g)].map((m) => m[1]);
		expect(links.length).toBeGreaterThanOrEqual(5);
		for (const link of links) expect(existsSync(join(ROOT, link)), link).toBe(true);
	});

	it("the licence file is MIT and keeps the upstream notice", () => {
		const licence = read("LICENSE");
		expect(licence.startsWith("MIT License")).toBe(true);
		expect(licence).toContain("juicesharp");
		expect(pkg.license).toBe("MIT");
	});
});

describe("the local gate, the hook and CI run the same steps", () => {
	it("package.json ci runs lint, types and tests, and the hook runs ci", () => {
		for (const step of ["bun run format:check", "bun run lint", "bun run typecheck", "bun run test"])
			expect(pkg.scripts.ci, step).toContain(step);
		expect(pkg.scripts["ci:clean"]).toBe("./scripts/ci-clean.sh");
		expect(read(".husky/pre-push")).toContain("bun run ci:clean");
	});

	it("ci:clean tests a fresh clone installed from the lockfile with Husky off, like CI", () => {
		const script = read("scripts/ci-clean.sh");
		expect(script).toContain("git clone");
		expect(script).toContain("bun install --frozen-lockfile");
		expect(script).toContain("export HUSKY=0");
		expect(script).toContain("bun run ci");
		expect(read(".github/workflows/ci.yml")).toContain('HUSKY: "0"');
	});

	it("ci:clean warns when this machine's Node major differs from the one CI uses", () => {
		const script = read("scripts/ci-clean.sh");
		expect(script).toContain(".github/workflows/ci.yml");
		expect(script).toContain("node-version");
		expect(script).toMatch(/warning:.*Node/);
		const ciNode = /node-version:\s*(\d+)/.exec(read(".github/workflows/ci.yml"))![1];
		expect(Number(ciNode)).toBeGreaterThan(0);
		// A warning, never a failure: it must not stop a push.
		expect(script).not.toMatch(/warning:[^\n]*\n\s*exit/);
	});

	it("the workflow runs the same three steps and installs from the lockfile", () => {
		const workflow = read(".github/workflows/ci.yml");
		for (const step of [
			"bun run format:check",
			"bun run lint",
			"bun run typecheck",
			"bun run test",
			"bun run setup:host",
			"bun install --frozen-lockfile",
		]) {
			expect(workflow, step).toContain(step);
		}
		expect(workflow).toContain("permissions:\n  contents: read");
	});

	it("every action in the workflow is pinned to a full commit SHA", () => {
		const uses = [...read(".github/workflows/ci.yml").matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
		expect(uses.length).toBeGreaterThanOrEqual(4);
		for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
	});

	it("a plain install adds no private copy of a Pi host package", () => {
		expect(read("bunfig.toml")).toMatch(/^peer = false$/m);
	});

	it("the hook is installed through a prepare script that cannot break a plain install", () => {
		expect(pkg.scripts.prepare).toBe("husky || true");
	});
});

describe("the release steps in the README match the repository", () => {
	const section = /## Release \(maintainers\)([\s\S]*?)## Tooling you can copy/.exec(readme)![1];
	const workflow = read(".github/workflows/release.yml");

	it("name the real package and the commands the maintainer runs", () => {
		expect(section).toContain(pkg.name);
		expect(section).toContain("Release Please");
		expect(section).toContain("npm stage list pi-todo-openspec");
		expect(section).toContain("npm stage approve <stage-id>");
		expect(workflow).toContain("npm stage publish");
		expect(workflow).toContain("npm stage approve");
	});

	it("use the same names for secrets, variable, environment and workflow as the workflow does", () => {
		for (const name of ["RELEASE_APP_ID", "RELEASE_APP_PRIVATE_KEY"]) {
			expect(section, name).toContain(name);
			expect(workflow, name).toContain(`secrets.${name}`);
		}
		expect(section).toContain("RELEASE_PLEASE_ENABLED");
		expect(workflow).toContain("vars.RELEASE_PLEASE_ENABLED");
		expect(section).toContain("--env npm-publish");
		expect(workflow).toContain("environment: npm-publish");
		expect(section).toContain("--file release.yml");
		expect(section).toContain(`--repo ${REPO.replace("github.com/", "")}`);
		expect(section).toContain("--allow-stage-publish");
	});

	it("say there is no npm token, and the workflow has none", () => {
		expect(section).toContain("No npm token is used");
		expect(section).not.toContain("NPM_TOKEN");
		expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
		expect(read("AGENTS.md")).toContain("There is no npm token");
	});

	it("tell maintainers not to edit the files Release Please owns, and the agent guide agrees", () => {
		expect(section).toContain("You never edit the version or the changelog by hand");
		expect(read("AGENTS.md")).toContain("Never edit `version` in `package.json`");
		expect(read("AGENTS.md")).toContain("Never run `npm publish`");
	});

	it("the version table matches the config", () => {
		const config = JSON.parse(read("release-please-config.json"));
		expect(config["bump-minor-pre-major"]).toBe(true);
		expect(section).toMatch(/`feat!:`[^|]*\|\s*Minor/);
	});
});

describe("the tooling section in the README matches the repository", () => {
	const section = /## Tooling you can copy([\s\S]*?)## Licence/.exec(readme)![1];

	it("every file it names exists", () => {
		for (const file of [
			".oxlintrc.json",
			".oxfmtrc.json",
			"tsconfig.json",
			"vitest.config.ts",
			".husky/pre-push",
			"scripts/ci-clean.sh",
			"scripts/setup-host.sh",
			".github/workflows/ci.yml",
			"bunfig.toml",
			"bun.lock",
		]) {
			expect(section, file).toContain(file);
			expect(existsSync(join(ROOT, file)), file).toBe(true);
		}
	});

	it("every script it names is a package script, and each tool it names is installed", () => {
		for (const script of ["ci:clean", "audit"]) {
			expect(section).toContain(`\`${script}\``);
			expect(pkg.scripts[script], script).toBeDefined();
		}
		for (const dev of ["oxlint", "oxfmt", "husky", "typescript", "vitest"])
			expect(pkg.devDependencies[dev], dev).toBeDefined();
	});
});

describe("the project is named the OMMS way", () => {
	it("the README title spells out the acronym, as OMMS does", () => {
		expect(readme.split("\n")[0]).toBe("# OMPTS: Opinionated Modular Pi Todo System");
	});

	it("the package and the repository describe it in the same words, and mention OpenSpec", () => {
		expect(pkg.description).toBe("Opinionated modular todo system for Pi, with OpenSpec task sync");
		expect(pkg.description).toMatch(/OpenSpec/);
		expect(pkg.homepage).toBe(`https://${REPO}#readme`);
		expect(pkg.bugs.url).toBe(`https://${REPO}/issues`);
		expect(pkg.repository.url).toBe(`git+https://${REPO}.git`);
	});

	it("the old repository name appears nowhere in the project", () => {
		for (const f of [
			"README.md",
			"AGENTS.md",
			"CHANGELOG.md",
			"package.json",
			"bun.lock",
			"docs/INSTALL.md",
			"docs/UNINSTALL.md",
			"docs/USAGE.md",
			"docs/VERIFICATION.md",
			".github/workflows/ci.yml",
			".github/workflows/release.yml",
		]) {
			expect(read(f), f).not.toContain(OLD_REPO_NAME);
		}
	});

	it("the uninstall guide shows the folder a clone creates", () => {
		expect(uninstall).toContain("/full/path/to/ompts-todo");
		expect(install).toContain("cd ompts-todo");
	});
});

describe("the repository holds nothing personal", () => {
	it("no tracked doc, config or script names a home directory", () => {
		const files = [
			"README.md",
			"AGENTS.md",
			"NOTICE.md",
			"docs/INSTALL.md",
			"docs/USAGE.md",
			"docs/UNINSTALL.md",
			"docs/VERIFICATION.md",
			"tsconfig.json",
			"vitest.config.ts",
			"package.json",
			"scripts/setup-host.sh",
			".github/workflows/ci.yml",
			".husky/pre-push",
		];
		for (const f of files) expect(read(f), f).not.toMatch(/\/Users\/|\/home\/[a-z]+\/|\.pi-backups/);
	});
});
