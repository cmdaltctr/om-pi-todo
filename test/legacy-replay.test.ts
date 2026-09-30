import { describe, expect, it } from "vitest";
import extension from "../src/extension.js";
import { replayFromBranch } from "../src/state/replay.js";
import { getState } from "../src/state/store.js";
import { callTool, createCtx, createHost, todoResultEntry, useCleanEnvironment } from "./helpers.js";

useCleanEnvironment();

/** Snapshot shape persisted by `@juicesharp/rpiv-todo` 2.11.0 sessions. */
const legacySnapshot = {
	action: "update",
	params: { action: "update", id: 2, status: "in_progress" },
	tasks: [
		{ id: 1, subject: "Done already", status: "completed" },
		{ id: 2, subject: "Working", status: "in_progress", activeForm: "working now", blockedBy: [1] },
		{ id: 3, subject: "Removed", status: "deleted" },
	],
	nextId: 4,
};

function start(host: ReturnType<typeof createHost>, ctx: any, event = "session_start") {
	return Promise.all((host.handlers.get(event) ?? []).map((h) => h({}, ctx)));
}

describe("legacy replay", () => {
	it("restores tasks, statuses, dependencies, and the next id from a legacy branch", () => {
		const state = replayFromBranch(createCtx("s1", [todoResultEntry(legacySnapshot)]));
		expect(state).toEqual({ tasks: legacySnapshot.tasks, nextId: 4 });
	});

	it("lets the last matching snapshot win", () => {
		const older = { ...legacySnapshot, tasks: [{ id: 1, subject: "Old", status: "pending" }], nextId: 2 };
		const state = replayFromBranch(createCtx("s1", [todoResultEntry(older), todoResultEntry(legacySnapshot)]));
		expect(state.nextId).toBe(4);
		expect(state.tasks).toHaveLength(3);
	});

	it("skips entries that are not todo tool results or carry malformed details", () => {
		const branch = [
			todoResultEntry(legacySnapshot),
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: { tasks: [], nextId: 99 } } },
			{ type: "message", message: { role: "assistant", toolName: "todo", details: { tasks: [], nextId: 99 } } },
			{ type: "custom", message: { role: "toolResult", toolName: "todo", details: { tasks: [], nextId: 99 } } },
			todoResultEntry({ tasks: [], nextId: "5" }),
			todoResultEntry({ nextId: 5 }),
			todoResultEntry(null),
		];
		expect(replayFromBranch(createCtx("s1", branch)).nextId).toBe(4);
	});

	it("returns an empty state without mutating shared defaults", () => {
		const first = replayFromBranch(createCtx("s1", []));
		expect(first).toEqual({ tasks: [], nextId: 1 });
		first.tasks.push({ id: 1, subject: "leak", status: "pending" });
		expect(replayFromBranch(createCtx("s2", [])).tasks).toEqual([]);
	});

	it("copies tasks so later edits cannot alter the session history", () => {
		const entry = todoResultEntry(legacySnapshot);
		const state = replayFromBranch(createCtx("s1", [entry]));
		state.tasks[0].status = "deleted";
		expect(legacySnapshot.tasks[0].status).toBe("completed");
	});
});

describe("legacy replay through the extension lifecycle", () => {
	it("replays on session_start, then continues numbering from the legacy next id", async () => {
		const host = createHost();
		await extension(host.pi);
		const ctx = createCtx("s1", [todoResultEntry(legacySnapshot)]);
		await start(host, ctx);
		expect(getState("s1").tasks).toEqual(legacySnapshot.tasks);
		expect((await callTool(host, ctx, { action: "create", subject: "New" })).text).toBe("Created #4: New (pending)");
	});

	it("keeps each session's replayed list in its own slot", async () => {
		const host = createHost();
		await extension(host.pi);
		await start(host, createCtx("a", [todoResultEntry(legacySnapshot)]));
		await start(host, createCtx("b", []));
		expect(getState("a").nextId).toBe(4);
		expect(getState("b")).toEqual({ tasks: [], nextId: 1 });
	});

	it("re-replays on session_compact and session_tree", async () => {
		const host = createHost();
		await extension(host.pi);
		const branch: unknown[] = [];
		const ctx = createCtx("s1", branch);
		await start(host, ctx);
		expect(getState("s1").tasks).toEqual([]);
		branch.push(todoResultEntry(legacySnapshot));
		await start(host, ctx, "session_compact");
		expect(getState("s1").nextId).toBe(4);
		branch.length = 0;
		await start(host, ctx, "session_tree");
		expect(getState("s1")).toEqual({ tasks: [], nextId: 1 });
	});

	it("evicts a session's list on shutdown", async () => {
		const host = createHost();
		await extension(host.pi);
		const ctx = createCtx("s1", [todoResultEntry(legacySnapshot)]);
		await start(host, ctx);
		await start(host, ctx, "session_shutdown");
		expect(getState("s1")).toEqual({ tasks: [], nextId: 1 });
	});
});
