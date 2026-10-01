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
const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
const blocks = [...readme.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], text: m[2].trim() }));
const json = blocks.filter((b) => b.lang === "json");
const isCall = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && "action" in v;
const calls = json.map((b) => JSON.parse(b.text.startsWith("{") || b.text.startsWith("[") ? b.text : `[${b.text}]`)).filter(isCall);

describe("README examples match the product", () => {
	it("every JSON example parses", () => {
		expect(json.length).toBeGreaterThanOrEqual(8);
		for (const b of json) expect(() => JSON.parse(b.text.startsWith("{") || b.text.startsWith("[") ? b.text : `[${b.text}]`), b.text).not.toThrow();
	});

	it("every tool call example uses only real parameters and a real action, and fits the schema", () => {
		const props = Object.keys((TodoParamsSchema as any).properties);
		const actions = (TodoParamsSchema as any).properties.action.enum as string[];
		expect(calls.length).toBe(6);
		for (const call of calls) {
			expect(actions).toContain(call.action);
			for (const key of Object.keys(call)) expect(props, key).toContain(key);
		}
	});

	it("each example behaves as the README says through the real tool", async () => {
		const host = createHost();
		registerTodoTool(host.pi);
		const ctx = createCtx("s1", []);
		const ex = (n: number) => calls[n];
		expect((await callTool(host, ctx, ex(0))).text).toBe("Created #1: Write tests (pending)");
		await callTool(host, ctx, { action: "create", subject: "Second" });
		expect((await callTool(host, ctx, { ...ex(4), id: 2 })).text).toBe("Updated #2");
		expect(getState("s1").tasks[1].waitingReason).toBe("approval from the owner");
		expect((await callTool(host, ctx, { ...ex(5), id: 2 })).text).toBe("Updated #2");
		expect(getState("s1").tasks[1].waitingReason).toBeUndefined();
	});

	it("the incidental example is accepted in sync mode and refused in normal mode wording", async () => {
		setSessionMode("sync", { mode: "openspec", binding: { root: "/none", change: "a" } });
		const runtime = createRuntime({ getOrdinary: (id) => getState(id).tasks, run: async () => ({ ok: false, kind: "spawn", message: "none" }) });
		const host = createHost();
		registerTodoTool(host.pi, runtime);
		const example = calls.find((v) => v.scope === "incidental")!;
		expect((await callTool(host, createCtx("sync", []), example)).text).toBe("Created #1: Debug flaky test (pending) [incidental]");
		runtime.stopAll();
	});

	it("every slash command in the README is registered, and no unregistered one appears", () => {
		const host = createHost();
		registerTodosCommand(host.pi);
		registerTodoSettingsCommand(host.pi, async () => ({ ok: false, error: "x" }));
		const mentioned = new Set([...readme.matchAll(/`\/([a-z-]+)(?: [a-z]+)?`/g)].map((m) => m[1]));
		// The only subcommand the README documents is `refresh`.
		const subcommands = [...readme.matchAll(/`\/todos ([a-z]+)`/g)].map((m) => m[1]);
		expect(new Set(subcommands)).toEqual(new Set(["refresh"]));
		for (const name of mentioned) expect([...host.commands.keys()], name).toContain(name);
		expect(mentioned).toEqual(new Set(["todos", "todo-settings"]));
	});

	it("the documented `/todos refresh` argument is the one the command accepts", async () => {
		const host = createHost();
		registerTodosCommand(host.pi);
		const notes: string[] = [];
		await host.commands.get("todos").handler("refresh", createCtx("s1", [], { hasUI: true, ui: { notify: (m: string) => notes.push(m) } }));
		expect(notes).toEqual(["Todo panel refreshed."]); // the argument is recognised: it does not fall through to the list view
	});

	it("the /todo-settings menu offers the four settings the README names", async () => {
		await refreshPreferences();
		const host = createHost();
		registerTodoSettingsCommand(host.pi, async () => ({ ok: false, error: "x" }));
		const script = scriptedUi({ select: ["Done"] });
		await host.commands.get("todo-settings").handler("", createCtx("s1", [], { hasUI: true, ui: script.ui }));
		const options = script.calls[0].args[1] as string[];
		for (const label of ["Session mode", "Default mode for new sessions", "Panel line budget", "Collapse key"]) expect(options.some((o) => o.startsWith(label)), label).toBe(true);
	});

	it("the panel marks the README names are the marks the product uses", () => {
		const src = ["src/todo-overlay.ts", "src/view/format.ts", "src/view/presentation.ts"].map((f) => readFileSync(join(ROOT, f), "utf-8")).join("\n");
		for (const mark of ["⚠", "↻", "Idle", "Paused", "Blocked by", "all completed", "OpenSpec", "incidental"]) expect(src, mark).toContain(mark);
	});

	it("the settings snippets have the shapes Pi documents", () => {
		const objectForm = json.map((b) => b.text).find((t) => t.includes('"extensions": []'))!;
		expect(JSON.parse(objectForm)).toEqual({ source: "npm:@juicesharp/rpiv-todo", extensions: [] });
		const original = blocks.find((b) => b.text === '"npm:@juicesharp/rpiv-todo"')!;
		expect(JSON.parse(`[${original.text}]`)).toEqual(["npm:@juicesharp/rpiv-todo"]);
	});

	it("the activation record names a real entry file and the manifest declares it", () => {
		expect(existsSync(join(ROOT, "src/extension.ts"))).toBe(true);
		expect(readme).toContain('"pi": { "extensions": ["./src/extension.ts"] }');
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
		expect(pkg.pi).toEqual({ extensions: ["./src/extension.ts"] }); // the entry the README documents
		for (const entry of pkg.pi.extensions) expect(existsSync(join(ROOT, entry)), entry).toBe(true);
		expect(readme).toContain("## Activation");
		expect(readme).toContain("Done on 2026-10-01");
	});

	it("the host peers it lists are exactly the declared peers", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
		const sentence = /It needs these host packages[^:]*: ([^.]*)\./.exec(readme)![1];
		const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
		expect(new Set(listed)).toEqual(new Set(Object.keys(pkg.peerDependencies)));
		expect(listed).toHaveLength(Object.keys(pkg.peerDependencies).length);
	});

	it("the limits it states are enforced by the code", async () => {
		const lock = await import("../src/openspec/lock.js");
		expect(lock.lockPathFor("/x/tasks.md")).toBe("/x/tasks.md.pi-todo.lock");
		expect(readme).toContain("tasks.md.pi-todo.lock");
		const { preferencesPath } = await import("../src/preferences.js");
		expect(preferencesPath().endsWith(join("pi-todo", "config.json"))).toBe(true);
		expect(readme).toContain("~/.config/pi-todo/config.json");
		const { checkStatus } = await import("../src/openspec/discover.js");
		const other = checkStatus({ schemaName: "custom", changeRoot: "/r/c", artifactPaths: { tasks: { existingOutputPaths: ["/r/c/tasks.md"] } }, root: { path: "/r" } }, { path: "/r" });
		expect(other).toMatchObject({ supported: false, reason: expect.stringContaining("spec-driven") });
	});
});
