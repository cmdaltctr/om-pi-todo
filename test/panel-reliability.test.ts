import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootPanel, sleep } from "./panel-harness.js";
import { useCleanEnvironment } from "./helpers.js";
import { md, useSyncRoot } from "./sync-harness.js";

useCleanEnvironment();
const paths = useSyncRoot();

const assistant = (stopReason: string) => ({ messages: [{ role: "assistant", stopReason, content: [] }] });

describe("every committed update repaints the panel without another prompt", () => {
	it("normal mode: a tool update schedules a render before the tool returns, with no event fired", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		expect(t.widget.registrations).toBe(1);
		const before = t.renders();
		await t.call(ctx, { action: "update", id: 1, status: "in_progress", activeForm: "working" });
		expect(t.renders()).toBeGreaterThan(before);
		expect(t.render()![1]).toContain("A");
	});

	it("shows the committed status at the next render, not the previous one", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.fire("agent_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		await t.call(ctx, { action: "update", id: 1, status: "in_progress", activeForm: "working" });
		expect(t.render()).toEqual(["● Todos (0/1)", "└─ ◐ A (working)"]);
		await t.call(ctx, { action: "update", id: 1, status: "completed" });
		expect(t.render()![0]).toBe("○ Todos (1/1)");
	});

	it("repaints for delete, clear, dependency and reason changes", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		await t.call(ctx, { action: "create", subject: "B" });
		let before = t.renders();
		await t.call(ctx, { action: "update", id: 2, addBlockedBy: [1] });
		expect(t.renders()).toBeGreaterThan(before);
		expect(t.render()!.join("\n")).toContain("Blocked by #1");
		before = t.renders();
		await t.call(ctx, { action: "update", id: 1, waitingReason: "approval" });
		expect(t.renders()).toBeGreaterThan(before);
		expect(t.render()!.join("\n")).toContain("waiting: approval");
		before = t.renders();
		await t.call(ctx, { action: "delete", id: 2 });
		expect(t.renders()).toBeGreaterThan(before);
		await t.call(ctx, { action: "clear" });
		expect(t.widget.unregistrations).toBe(1);
		expect(t.render()).toBeUndefined();
	});

	it("does not repaint for a call that failed and committed nothing", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		const before = t.renders();
		expect((await t.call(ctx, { action: "update", id: 99, status: "completed" })).text).toBe("Error: #99 not found");
		expect((await t.call(ctx, { action: "create", subject: "" })).text).toBe("Error: subject required for create");
		expect(t.renders()).toBe(before);
	});

	it("does not repaint for reads", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		const before = t.renders();
		await t.call(ctx, { action: "list" });
		await t.call(ctx, { action: "get", id: 1 });
		expect(t.renders()).toBe(before);
	});

	it("sync mode: an activity update repaints though no file changed", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A", "- [ ] B") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.fire("agent_start", ctx);
		await t.settle();
		const list = await t.call(ctx, { action: "list" });
		const rev = /expectedRevision "([0-9a-f]{16})"/.exec(list.text)![1];
		const before = t.renders();
		const disk = t.disk();
		await t.call(ctx, {
			action: "update",
			id: 1,
			status: "in_progress",
			activeForm: "starting",
			expectedRevision: rev,
		});
		expect(t.renders()).toBeGreaterThan(before);
		expect(t.render()!.join("\n")).toContain("◐ A (starting)");
		expect(t.disk().equals(disk)).toBe(true);
	});

	it("sync mode: a completion repaints with the confirmed state", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A", "- [ ] B") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		const rev = /expectedRevision "([0-9a-f]{16})"/.exec((await t.call(ctx, { action: "list" })).text)![1];
		const before = t.renders();
		await t.call(ctx, { action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(t.renders()).toBeGreaterThan(before);
		expect(t.render()![0]).toBe("● Todos · OpenSpec 1/2");
	});

	it("sync mode: an incidental task and a clear both repaint", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		let before = t.renders();
		await t.call(ctx, { action: "create", subject: "Debug", scope: "incidental", reason: "r" });
		expect(t.renders()).toBeGreaterThan(before);
		expect(t.render()![0]).toBe("● Todos · OpenSpec 0/1 · incidental 0/1");
		before = t.renders();
		await t.call(ctx, { action: "clear" });
		expect(t.renders()).toBeGreaterThan(before);
		expect(t.render()![0]).toBe("● Todos · OpenSpec 0/1");
	});

	it("reconciliation repaints: a refresh from list, and an external edit through the watcher", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		let before = t.renders();
		writeFileSync(paths.tasksPath, md("- [x] A"));
		await t.call(ctx, { action: "list" });
		expect(t.renders()).toBeGreaterThan(before);
		expect(t.render()![0]).toBe("○ Todos · OpenSpec 1/1");
		writeFileSync(paths.tasksPath, md("- [ ] A", "- [ ] B"));
		before = t.renders();
		t.watches.find((w) => !w.closed)!.fire();
		await t.settle();
		await sleep(40);
		expect(t.renders()).toBeGreaterThan(before);
		expect(t.render()![0]).toBe("● Todos · OpenSpec 1/2".replace("1/2", "0/2"));
	});

	it("resume, compaction and branch navigation repaint", async () => {
		const t = await bootPanel();
		const branch: unknown[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { tasks: [{ id: 1, subject: "Old", status: "pending" }], nextId: 2 },
				},
			},
		];
		const ctx = t.session("s1", branch);
		await t.fire("session_start", ctx);
		expect(t.render()!.join("\n")).toContain("Old");
		branch.length = 0;
		branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { tasks: [{ id: 1, subject: "Branch two", status: "pending" }], nextId: 2 },
			},
		});
		await t.fire("session_tree", ctx);
		expect(t.render()!.join("\n")).toContain("Branch two");
		branch.length = 0;
		branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { tasks: [{ id: 1, subject: "After compact", status: "pending" }], nextId: 2 },
			},
		});
		await t.fire("session_compact", ctx);
		expect(t.render()!.join("\n")).toContain("After compact");
	});

	it("a background session never replaces the foreground view", async () => {
		const t = await bootPanel();
		const fg = t.session("fg", []);
		await t.fire("session_start", fg);
		await t.call(fg, { action: "create", subject: "Foreground task" });
		const bg = t.session("bg", [], { hasUI: false });
		await t.fire("session_start", bg);
		const before = t.renders();
		const registrations = t.widget.registrations;
		await t.call(bg, { action: "create", subject: "Background task" });
		await t.fire("agent_start", bg);
		await t.fire("agent_end", bg, assistant("stop"));
		expect(t.renders()).toBe(before);
		expect(t.widget.registrations).toBe(registrations);
		expect(t.render()!.join("\n")).toContain("Foreground task");
		expect(t.render()!.join("\n")).not.toContain("Background task");
	});
});

describe("the panel heading agrees with /todos", () => {
	it("normal mode: same completed and total counts, also after a completed row is hidden", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		for (const subject of ["A", "B", "C", "D"]) await t.call(ctx, { action: "create", subject });
		await t.call(ctx, { action: "update", id: 1, status: "completed" });
		await t.call(ctx, { action: "update", id: 2, status: "in_progress" });
		await t.call(ctx, { action: "delete", id: 4 });
		t.render(); // the completed row is shown once
		await t.fire("agent_start", ctx); // next turn: it is hidden
		expect(t.render()!.join("\n")).not.toContain("A\n");
		const panel = /\((\d+)\/(\d+)\)/.exec(t.render()![0])!;
		await t.command("todos", ctx);
		const todos = /^(\d+)\/(\d+) completed/.exec(t.notes.at(-1)!.message)!;
		expect([panel[1], panel[2]]).toEqual([todos[1], todos[2]]);
		expect([panel[1], panel[2]]).toEqual(["1", "3"]);
	});

	it("sync mode: the same OpenSpec numbers, including a box without text that the CLI counts", async () => {
		const t = await bootPanel({ paths, content: md("- [x] A", "- [ ] B", "- [ ]") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		await t.command("todos", ctx);
		const todos = /OpenSpec tasks: (\d+)\/(\d+) checked/.exec(t.notes.at(-1)!.message)!;
		const panel = /OpenSpec (\d+)\/(\d+)/.exec(t.render()![0])!;
		expect([panel[1], panel[2]]).toEqual([todos[1], todos[2]]);
		expect([panel[1], panel[2]]).toEqual(["1", "3"]);
	});
});

describe("run state changes the rows, not the tasks", () => {
	async function working() {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		await t.call(ctx, { action: "update", id: 1, status: "in_progress", activeForm: "working" });
		return { t, ctx };
	}

	it("running while the agent works, Idle after it finishes, Paused after an abort", async () => {
		const { t, ctx } = await working();
		expect(t.render()![1]).toBe("└─ ◌ A Idle"); // nothing is running yet, so the saved status alone shows no activity
		await t.fire("agent_start", ctx);
		expect(t.render()![1]).toBe("└─ ◐ A (working)");
		await t.fire("agent_end", ctx, assistant("stop"));
		expect(t.render()![1]).toBe("└─ ◌ A Idle");
		await t.fire("agent_start", ctx);
		await t.fire("agent_end", ctx, assistant("aborted"));
		expect(t.render()![1]).toBe("└─ ◌ A Paused");
	});

	it("each change schedules a render", async () => {
		const { t, ctx } = await working();
		let before = t.renders();
		await t.fire("agent_start", ctx);
		expect(t.renders()).toBeGreaterThan(before);
		before = t.renders();
		await t.fire("agent_end", ctx, assistant("stop"));
		expect(t.renders()).toBeGreaterThan(before);
	});

	it("never changes a task's status, and never completes anything", async () => {
		const { t, ctx } = await working();
		await t.fire("agent_start", ctx);
		await t.fire("agent_end", ctx, assistant("aborted"));
		await t.fire("agent_settled", ctx);
		expect((await t.call(ctx, { action: "get", id: 1 })).text).toBe("#1 [in_progress] A\n  activeForm: working");
	});

	it("a run that ends without an end event still leaves rows Idle once the agent settles", async () => {
		const { t, ctx } = await working();
		await t.fire("agent_start", ctx);
		expect(t.render()![1]).toContain("◐");
		await t.fire("agent_settled", ctx);
		expect(t.render()![1]).toBe("└─ ◌ A Idle");
	});

	it("a resumed session shows in-progress work as Idle, never running", async () => {
		const t = await bootPanel();
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { tasks: [{ id: 1, subject: "Saved", status: "in_progress", activeForm: "x" }], nextId: 2 },
				},
			},
		];
		await t.fire("session_start", t.session("s1", branch));
		expect(t.render()![1]).toBe("└─ ◌ Saved Idle");
	});

	it("a blocked task never looks like it is running, even while the agent runs", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.fire("agent_start", ctx);
		await t.call(ctx, { action: "create", subject: "First" });
		await t.call(ctx, { action: "create", subject: "Second", blockedBy: [1] });
		await t.call(ctx, { action: "update", id: 2, status: "in_progress", activeForm: "x" });
		const second = t.render()!.find((l) => l.includes("Second"))!;
		expect(second).toContain("Blocked by #1");
		expect(second).not.toContain("◐");
	});

	it("an approval or failure reported by the agent shows at once and clears when resolved", async () => {
		const { t, ctx } = await working();
		await t.call(ctx, { action: "update", id: 1, waitingReason: "approval from Sam" });
		expect(t.render()![1]).toContain("waiting: approval from Sam");
		await t.call(ctx, { action: "update", id: 1, waitingReason: "", failureReason: "review failed" });
		expect(t.render()![1]).toContain("failed: review failed");
		expect(t.render()![1]).not.toContain("waiting");
		await t.call(ctx, { action: "update", id: 1, failureReason: "" });
		expect(t.render()![1]).not.toMatch(/waiting|failed/);
	});

	it("shutdown forgets the session's run state", async () => {
		const { t, ctx } = await working();
		await t.fire("agent_start", ctx);
		await t.fire("session_shutdown", ctx);
		const again = t.session("s1", []);
		await t.fire("session_start", again);
		await t.call(again, { action: "create", subject: "B" });
		await t.call(again, { action: "update", id: 1, status: "in_progress", activeForm: "x" });
		expect(t.render()![1]).toContain("Idle");
	});
});

describe("a failed repaint is visible and does not undo anything", () => {
	it("notifies the user once, keeps the task change, and tells the agent", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		t.widget.failWith = new Error("widget host gone"); // the host cannot register the panel
		await t.call(ctx, { action: "create", subject: "A" });
		const result = await t.call(ctx, { action: "create", subject: "B" });
		expect(result.text).toContain("Created #2: B (pending)");
		expect(result.text).toContain("The todo panel could not be repainted: widget host gone");
		expect(result.text).toContain("/todos refresh");
		expect(result.details.error).toBeUndefined();
		expect(result.details.tasks.map((x: { subject: string }) => x.subject)).toEqual(["A", "B"]);
		const errors = t.notes.filter((n) => n.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toBe(
			"The todo panel could not be repainted: widget host gone. Your tasks are safe. Run /todos refresh to retry.",
		);
	});

	it("does not repeat the same notification on every update, and notifies again after a recovery", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		t.widget.failWith = new Error("boom");
		for (const subject of ["A", "B", "C"]) await t.call(ctx, { action: "create", subject });
		expect(t.notes.filter((n) => n.type === "error")).toHaveLength(1);
		t.widget.failWith = undefined;
		await t.call(ctx, { action: "create", subject: "D" }); // registers and repaints fine
		expect(t.render()).toBeDefined();
		await t.call(ctx, { action: "clear" }); // unregisters, so the next create registers again
		t.widget.failWith = new Error("boom");
		await t.call(ctx, { action: "create", subject: "E" });
		expect(t.notes.filter((n) => n.type === "error")).toHaveLength(2);
	});

	it("resuming a session on a host that cannot draw the panel reports it and does not fail the start", async () => {
		const t = await bootPanel();
		t.widget.failWith = new Error("widget host gone");
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { tasks: [{ id: 1, subject: "Saved", status: "pending" }], nextId: 2 },
				},
			},
		];
		const ctx = t.session("s1", branch);
		await expect(t.fire("session_start", ctx)).resolves.toBeDefined();
		expect(t.notes.filter((n) => n.type === "error")).toHaveLength(1);
		await expect(t.fire("session_tree", ctx)).resolves.toBeDefined();
		await expect(t.fire("session_compact", ctx)).resolves.toBeDefined();
		expect((await t.call(ctx, { action: "list" })).text).toBe("[pending] #1 Saved");
	});

	it("a failed repaint during a sync read is reported once, as an error, not twice", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		t.widget.tui.requestRender.mockImplementation(() => {
			throw new Error("render queue closed");
		});
		writeFileSync(paths.tasksPath, md("- [x] A"));
		await t.call(ctx, { action: "list" });
		expect(t.notes.filter((n) => n.type === "error")).toHaveLength(1);
		expect(t.notes.filter((n) => n.type === "warning")).toEqual([]);
	});

	it("a render request that throws is reported the same way and loses nothing", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		t.widget.tui.requestRender.mockImplementation(() => {
			throw new Error("render queue closed");
		});
		const result = await t.call(ctx, { action: "update", id: 1, status: "in_progress", activeForm: "x" });
		expect(result.text).toContain("Updated #1 (pending → in_progress)");
		expect(result.text).toContain("could not be repainted: render queue closed");
		expect(t.notes.filter((n) => n.type === "error")).toHaveLength(1);
		expect(result.details.tasks[0].status).toBe("in_progress");
	});

	it("an event-driven repaint failure is reported and does not break the host", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		t.widget.tui.requestRender.mockImplementation(() => {
			throw new Error("render queue closed");
		});
		await expect(t.fire("agent_start", ctx)).resolves.toBeDefined();
		await expect(t.fire("agent_end", ctx, assistant("stop"))).resolves.toBeDefined();
		await expect(t.fire("tool_execution_end", ctx, { toolName: "todo", isError: false })).resolves.toBeDefined();
		expect(t.notes.filter((n) => n.type === "error")).toHaveLength(1);
	});

	it("a sync completion that persisted stays completed and reports the repaint problem", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		const rev = /expectedRevision "([0-9a-f]{16})"/.exec((await t.call(ctx, { action: "list" })).text)![1];
		t.widget.tui.requestRender.mockImplementation(() => {
			throw new Error("widget host gone");
		});
		const result = await t.call(ctx, { action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(result.text).toContain("CLI confirmed this task as done");
		expect(result.text).toContain("could not be repainted: widget host gone");
		expect(result.details.error).toBeUndefined();
		expect(t.disk().toString()).toBe(md("- [x] A"));
		expect(t.renames).toHaveBeenCalledTimes(1);
	});

	it("a failure that is not about the panel, such as a watcher that cannot start, is shown as a warning", async () => {
		const t = await bootPanel({
			paths,
			content: md("- [ ] A"),
			runtime: {
				watch: (_file: string, _onChange: () => void, o?: { onError?: (e: unknown) => void }) => {
					o?.onError?.(new Error("EMFILE: too many open files"));
					return { close() {} };
				},
			},
		});
		await t.fire("session_start", t.session());
		await t.settle();
		const warning = t.notes.find((n) => n.type === "warning");
		expect(warning?.message).toContain("EMFILE");
		expect(warning?.message).toContain("Run /todos refresh to update.");
		expect(t.notes.filter((n) => n.type === "error")).toEqual([]);
	});

	it("an unreadable change shows in the panel as stale instead of a notification", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A") });
		await t.fire("session_start", t.session());
		await t.settle();
		t.cli!.hooks.apply = () => ({ ok: false, kind: "timeout", message: "timed out" });
		t.watches.find((w) => !w.closed)!.fire();
		await t.settle();
		await sleep(40);
		expect(t.render()![0]).toBe("● Todos · OpenSpec 0/1 ⚠ stale");
		expect(t.notes).toEqual([]);
	});
});

describe("/todos refresh recovers the panel", () => {
	/** The host cannot register the panel, so the first tasks are committed but never drawn. */
	async function broken() {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		t.widget.failWith = new Error("widget host gone");
		await t.call(ctx, { action: "create", subject: "A" });
		await t.call(ctx, { action: "create", subject: "B" });
		t.notes.length = 0;
		return { t, ctx };
	}

	it("names the original failure, redraws the committed state, and repeats no mutation", async () => {
		const { t, ctx } = await broken();
		expect(t.render()).toBeUndefined();
		t.widget.failWith = undefined;
		await t.command("todos", ctx, "refresh");
		expect(t.notes).toEqual([
			{ message: "Todo panel recovered. The earlier problem was: widget host gone", type: "info" },
		]);
		expect(t.render()).toEqual(["● Todos (0/2)", "├─ ○ A", "└─ ○ B"]);
		expect((await t.call(ctx, { action: "list" })).text).toBe("[pending] #1 A\n[pending] #2 B");
	});

	it("a recovery is reported once: the next refresh finds nothing to recover from", async () => {
		const { t, ctx } = await broken();
		t.widget.failWith = undefined;
		await t.command("todos", ctx, "refresh");
		await t.command("todos", ctx, "refresh");
		expect(t.notes.map((n) => n.message)).toEqual([
			"Todo panel recovered. The earlier problem was: widget host gone",
			"Todo panel refreshed.",
		]);
	});

	it("names the latest problem when a refresh itself fails differently", async () => {
		const { t, ctx } = await broken();
		t.widget.failWith = new Error("second problem");
		await t.command("todos", ctx, "refresh");
		t.widget.failWith = undefined;
		t.notes.length = 0;
		await t.command("todos", ctx, "refresh");
		expect(t.notes).toEqual([
			{ message: "Todo panel recovered. The earlier problem was: second problem", type: "info" },
		]);
	});

	it("works with nothing wrong, and says so", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		await t.command("todos", ctx, "refresh");
		expect(t.notes.at(-1)).toEqual({ message: "Todo panel refreshed.", type: "info" });
		expect(t.render()).toEqual(["● Todos (0/1)", "└─ ○ A"]);
	});

	it("reports a second failure instead of claiming success, and keeps the task list", async () => {
		const { t, ctx } = await broken();
		await t.command("todos", ctx, "refresh");
		expect(t.notes).toHaveLength(1);
		expect(t.notes[0]).toEqual({
			message: "Todo panel refresh failed: widget host gone. Your tasks are unchanged. Run /todos refresh to retry.",
			type: "error",
		});
		expect((await t.call(ctx, { action: "list" })).text).toContain("#2 B");
		t.widget.failWith = undefined;
		await t.command("todos", ctx, "refresh");
		expect(t.render()).toEqual(["● Todos (0/2)", "├─ ○ A", "└─ ○ B"]);
	});

	it("registers the panel again even when the old registration looked healthy", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		const before = t.widget.registrations;
		await t.command("todos", ctx, "refresh");
		expect(t.widget.registrations).toBe(before + 1);
	});

	it("an empty list leaves no panel, and says the refresh worked", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.command("todos", ctx, "refresh");
		expect(t.notes.at(-1)).toEqual({ message: "Todo panel refreshed.", type: "info" });
		expect(t.render()).toBeUndefined();
	});

	it("does not touch the foreground panel from a background session", async () => {
		const t = await bootPanel();
		const fg = t.session("fg", []);
		await t.fire("session_start", fg);
		await t.call(fg, { action: "create", subject: "Foreground" });
		const bg = t.session("bg", []);
		await t.fire("session_start", bg);
		const before = t.widget.registrations;
		await t.command("todos", bg, "refresh");
		expect(t.widget.registrations).toBe(before);
		expect(t.notes.at(-1)!.message).toBe("This session is not showing the todo panel, so nothing was redrawn.");
	});

	it("needs a UI", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", [], { hasUI: false });
		await t.command("todos", ctx, "refresh");
		expect(t.notes.at(-1)).toEqual({ message: "/todos requires interactive mode", type: "error" });
	});

	it("sync mode: re-reads the file, rewrites nothing, and shows what is committed", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A", "- [ ] B") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		t.widget.tui.requestRender.mockImplementation(() => {
			throw new Error("widget host gone");
		});
		writeFileSync(paths.tasksPath, md("- [x] A", "- [ ] B")); // changed while the panel was broken
		const external = t.disk();
		await t.call(ctx, { action: "list" }); // reads the edit; its repaint fails and is recorded
		t.widget.tui.requestRender.mockImplementation(() => undefined);
		t.notes.length = 0;
		await t.command("todos", ctx, "refresh");
		expect(t.render()![0]).toBe("● Todos · OpenSpec 1/2");
		expect(t.disk().equals(external)).toBe(true);
		expect(t.renames).not.toHaveBeenCalled();
		expect(t.notes.at(-1)).toEqual({
			message: "Todo panel recovered. The earlier problem was: widget host gone",
			type: "info",
		});
	});

	it("normal mode: never starts the OpenSpec CLI, even when a runtime exists", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A") });
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "Plain" });
		await t.command("todos", ctx, "refresh");
		expect(t.cli!.calls).toEqual([]);
		expect(t.notes.at(-1)!.message).toBe("Todo panel refreshed.");
	});

	it("sync mode: a refresh that cannot read the change still redraws what is committed, marked stale", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		t.cli!.hooks.apply = () => ({ ok: false, kind: "timeout", message: "timed out" });
		await t.command("todos", ctx, "refresh");
		expect(t.render()![0]).toBe("● Todos · OpenSpec 0/1 ⚠ stale");
		expect(t.notes.at(-1)!.message).toBe("Todo panel refreshed.");
	});
});

describe("one reminder when the agent settles with work in progress", () => {
	const reminders = (t: Awaited<ReturnType<typeof bootPanel>>) =>
		t.notes.filter((n) => n.message.startsWith("Reminder:"));

	async function inProgress(names: string[]) {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		for (const name of names) await t.call(ctx, { action: "create", subject: name });
		for (let i = 1; i <= names.length; i++)
			await t.call(ctx, { action: "update", id: i, status: "in_progress", activeForm: "x" });
		t.notes.length = 0;
		return { t, ctx };
	}

	it("sends exactly one visible reminder naming every unresolved task", async () => {
		const { t, ctx } = await inProgress(["Write tests", "Fix bug"]);
		await t.fire("agent_settled", ctx);
		expect(reminders(t)).toEqual([
			{
				message:
					"Reminder: 2 tasks are still in progress: #1 Write tests, #2 Fix bug. Update each one: mark it completed or pending, or record what it is waiting for with waitingReason or failureReason.",
				type: "warning",
			},
		]);
		expect(t.notes).toHaveLength(1);
	});

	it("uses the singular for one task", async () => {
		const { t, ctx } = await inProgress(["Only one"]);
		await t.fire("agent_settled", ctx);
		expect(reminders(t)[0].message).toMatch(/^Reminder: 1 task is still in progress: #1 Only one\. /);
	});

	it("says nothing when no task is in progress", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "Pending" });
		await t.call(ctx, { action: "create", subject: "Done" });
		await t.call(ctx, { action: "update", id: 2, status: "completed" });
		await t.fire("agent_settled", ctx);
		expect(reminders(t)).toEqual([]);
	});

	it("reminds once per settle, not once per task and not repeatedly within one", async () => {
		const { t, ctx } = await inProgress(["A", "B", "C"]);
		await t.fire("agent_settled", ctx);
		expect(reminders(t)).toHaveLength(1);
		await t.fire("agent_settled", ctx);
		expect(reminders(t)).toHaveLength(2);
	});

	it("stops reminding once the work is resolved", async () => {
		const { t, ctx } = await inProgress(["A"]);
		await t.call(ctx, { action: "update", id: 1, status: "completed" });
		await t.fire("agent_settled", ctx);
		expect(reminders(t)).toEqual([]);
	});

	it("lists at most five tasks and counts the rest", async () => {
		const { t, ctx } = await inProgress(["a", "b", "c", "d", "e", "f", "g"]);
		await t.fire("agent_settled", ctx);
		expect(reminders(t)[0].message).toMatch(
			/^Reminder: 7 tasks are still in progress: #1 a, #2 b, #3 c, #4 d, #5 e and 2 more\. /,
		);
	});

	it("cuts long wording and strips control sequences", async () => {
		const { t, ctx } = await inProgress([`\u001b[31mred\u001b[0m\u0007${"x".repeat(100)}`]);
		await t.fire("agent_settled", ctx);
		expect(reminders(t)[0].message).not.toMatch(/\u001b|\u0007/);
		expect(reminders(t)[0].message).toContain("…");
		expect(reminders(t)[0].message.length).toBeLessThan(400);
	});

	it("does not remind a session with no UI, and never throws", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", [], { hasUI: false });
		await t.fire("session_start", ctx);
		await t.call(ctx, { action: "create", subject: "A" });
		await t.call(ctx, { action: "update", id: 1, status: "in_progress" });
		await expect(t.fire("agent_settled", ctx)).resolves.toBeDefined();
		expect(t.notes).toEqual([]);
	});

	it("never continues the agent, never writes a message, never changes a task", async () => {
		const { t, ctx } = await inProgress(["A"]);
		const results = await t.fire("agent_settled", ctx);
		expect(results).toEqual([undefined]);
		expect(t.sent.sendUserMessage).not.toHaveBeenCalled();
		expect(t.sent.sendMessage).not.toHaveBeenCalled();
		expect((await t.call(ctx, { action: "get", id: 1 })).text).toContain("#1 [in_progress] A");
	});

	it("sync mode: counts linked and incidental work, labels each, and never checks a box", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] 1.1 Plan task", "- [ ] 1.2 Other") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		const rev = /expectedRevision "([0-9a-f]{16})"/.exec((await t.call(ctx, { action: "list" })).text)![1];
		await t.call(ctx, { action: "update", id: 1, status: "in_progress", activeForm: "x", expectedRevision: rev });
		await t.call(ctx, { action: "create", subject: "Debug", scope: "incidental", reason: "r" });
		await t.call(ctx, { action: "update", id: 1, status: "in_progress", scope: "incidental" });
		t.notes.length = 0;
		const before = t.disk();
		await t.fire("agent_settled", ctx);
		expect(reminders(t)).toHaveLength(1);
		expect(reminders(t)[0].message).toContain("2 tasks are still in progress: #1 1.1 Plan task, incidental #1 Debug.");
		expect(t.disk().equals(before)).toBe(true);
		expect(t.renames).not.toHaveBeenCalled();
		expect(t.sent.sendUserMessage).not.toHaveBeenCalled();
	});

	it("sync mode: a task already checked in the file is not reminded about, whatever its saved activity", async () => {
		const t = await bootPanel({ paths, content: md("- [ ] A") });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		const rev = /expectedRevision "([0-9a-f]{16})"/.exec((await t.call(ctx, { action: "list" })).text)![1];
		await t.call(ctx, { action: "update", id: 1, status: "in_progress", activeForm: "x", expectedRevision: rev });
		writeFileSync(paths.tasksPath, md("- [x] A")); // checked outside
		await t.call(ctx, { action: "list" });
		t.notes.length = 0;
		await t.fire("agent_settled", ctx);
		expect(reminders(t)).toEqual([]);
	});

	it("an interrupted run still gets its reminder, and the rows say Paused", async () => {
		const { t, ctx } = await inProgress(["A"]);
		await t.fire("agent_start", ctx);
		await t.fire("agent_end", ctx, assistant("aborted"));
		await t.fire("agent_settled", ctx);
		expect(reminders(t)).toHaveLength(1);
		expect(t.render()![1]).toContain("Paused");
	});
});
