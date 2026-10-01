/**
 * 7.1 and 7.2 against the installed OpenSpec CLI in disposable roots: the CLI's own
 * `instructions apply` output, the tool's list, `/todos` and the panel data must agree.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../src/sync/runtime.js";
import { setSessionMode } from "../src/session-mode.js";
import { describeSnapshot } from "../src/sync/text.js";
import { registerTodosCommand, registerTodoTool } from "../src/todo.js";
import { getState } from "../src/state/store.js";
import { callTool, createCtx, createHost, useCleanEnvironment } from "./helpers.js";
import { createOpenspecRoot } from "./fixtures.js";

useCleanEnvironment();
const HAS_CLI = spawnSync("openspec", ["--version"], { encoding: "utf-8" }).status === 0;
const fixture = createOpenspecRoot();
afterAll(() => fixture.cleanup());
const root = () => realpathSync(fixture.root);

interface Apply {
	progress: { total: number; complete: number };
	tasks: Array<{ id: string; description: string; done: boolean }>;
}
const cliApply = (change: string): Apply =>
	JSON.parse(
		spawnSync("openspec", ["instructions", "apply", "--change", change, "--json"], {
			cwd: fixture.root,
			encoding: "utf-8",
		}).stdout,
	);

const CASES: Record<string, string> = {
	"plain mixed": "- [x] 1.1 Done\n- [ ] 1.2 Open\n- [ ] 1.3 Later\n",
	"reordered with nesting": "- [ ] 2.1 Second\n  - [x] 1.1 First nested\n- [ ] 3.1 Third\n",
	CRLF: "# Tasks\r\n- [x] A\r\n- [ ] B\r\n  - [ ] C\r\n",
	"textless boxes counted but not listed": "- [x] A\n- [ ]\n- [ ] B\n- []\n",
	"duplicate wording": "- [ ] Same\n- [x] Same\n- [ ] Other\n",
	"link bullets and odd markers": "- [Docs](./d.md)\n- [~] Started\n1. [ ] Ordered\n+ [X] Plus done\n",
	"empty file": "",
};

describe.skipIf(!HAS_CLI)("7.1 tool, /todos, panel and CLI agree in a disposable root", () => {
	let n = 0;
	for (const [name, content] of Object.entries(CASES)) {
		it(
			name,
			async () => {
				const change = `agree-${n++}`;
				fixture.addChange(change, content);
				const id = `s-${change}`;
				setSessionMode(id, { mode: "openspec", binding: { root: root(), change } });
				const runtime = createRuntime({ getOrdinary: (sid) => getState(sid).tasks });
				const host = createHost();
				registerTodoTool(host.pi, runtime);
				registerTodosCommand(host.pi, runtime);
				const notes: string[] = [];
				const ctx = createCtx(id, [], { hasUI: true, ui: { notify: (m: string) => notes.push(m) } });
				try {
					const apply = cliApply(change);
					const list = (await callTool(host, ctx, { action: "list" })).text;
					await host.commands.get("todos").handler("", ctx);
					const snap = runtime.provider.getSnapshot(id);
					const panel = runtime.panelModel(id);

					// The tool's rows are exactly the CLI's listed tasks, in order, with the CLI's done flags.
					const toolRows = list
						.split("\n")
						.filter((l) => /^\[(completed|pending|in_progress)\] #\d+ /.test(l))
						.map((l) => /^\[(\w+)\] #\d+ (.*?)(?: \(read-only:.*\))?$/.exec(l)!);
					expect(toolRows.map((m) => [m[2], m[1] === "completed"])).toEqual(
						apply.tasks.map((t) => [t.description, t.done]),
					);
					// /todos shows the same text for the same snapshot, and the panel the same rows and totals.
					expect(notes[0]).toBe(describeSnapshot(snap).join("\n"));
					expect(panel.state.tasks.map((t) => [t.subject, t.status === "completed"])).toEqual(
						apply.tasks.map((t) => [t.description, t.done]),
					);
					expect(panel.sections!.openspec).toMatchObject({
						complete: apply.progress.complete,
						total: apply.progress.total,
					});
					expect(snap.implementation).toMatchObject({ total: apply.progress.total, complete: apply.progress.complete });
					expect(list).toContain(`${apply.progress.complete}/${apply.progress.total} checked`);
					// Planning readiness is reported on its own line.
					if (content !== "") expect(list).toContain("Planning artefacts: complete (readiness only");
				} finally {
					runtime.stopAll();
				}
			},
			60_000,
		);
	}

	it("after a completion through the tool, the CLI, the next list and the panel still agree, and only the target box changed", async () => {
		const original = "# T\r\n- [x] 1.1 Done\r\n- [~] 1.2 Target\r\n- [ ] 1.3 Later\r\n";
		const { tasksPath } = fixture.addChange("agree-after", original);
		const id = "s-after";
		setSessionMode(id, { mode: "openspec", binding: { root: root(), change: "agree-after" } });
		const runtime = createRuntime({ getOrdinary: () => [] });
		const host = createHost();
		registerTodoTool(host.pi, runtime);
		const ctx = createCtx(id, []);
		try {
			const rev = /expectedRevision "([0-9a-f]{16})"/.exec((await callTool(host, ctx, { action: "list" })).text)![1];
			const done = await callTool(host, ctx, { action: "update", id: 2, status: "completed", expectedRevision: rev });
			expect(done.text).toContain("CLI confirmed this task as done");
			expect(readFileSync(tasksPath, "utf-8")).toBe(original.replace("[~] 1.2 Target", "[x] 1.2 Target"));
			const apply = cliApply("agree-after");
			const after = (await callTool(host, ctx, { action: "list" })).text;
			expect(apply.tasks.map((t) => t.done)).toEqual([true, true, false]);
			expect(after).toContain("[completed] #2 1.2 Target");
			expect(after).toContain(`${apply.progress.complete}/${apply.progress.total} checked`);
			expect(runtime.panelModel(id).sections!.openspec).toMatchObject({ complete: 2, total: 3 });
		} finally {
			runtime.stopAll();
		}
	}, 60_000);
});

describe.skipIf(!HAS_CLI)("7.2 sessions in different roots and modes stay apart", () => {
	it("two roots and a normal session run side by side with no cross-talk, and normal mode never needs OpenSpec", async () => {
		const { createOpenspecRoot: mk } = await import("./fixtures.js");
		const other = mk();
		try {
			fixture.addChange("iso-a", "- [ ] A1\n- [ ] A2\n");
			other.addChange("iso-b", "- [ ] B1\n");
			setSessionMode("one", { mode: "openspec", binding: { root: root(), change: "iso-a" } });
			setSessionMode("two", { mode: "openspec", binding: { root: realpathSync(other.root), change: "iso-b" } });
			setSessionMode("three", { mode: "normal" });
			const runtime = createRuntime({ getOrdinary: (sid) => getState(sid).tasks });
			const host = createHost();
			registerTodoTool(host.pi, runtime);
			const [one, two, three] = ["one", "two", "three"].map((sid) => createCtx(sid, []));
			try {
				const listOne = (await callTool(host, one, { action: "list" })).text;
				const listTwo = (await callTool(host, two, { action: "list" })).text;
				expect(listOne).toContain("A1");
				expect(listOne).not.toContain("B1");
				expect(listTwo).toContain("B1");
				expect(listTwo).not.toContain("A1");

				await callTool(host, three, { action: "create", subject: "Plain" });
				const revOne = /expectedRevision "([0-9a-f]{16})"/.exec(listOne)![1];
				const revTwo = /expectedRevision "([0-9a-f]{16})"/.exec(listTwo)![1];
				const [a, b] = await Promise.all([
					callTool(host, one, { action: "update", id: 1, status: "completed", expectedRevision: revOne }),
					callTool(host, two, { action: "update", id: 1, status: "completed", expectedRevision: revTwo }),
				]);
				expect(a.text).toContain("confirmed");
				expect(b.text).toContain("confirmed");
				const files = (change: string, base: string) =>
					readFileSync(`${base}/openspec/changes/${change}/tasks.md`, "utf-8");
				expect(files("iso-a", fixture.root)).toBe("- [x] A1\n- [ ] A2\n");
				expect(files("iso-b", other.root)).toBe("- [x] B1\n");
				expect((await callTool(host, three, { action: "list" })).text).toBe("[pending] #1 Plain");
				expect(runtime.provider.getSnapshot("one").linked.map((r) => r.id)).toEqual([1, 2]);
				expect(runtime.provider.getSnapshot("three").linked).toEqual([]);
			} finally {
				runtime.stopAll();
			}
		} finally {
			other.cleanup();
		}
	}, 90_000);

	it("normal mode works with no OpenSpec on the PATH", async () => {
		const saved = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			setSessionMode("plain-only", { mode: "normal" });
			const runtime = createRuntime({ getOrdinary: (sid) => getState(sid).tasks });
			const host = createHost();
			registerTodoTool(host.pi, runtime);
			const ctx = createCtx("plain-only", []);
			expect((await callTool(host, ctx, { action: "create", subject: "A" })).text).toBe("Created #1: A (pending)");
			expect((await callTool(host, ctx, { action: "update", id: 1, status: "completed" })).text).toBe(
				"Updated #1 (pending → completed)",
			);
			expect((await callTool(host, ctx, { action: "list" })).text).toBe("[completed] #1 A");
			runtime.stopAll();
		} finally {
			process.env.PATH = saved;
		}
	});

	it("sync mode reports a missing openspec as an unavailable view, with no tasks invented", async () => {
		const saved = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			setSessionMode("no-cli", { mode: "openspec", binding: { root: root(), change: "iso-a" } });
			const runtime = createRuntime({ getOrdinary: () => [] });
			const host = createHost();
			registerTodoTool(host.pi, runtime);
			const text = (await callTool(host, createCtx("no-cli", []), { action: "list" })).text;
			expect(text).toContain("⚠ The OpenSpec view is unavailable");
			expect(text).toContain("Could not run openspec");
			expect(text).not.toContain("A1");
			runtime.stopAll();
		} finally {
			process.env.PATH = saved;
		}
	});
});
