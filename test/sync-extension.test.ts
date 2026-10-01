import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import extension from "../src/extension.js";
import { getSessionMode } from "../src/session-mode.js";
import { makeFakeCli } from "./fake-cli.js";
import { callTool, createCtx, createHost, scriptedUi, sessionEntry, useCleanEnvironment } from "./helpers.js";
import { md, useSyncRoot } from "./sync-harness.js";

useCleanEnvironment();
const paths = useSyncRoot();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A theme whose every styling call returns the plain text. */
const theme: any = new Proxy({}, { get: (_t, key) => (key === "fg" || key === "bg" ? (_c: string, text: string) => text : (text: string) => text) });

async function boot(content: string) {
	writeFileSync(paths.tasksPath, content);
	const cli = makeFakeCli({ root: paths.root, change: "a", tasksPath: paths.tasksPath, changeRoot: paths.changeRoot });
	const watches: Array<{ closed: boolean; fire: () => void }> = [];
	const host = createHost();
	await extension(
		host.pi,
		undefined,
		async () => ({ ok: true, root: paths.root, rootSource: "nearest", changes: [{ name: "a", supported: true }] }),
		{
			run: cli.run as any,
			watchDelayMs: 20,
			lock: { waitMs: 200, pollMs: 10 },
			watch: (_file, onChange) => {
				const w = { closed: false, fire: onChange };
				watches.push(w);
				return { close: () => void (w.closed = true) };
			},
		},
	);
	const widgets = new Map<string, any>();
	const notes: string[] = [];
	const uiFor = (extra: Record<string, unknown> = {}) => ({
		setWidget: (key: string, factory: unknown) => void (factory === undefined ? widgets.delete(key) : widgets.set(key, factory)),
		notify: (m: string) => void notes.push(m),
		theme,
		...extra,
	});
	const bound = [sessionEntry({ mode: "openspec", binding: { root: paths.root, change: "a" } })];
	const session = (id = "s1", branch: unknown[] = bound, ui: Record<string, unknown> = {}) => createCtx(id, branch, { hasUI: true, cwd: paths.root, ui: uiFor(ui) });
	const fire = (event: string, ctx: unknown, payload: unknown = {}) => Promise.all((host.handlers.get(event) ?? []).map((h) => h(payload, ctx)));
	const panel = () => {
		const factory = widgets.get("rpiv-todos");
		return factory ? (factory({ requestRender() {} }, theme).render(100) as string[]).filter((l) => l !== "") : undefined;
	};
	const settle = async () => {
		await sleep(40);
		await sleep(40);
	};
	return { host, cli, watches, widgets, notes, session, fire, panel, settle };
}

describe("session lifecycle in sync mode", () => {
	it("a bound session starts reading on session_start and the panel shows the linked tasks", async () => {
		const t = await boot(md("- [x] 1.1 Done", "- [ ] 1.2 Open"));
		await t.fire("session_start", t.session());
		await t.settle();
		const lines = t.panel()!;
		expect(lines[0]).toBe("● Todos · OpenSpec 1/2");
		expect(lines.join("\n")).toContain("1.1 Done");
		expect(lines.join("\n")).toContain("1.2 Open");
		expect(t.watches.filter((w) => !w.closed)).toHaveLength(1);
	});

	it("an unbound sync session shows the selection warning and an empty panel, and reads nothing", async () => {
		const t = await boot(md("- [ ] A"));
		await t.fire("session_start", t.session("s1", [sessionEntry({ mode: "openspec" })]));
		await t.settle();
		expect(t.notes).toEqual(["OpenSpec sync is selected but no change is chosen. Run /todo-settings to choose one."]);
		expect(t.panel()).toBeUndefined();
		expect(t.cli.calls).toEqual([]);
	});

	it("a normal session is unchanged: no CLI, no watcher, ordinary panel", async () => {
		const t = await boot(md("- [ ] A"));
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await callTool(t.host, ctx, { action: "create", subject: "Plain" });
		await t.fire("tool_execution_end", ctx, { toolName: "todo", isError: false });
		await t.settle();
		expect(t.panel()!.join("\n")).toContain("Plain");
		expect(t.cli.calls).toEqual([]);
		expect(t.watches).toEqual([]);
	});

	it("the normal-mode panel keeps ordinary ids, including in dependency markers", async () => {
		const t = await boot(md("- [ ] A"));
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await callTool(t.host, ctx, { action: "create", subject: "First" });
		await callTool(t.host, ctx, { action: "create", subject: "Second", blockedBy: [1] });
		await t.fire("tool_execution_end", ctx, { toolName: "todo", isError: false });
		await t.settle();
		const text = t.panel()!.join("\n");
		expect(text).toContain("Blocked by #1");
		expect(text).toContain("#2 Second");
		expect(text).not.toContain("1000001");
	});

	it("/todos in a sync session reads the shared snapshot", async () => {
		const t = await boot(md("- [x] 1.1 Done", "- [ ] 1.2 Open"));
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		await t.host.commands.get("todos").handler("", ctx);
		const out = t.notes[t.notes.length - 1];
		expect(out).toContain(`OpenSpec sync: a (${paths.root}) · fresh`);
		expect(out).toContain("1/2 checked, 1 remaining");
		expect(out).toContain("[pending] #2 1.2 Open");
	});

	it("a completion repaints the panel with the confirmed state", async () => {
		const t = await boot(md("- [ ] 1.1 A", "- [ ] 1.2 B"));
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		const list = await callTool(t.host, ctx, { action: "list" });
		const rev = /expectedRevision "([0-9a-f]{16})"/.exec(list.text)![1];
		const done = await callTool(t.host, ctx, { action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(done.text).toContain("CLI confirmed this task as done");
		await t.settle();
		expect(t.panel()![0]).toBe("● Todos · OpenSpec 1/2");
	});

	it("an external edit reaches the panel through the watcher with no prompt", async () => {
		const t = await boot(md("- [ ] A", "- [ ] B"));
		await t.fire("session_start", t.session());
		await t.settle();
		expect(t.panel()![0]).toBe("● Todos · OpenSpec 0/2");
		writeFileSync(paths.tasksPath, md("- [x] A", "- [x] B"));
		t.watches.find((w) => !w.closed)!.fire();
		await t.settle();
		await sleep(60);
		expect(t.panel()![0]).toBe("○ Todos · OpenSpec 2/2");
	});

	it("shutdown stops the session's reading, watcher and view", async () => {
		const t = await boot(md("- [ ] A"));
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		await t.fire("session_shutdown", ctx);
		expect(t.watches.every((w) => w.closed)).toBe(true);
		const calls = t.cli.calls.length;
		t.watches[0].fire();
		await sleep(100);
		expect(t.cli.calls.length).toBe(calls);
	});

	it("branch navigation restarts sync from the new branch: a normal branch closes the watcher", async () => {
		const t = await boot(md("- [ ] A"));
		const branch: unknown[] = [...[sessionEntry({ mode: "openspec", binding: { root: paths.root, change: "a" } })]];
		const ctx = t.session("s1", branch);
		await t.fire("session_start", ctx);
		await t.settle();
		expect(t.watches.filter((w) => !w.closed)).toHaveLength(1);
		branch.length = 0;
		branch.push(sessionEntry({ mode: "normal" }));
		await t.fire("session_tree", ctx);
		await t.settle();
		expect(t.watches.filter((w) => !w.closed)).toEqual([]);
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
	});

	it("two sessions bound to the same change keep separate views and watchers", async () => {
		const t = await boot(md("- [ ] A"));
		await t.fire("session_start", t.session("one"));
		await t.fire("session_start", t.session("two", [sessionEntry({ mode: "normal" })]));
		await t.settle();
		expect(t.watches.filter((w) => !w.closed)).toHaveLength(1);
		await t.fire("session_shutdown", t.session("two", []));
		expect(t.watches.filter((w) => !w.closed)).toHaveLength(1); // the other session keeps its watcher
	});
});

describe("/todo-settings restarts sync", () => {
	it("binding a change starts reading it and shows it in the panel at once", async () => {
		const t = await boot(md("- [x] 1.1 Done", "- [ ] 1.2 Open"));
		const script = scriptedUi({ select: ["Session mode: Normal", "OpenSpec sync", "a", "Done"], confirm: [true] });
		const ctx = t.session("s1", [], script.ui as any);
		ctx.ui = { ...ctx.ui, ...script.ui, setWidget: ctx.ui.setWidget, theme };
		await t.fire("session_start", ctx);
		await t.host.commands.get("todo-settings").handler("", ctx);
		await t.settle();
		expect(getSessionMode("s1").binding).toEqual({ root: paths.root, change: "a" });
		expect(t.panel()![0]).toBe("● Todos · OpenSpec 1/2");
		expect(t.watches.filter((w) => !w.closed)).toHaveLength(1);
	});

	it("returning to normal mode closes the watcher and removes linked tasks from the panel", async () => {
		const t = await boot(md("- [ ] A"));
		const script = scriptedUi({ select: ["Session mode: OpenSpec sync: a (" + paths.root + ")", "Normal", "Done"] });
		const ctx = t.session();
		ctx.ui = { ...ctx.ui, ...script.ui, setWidget: ctx.ui.setWidget, theme };
		await t.fire("session_start", ctx);
		await t.settle();
		expect(t.panel()).toBeDefined();
		await t.host.commands.get("todo-settings").handler("", ctx);
		await t.settle();
		expect(t.watches.filter((w) => !w.closed)).toEqual([]);
		expect(t.panel()).toBeUndefined();
	});
});
