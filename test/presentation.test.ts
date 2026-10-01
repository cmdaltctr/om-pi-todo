import { beforeEach, describe, expect, it } from "vitest";
import { __resetRunStates, evictRunState, getRunState, runStateFromAgentEnd, setRunState } from "../src/state/run-state.js";
import { presentTask, unresolvedBlockers } from "../src/view/presentation.js";
import type { Task } from "../src/tool/types.js";

const task = (id: number, status: Task["status"], over: Partial<Task> = {}): Task => ({ id, subject: `T${id}`, status, ...over });
const by = (...tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));
const present = (t: Task, all: Task[], run: "running" | "idle" | "paused") => presentTask(t, by(...all), run);

describe("run state store", () => {
	beforeEach(() => __resetRunStates());

	it("defaults to idle, so a resumed session never claims to be running", () => {
		expect(getRunState("never-seen")).toBe("idle");
	});

	it("keeps each session's state separate and forgets a session on evict", () => {
		setRunState("a", "running");
		setRunState("b", "paused");
		expect([getRunState("a"), getRunState("b"), getRunState("c")]).toEqual(["running", "paused", "idle"]);
		evictRunState("a");
		expect(getRunState("a")).toBe("idle");
		expect(getRunState("b")).toBe("paused");
	});
});

describe("run state from the end of an agent run", () => {
	const assistant = (stopReason?: string) => ({ role: "assistant", stopReason, content: [] });

	it("is idle after a normal finish and paused after an abort or an error", () => {
		expect(runStateFromAgentEnd([assistant("stop")])).toBe("idle");
		expect(runStateFromAgentEnd([assistant("toolUse")])).toBe("idle");
		expect(runStateFromAgentEnd([assistant("aborted")])).toBe("paused");
		expect(runStateFromAgentEnd([assistant("error")])).toBe("paused");
	});

	it("looks at the last assistant message only", () => {
		expect(runStateFromAgentEnd([assistant("aborted"), { role: "user" }, assistant("stop")])).toBe("idle");
		expect(runStateFromAgentEnd([assistant("stop"), { role: "toolResult" }, assistant("aborted"), { role: "toolResult" }])).toBe("paused");
	});

	it("is idle when there is nothing to read", () => {
		for (const bad of [[], undefined, null, "x", [null], [{}], [{ role: "assistant" }]]) expect(runStateFromAgentEnd(bad as never)).toBe("idle");
	});
});

describe("blockers", () => {
	it("lists only dependencies that exist and are not finished", () => {
		const all = [task(1, "completed"), task(2, "pending"), task(3, "deleted"), task(4, "in_progress"), task(5, "pending", { blockedBy: [1, 2, 3, 4, 99] })];
		expect(unresolvedBlockers(all[4], by(...all))).toEqual([2, 4]);
	});

	it("is empty with no dependencies", () => {
		expect(unresolvedBlockers(task(1, "pending"), by())).toEqual([]);
	});
});

describe("presenting a task", () => {
	it("completed stays completed whatever else is set", () => {
		const t = task(1, "completed", { blockedBy: [2], waitingReason: "x" });
		expect(present(t, [t, task(2, "pending")], "running")).toMatchObject({ kind: "completed" });
	});

	it("pending is pending", () => {
		expect(present(task(1, "pending"), [], "running")).toMatchObject({ kind: "pending", label: "pending" });
	});

	it("in progress shows as running only while the agent runs", () => {
		const t = task(1, "in_progress", { activeForm: "writing" });
		expect(present(t, [t], "running")).toMatchObject({ kind: "running", running: true });
		expect(present(t, [t], "idle")).toMatchObject({ kind: "idle", label: "Idle", running: false });
		expect(present(t, [t], "paused")).toMatchObject({ kind: "paused", label: "Paused", running: false });
	});

	it("an unresolved dependency makes the task Blocked before activity is considered, even while running", () => {
		const blocker = task(2, "pending");
		const t = task(1, "in_progress", { blockedBy: [2], activeForm: "x" });
		for (const run of ["running", "idle", "paused"] as const) {
			expect(present(t, [t, blocker], run)).toEqual({ kind: "blocked", label: "Blocked by #2", running: false, blockers: [2] });
		}
		expect(present(task(1, "pending", { blockedBy: [2, 3] }), [blocker, task(3, "in_progress")], "idle")).toMatchObject({ label: "Blocked by #2, #3" });
	});

	it("a finished or missing dependency does not block", () => {
		const t = task(1, "in_progress", { blockedBy: [2, 3, 99] });
		expect(present(t, [t, task(2, "completed"), task(3, "deleted")], "running")).toMatchObject({ kind: "running" });
	});

	it("a blocked pending task is blocked and never running", () => {
		const out = present(task(1, "pending", { blockedBy: [2] }), [task(2, "pending")], "running");
		expect(out).toMatchObject({ kind: "blocked", running: false });
	});

	it("an explicit reason does not change the kind: a waiting in-progress task is still not running when the agent stops", () => {
		const t = task(1, "in_progress", { waitingReason: "approval" });
		expect(present(t, [t], "idle")).toMatchObject({ kind: "idle", running: false });
		expect(present(t, [t], "paused")).toMatchObject({ kind: "paused" });
	});
});
