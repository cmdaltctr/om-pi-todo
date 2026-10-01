/**
 * 7.3 Reproduces the situation in the supplied screenshot: tasks left pending or in
 * progress around approval and review events, with completed rows hidden on the next
 * turn. The old panel counted only visible rows, so progress read zero and unfinished
 * work looked like it was still running. Here every figure must be truthful.
 */
import { describe, expect, it } from "vitest";
import { bootPanel } from "./panel-harness.js";
import { useCleanEnvironment } from "./helpers.js";
import { md, useSyncRoot } from "./sync-harness.js";

useCleanEnvironment();
const paths = useSyncRoot();
const stop = { messages: [{ role: "assistant", stopReason: "stop" }] };
const rowFor = (lines: string[], text: string) => lines.find((l) => l.includes(text))!;

/** Drives the same story in either mode through the real tool. */
async function story(t: Awaited<ReturnType<typeof bootPanel>>, ctx: any, mode: "normal" | "sync") {
	const sync = mode === "sync";
	const id = (n: number) => n;
	let rev = "";
	const refreshRev = async () =>
		(rev = /expectedRevision "([0-9a-f]{16})"/.exec((await t.call(ctx, { action: "list" })).text)![1]);
	const update = async (params: Record<string, unknown>) => {
		if (sync) await refreshRev();
		return t.call(ctx, { action: "update", ...params, ...(sync && params.status ? { expectedRevision: rev } : {}) });
	};
	if (!sync)
		for (const subject of ["Plan", "Implement", "Get approval", "Run review", "Release"])
			await t.call(ctx, { action: "create", subject });
	await t.fire("agent_start", ctx);
	await update({ id: id(1), status: "completed" });
	await update({ id: id(2), status: "completed" });
	await update({
		id: id(3),
		status: "in_progress",
		activeForm: "waiting for sign-off",
		waitingReason: "approval from the owner",
	});
	await update({ id: id(4), failureReason: "review found 3 issues" });
	if (!sync) await t.call(ctx, { action: "update", id: 5, addBlockedBy: [3, 4] });
	else await t.call(ctx, { action: "update", id: 5, addBlockedBy: [3, 4] });
	t.render(); // the completed rows are shown once
	await t.fire("agent_end", ctx, stop);
	await t.fire("agent_settled", ctx);
	await t.fire("agent_start", ctx); // next turn: completed rows are hidden
	await t.fire("agent_end", ctx, stop);
}

describe("7.3 screenshot sequence, normal mode", () => {
	it("keeps two of five completed with the completed rows hidden, and shows what is unfinished honestly", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await story(t, ctx, "normal");
		const lines = t.render()!;
		expect(lines[0]).toBe("● Todos (2/5)"); // the old panel read (0/3) here
		expect(lines.join("\n")).not.toMatch(/Plan|Implement/); // the completed rows are hidden...
		expect(lines.at(-1)).toBe("└─ +2 more (2 completed hidden)"); // ...and the panel says so
		expect(rowFor(lines, "Get approval")).toContain("waiting: approval from the owner");
		expect(rowFor(lines, "Get approval")).toContain("Idle");
		expect(rowFor(lines, "Run review")).toContain("failed: review found 3 issues");
		expect(rowFor(lines, "Release")).toContain("Blocked by #3, #4");
	});

	it("shows no running indicator anywhere once the agent has stopped, and no blocked row is ever active", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await story(t, ctx, "normal");
		expect(t.render()!.join("\n")).not.toContain("◐");
		await t.fire("agent_start", ctx);
		const during = t.render()!;
		expect(rowFor(during, "Get approval")).toContain("◐"); // running while the agent works
		expect(rowFor(during, "Release")).not.toContain("◐"); // blocked never runs
		expect(rowFor(during, "Release")).toContain("Blocked");
	});

	it("matches /todos, and leaves every status untouched by the lifecycle", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await story(t, ctx, "normal");
		await t.command("todos", ctx);
		expect(t.notes.at(-1)!.message.split("\n")[0]).toBe("2/5 completed · 1 in progress · 2 pending");
		expect((await t.call(ctx, { action: "get", id: 3 })).text).toContain("#3 [in_progress] Get approval");
	});

	it("one reminder named the unresolved task when the agent settled", async () => {
		const t = await bootPanel();
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		await story(t, ctx, "normal");
		const reminders = t.notes.filter((n) => n.message.startsWith("Reminder:"));
		expect(reminders).toHaveLength(1);
		expect(reminders[0].message).toContain("#3 Get approval");
	});
});

describe("7.3 screenshot sequence, OpenSpec sync mode", () => {
	const plan = md(
		"- [ ] 1.1 Plan",
		"- [ ] 1.2 Implement",
		"- [ ] 1.3 Get approval",
		"- [ ] 1.4 Run review",
		"- [ ] 1.5 Release",
	);

	it("keeps OpenSpec totals truthful, writes only the two completed boxes, and shows the same honesty", async () => {
		const t = await bootPanel({ paths, content: plan });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		await story(t, ctx, "sync");
		const lines = t.render()!;
		expect(lines[0]).toBe("● Todos · OpenSpec 2/5");
		expect(lines.join("\n")).not.toMatch(/1\.1 Plan|1\.2 Implement/);
		expect(lines.at(-1)).toBe("└─ +2 more (2 completed hidden)");
		expect(rowFor(lines, "1.3 Get approval")).toContain("waiting: approval from the owner");
		expect(rowFor(lines, "1.3 Get approval")).toContain("Idle");
		expect(rowFor(lines, "1.4 Run review")).toContain("failed: review found 3 issues");
		expect(rowFor(lines, "1.5 Release")).toContain("Blocked by #3, #4");
		expect(lines.join("\n")).not.toContain("◐");
		expect(t.disk().toString()).toBe(
			md(
				"- [x] 1.1 Plan",
				"- [x] 1.2 Implement",
				"- [ ] 1.3 Get approval",
				"- [ ] 1.4 Run review",
				"- [ ] 1.5 Release",
			),
		);
	});

	it("/todos and the panel report the same two-of-five", async () => {
		const t = await bootPanel({ paths, content: plan });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		await story(t, ctx, "sync");
		await t.command("todos", ctx);
		expect(t.notes.at(-1)!.message).toContain("OpenSpec tasks: 2/5 checked, 3 remaining");
		expect(t.render()![0]).toContain("OpenSpec 2/5");
	});

	it("approval is never inferred: the unfinished task stays unchecked however long it waits", async () => {
		const t = await bootPanel({ paths, content: plan });
		const ctx = t.session();
		await t.fire("session_start", ctx);
		await t.settle();
		await story(t, ctx, "sync");
		for (let turn = 0; turn < 3; turn++) {
			await t.fire("agent_start", ctx);
			await t.fire("agent_end", ctx, stop);
			await t.fire("agent_settled", ctx);
		}
		expect(t.disk().toString()).toContain("- [ ] 1.3 Get approval");
		expect(t.renames).toHaveBeenCalledTimes(2);
	});
});
