import { describe, expect, it } from "vitest";
import { registerTodosCommand, registerTodoTool } from "../src/todo.js";
import { callTool, createCtx, createHost, useCleanEnvironment } from "./helpers.js";

useCleanEnvironment();

function setup() {
	const host = createHost();
	registerTodoTool(host.pi);
	registerTodosCommand(host.pi);
	return host;
}

describe("normal mode: tool parity", () => {
	it("registers the `todo` tool and the `/todos` command", () => {
		const host = setup();
		expect([...host.tools.keys()]).toEqual(["todo"]);
		expect([...host.commands.keys()]).toEqual(["todos"]);
	});

	it("creates tasks with increasing ids and records a replayable snapshot", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		const first = await callTool(host, ctx, { action: "create", subject: "Write tests" });
		const second = await callTool(host, ctx, { action: "create", subject: "Fix bug", description: "Long form", owner: "me" });
		expect(first.text).toBe("Created #1: Write tests (pending)");
		expect(second.text).toBe("Created #2: Fix bug (pending)");
		expect(second.details.nextId).toBe(3);
		expect(second.details.tasks).toEqual([
			{ id: 1, subject: "Write tests", status: "pending" },
			{ id: 2, subject: "Fix bug", status: "pending", description: "Long form", owner: "me" },
		]);
	});

	it("moves a task forward through pending, in_progress, and completed", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A" });
		expect((await callTool(host, ctx, { action: "update", id: 1, status: "in_progress", activeForm: "working" })).text).toBe(
			"Updated #1 (pending → in_progress)",
		);
		expect((await callTool(host, ctx, { action: "update", id: 1, status: "completed" })).text).toBe(
			"Updated #1 (in_progress → completed)",
		);
	});

	it("never reopens a completed task", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A" });
		await callTool(host, ctx, { action: "update", id: 1, status: "completed" });
		const reopened = await callTool(host, ctx, { action: "update", id: 1, status: "in_progress" });
		expect(reopened.text).toBe("Error: illegal transition completed → in_progress");
		expect(reopened.details.tasks[0].status).toBe("completed");
	});

	it("reports an update that changes nothing", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A" });
		const same = await callTool(host, ctx, { action: "update", id: 1, status: "pending" });
		expect(same.text).toBe("No change: #1 already matches the requested values (status: pending)");
	});

	it("rejects empty subjects, unknown ids, and updates with no fields", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		expect((await callTool(host, ctx, { action: "create", subject: "  " })).text).toBe("Error: subject required for create");
		expect((await callTool(host, ctx, { action: "update", id: 9, status: "completed" })).text).toBe("Error: #9 not found");
		await callTool(host, ctx, { action: "create", subject: "A" });
		const empty = await callTool(host, ctx, { action: "update", id: 1 });
		expect(empty.text).toMatch(/^Error: update requires at least one mutable field/);
	});

	it("tracks dependencies, derived blocks, and rejects cycles and self-blocking", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A" });
		await callTool(host, ctx, { action: "create", subject: "B", blockedBy: [1] });
		expect((await callTool(host, ctx, { action: "create", subject: "C", blockedBy: [7] })).text).toBe("Error: blockedBy: #7 not found");
		expect((await callTool(host, ctx, { action: "update", id: 1, addBlockedBy: [2] })).text).toBe(
			"Error: addBlockedBy would create a cycle in the blockedBy graph",
		);
		expect((await callTool(host, ctx, { action: "update", id: 1, addBlockedBy: [1] })).text).toBe("Error: cannot block #1 on itself");
		expect((await callTool(host, ctx, { action: "list" })).text).toBe("[pending] #1 A\n[pending] #2 B ⛓ #1");
		expect((await callTool(host, ctx, { action: "get", id: 1 })).text).toBe("#1 [pending] A\n  blocks: #2");
	});

	it("tombstones deleted tasks, hides them from list by default, and never reuses ids", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A" });
		expect((await callTool(host, ctx, { action: "delete", id: 1 })).text).toBe("Deleted #1: A");
		expect((await callTool(host, ctx, { action: "delete", id: 1 })).text).toBe("Error: #1 is already deleted");
		expect((await callTool(host, ctx, { action: "list" })).text).toBe("No tasks");
		expect((await callTool(host, ctx, { action: "list", includeDeleted: true })).text).toBe("[deleted] #1 A");
		expect((await callTool(host, ctx, { action: "create", subject: "B" })).text).toBe("Created #2: B (pending)");
	});

	it("merges metadata and removes keys set to null", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A", metadata: { a: 1, b: 2 } });
		const merged = await callTool(host, ctx, { action: "update", id: 1, metadata: { b: null, c: 3 } });
		expect(merged.details.tasks[0].metadata).toEqual({ a: 1, c: 3 });
	});

	it("clears every task and restarts ids at 1", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A" });
		await callTool(host, ctx, { action: "create", subject: "B" });
		expect((await callTool(host, ctx, { action: "clear" })).text).toBe("Cleared 2 tasks");
		expect((await callTool(host, ctx, { action: "create", subject: "C" })).text).toBe("Created #1: C (pending)");
	});

	it("keeps each session's list separate", async () => {
		const host = setup();
		await callTool(host, createCtx("s1"), { action: "create", subject: "Only in s1" });
		expect((await callTool(host, createCtx("s2"), { action: "list" })).text).toBe("No tasks");
	});
});

describe("normal mode: waiting and failure reasons", () => {
	it("stores reasons, reports them in get, and clears them with an empty string", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A" });
		const set = await callTool(host, ctx, { action: "update", id: 1, waitingReason: "approval from Sam", failureReason: "review failed" });
		expect(set.text).toBe("Updated #1");
		expect(set.details.tasks[0]).toMatchObject({ waitingReason: "approval from Sam", failureReason: "review failed" });
		expect((await callTool(host, ctx, { action: "get", id: 1 })).text).toBe("#1 [pending] A\n  waiting: approval from Sam\n  failed: review failed");
		const cleared = await callTool(host, ctx, { action: "update", id: 1, waitingReason: "", failureReason: "" });
		expect(cleared.details.tasks[0]).toEqual({ id: 1, subject: "A", status: "pending" });
	});

	it("reports an unchanged reason as no change", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A" });
		await callTool(host, ctx, { action: "update", id: 1, waitingReason: "x" });
		expect((await callTool(host, ctx, { action: "update", id: 1, waitingReason: "x" })).text).toMatch(/^No change: #1/);
	});

	it("shows reasons in list lines", async () => {
		const host = setup();
		const ctx = createCtx("s1");
		await callTool(host, ctx, { action: "create", subject: "A" });
		await callTool(host, ctx, { action: "update", id: 1, waitingReason: "input" });
		expect((await callTool(host, ctx, { action: "list" })).text).toBe("[pending] #1 A (waiting: input)");
	});

	it("keeps the schema's new fields optional so existing calls stay valid", async () => {
		const host = setup();
		const schema = host.tools.get("todo").parameters;
		expect(schema.required).toEqual(["action"]);
		for (const key of ["scope", "reason", "expectedRevision", "waitingReason", "failureReason"]) expect(Object.keys(schema.properties)).toContain(key);
	});
});

describe("normal mode: /todos command", () => {
	async function run(host: ReturnType<typeof createHost>, ctx: any) {
		await host.commands.get("todos").handler("", ctx);
	}

	it("refuses to run without a UI", async () => {
		const host = setup();
		const notes: unknown[][] = [];
		await run(host, createCtx("s1", [], { hasUI: false, ui: { notify: (...a: unknown[]) => notes.push(a) } }));
		expect(notes).toEqual([["/todos requires interactive mode", "error"]]);
	});

	it("says so when the list is empty", async () => {
		const host = setup();
		const notes: unknown[][] = [];
		await run(host, createCtx("s1", [], { hasUI: true, ui: { notify: (...a: unknown[]) => notes.push(a) } }));
		expect(notes).toEqual([["No todos yet. Ask the agent to add some!", "info"]]);
	});

	it("groups tasks by status under a count header", async () => {
		const host = setup();
		const notes: unknown[][] = [];
		const ctx = createCtx("s1", [], { hasUI: true, ui: { notify: (...a: unknown[]) => notes.push(a) } });
		await callTool(host, ctx, { action: "create", subject: "A" });
		await callTool(host, ctx, { action: "create", subject: "B" });
		await callTool(host, ctx, { action: "create", subject: "C" });
		await callTool(host, ctx, { action: "update", id: 1, status: "completed" });
		await callTool(host, ctx, { action: "update", id: 2, status: "in_progress", activeForm: "doing B" });
		await run(host, ctx);
		expect(notes).toEqual([
			["1/3 completed · 1 in progress · 1 pending\n── Pending ──\n  ○ #3 C\n── In Progress ──\n  ◐ #2 B (doing B)\n── Completed ──\n  ✓ #1 A", "info"],
		]);
	});
});
