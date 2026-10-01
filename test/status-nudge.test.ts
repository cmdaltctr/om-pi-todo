/**
 * The agent is asked once to update its task statuses before a run settles, and every update
 * result says when no task is marked in progress. Neither changes a task by itself.
 */
import { describe, expect, it } from "vitest";
import { buildNudge, statusHint } from "../src/reminder.js";
import { useCleanEnvironment } from "./helpers.js";
import { bootPanel } from "./panel-harness.js";

useCleanEnvironment();

const done = { outcome: "completed" };

async function working(names: string[], inProgress: number[] = []) {
	const t = await bootPanel();
	const ctx = t.session("s1", []);
	await t.fire("session_start", ctx);
	for (const name of names) await t.call(ctx, { action: "create", subject: name });
	for (const id of inProgress) await t.call(ctx, { action: "update", id, status: "in_progress", activeForm: "x" });
	return { t, ctx };
}

/** The first handler result that asked for a continuation. */
async function settle(t: Awaited<ReturnType<typeof bootPanel>>, ctx: unknown, event: object = done) {
	const results = await t.fire("agent_before_settle", ctx, event);
	return results.find((r) => r !== undefined) as
		| { continue?: boolean; entries?: Array<{ type: string; customType: string; content: string; display: boolean }> }
		| undefined;
}

describe("one nudge before the run settles with work in progress", () => {
	it("asks for one more turn and names every unresolved task", async () => {
		const { t, ctx } = await working(["Write tests", "Fix bug"], [1, 2]);
		const result = await settle(t, ctx);
		expect(result?.continue).toBe(true);
		expect(result?.entries).toHaveLength(1);
		const entry = result!.entries![0];
		expect(entry).toMatchObject({ type: "custom_message", customType: "todo-status-nudge", display: true });
		expect(entry.content).toContain("#1 Write tests");
		expect(entry.content).toContain("#2 Fix bug");
		expect(entry.content).toContain("completed");
		expect(entry.content).toContain("waitingReason");
	});

	it("nudges once per prompt, however many times the run settles", async () => {
		const { t, ctx } = await working(["A"], [1]);
		expect((await settle(t, ctx))?.continue).toBe(true);
		expect(await settle(t, ctx)).toBeUndefined();
		expect(await settle(t, ctx)).toBeUndefined();
	});

	it("nudges again after the next prompt starts", async () => {
		const { t, ctx } = await working(["A"], [1]);
		expect((await settle(t, ctx))?.continue).toBe(true);
		await t.fire("before_agent_start", ctx, { prompt: "next" });
		expect((await settle(t, ctx))?.continue).toBe(true);
	});

	it("stays quiet when no task is in progress", async () => {
		const { t, ctx } = await working(["A", "B"]);
		await t.call(ctx, { action: "update", id: 2, status: "completed" });
		expect(await settle(t, ctx)).toBeUndefined();
	});

	it("stays quiet for a task that says what it waits for or why it failed", async () => {
		const { t, ctx } = await working(["Approval", "Review"], [1, 2]);
		await t.call(ctx, { action: "update", id: 1, waitingReason: "owner sign-off" });
		await t.call(ctx, { action: "update", id: 2, failureReason: "3 issues found" });
		expect(await settle(t, ctx)).toBeUndefined();
	});

	it("names only the tasks that say nothing", async () => {
		const { t, ctx } = await working(["Approval", "Forgotten"], [1, 2]);
		await t.call(ctx, { action: "update", id: 1, waitingReason: "owner sign-off" });
		const content = (await settle(t, ctx))!.entries![0].content;
		expect(content).toContain("#2 Forgotten");
		expect(content).not.toContain("Approval");
	});

	it("stays quiet after an abort or an error, when the user stopped the run", async () => {
		const { t, ctx } = await working(["A"], [1]);
		expect(await settle(t, ctx, { outcome: "aborted" })).toBeUndefined();
		expect(await settle(t, ctx, { outcome: "error" })).toBeUndefined();
		expect((await settle(t, ctx))?.continue).toBe(true); // an abort did not use up the nudge
	});

	it("never changes a task", async () => {
		const { t, ctx } = await working(["A"], [1]);
		await settle(t, ctx);
		expect((await t.call(ctx, { action: "get", id: 1 })).text).toContain("[in_progress]");
	});

	it("does nothing once the context has been replaced", async () => {
		const { t } = await working(["A"], [1]);
		const stale = {
			sessionManager: {
				getSessionId: () => {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				},
			},
		};
		expect(await settle(t, stale)).toBeUndefined();
	});
});

describe("the nudge text", () => {
	it("lists five tasks and counts the rest", () => {
		const items = Array.from({ length: 7 }, (_, i) => ({
			label: `#${i + 1}`,
			subject: `Task ${i + 1}`,
			explained: false,
		}));
		const text = buildNudge(items)!;
		expect(text).toContain("#5 Task 5");
		expect(text).not.toContain("#6 Task 6");
		expect(text).toContain("and 2 more");
	});

	it("says nothing for an empty list", () => {
		expect(buildNudge([])).toBeUndefined();
	});
});

describe("the status hint on update results", () => {
	const hint = /no task is in_progress/i;

	it("says so when a task was completed and others wait", async () => {
		const { t, ctx } = await working(["A", "B"], [1]);
		const result = await t.call(ctx, { action: "update", id: 1, status: "completed" });
		expect(result.text).toMatch(hint);
		expect(result.text).toContain("in_progress");
	});

	it("is silent while a task is in progress", async () => {
		const { t, ctx } = await working(["A", "B"]);
		const result = await t.call(ctx, { action: "update", id: 1, status: "in_progress", activeForm: "x" });
		expect(result.text).not.toMatch(hint);
	});

	it("is silent when nothing is left to start", async () => {
		const { t, ctx } = await working(["A"], [1]);
		expect((await t.call(ctx, { action: "update", id: 1, status: "completed" })).text).not.toMatch(hint);
	});

	it("is silent on create, list and get", async () => {
		const { t, ctx } = await working(["A"]);
		expect((await t.call(ctx, { action: "create", subject: "B" })).text).not.toMatch(hint);
		expect((await t.call(ctx, { action: "list" })).text).not.toMatch(hint);
		expect((await t.call(ctx, { action: "get", id: 1 })).text).not.toMatch(hint);
	});

	it("is silent on a failed call", async () => {
		const { t, ctx } = await working(["A"]);
		expect((await t.call(ctx, { action: "update", id: 99, status: "completed" })).text).not.toMatch(hint);
	});

	it("counts only tasks that can start", () => {
		expect(statusHint([{ id: 1, subject: "A", status: "completed" }])).toBeUndefined();
		expect(statusHint([{ id: 1, subject: "A", status: "pending" }])).toMatch(hint);
		expect(
			statusHint([
				{ id: 1, subject: "A", status: "in_progress" },
				{ id: 2, subject: "B", status: "pending" },
			]),
		).toBeUndefined();
	});
});
