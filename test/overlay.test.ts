import { describe, expect, it, vi } from "vitest";
import type { RunState } from "../src/state/run-state.js";
import type { TaskState } from "../src/state/state.js";
import { TodoOverlay } from "../src/todo-overlay.js";
import type { Task } from "../src/tool/types.js";
import type { PanelModel } from "../src/view/panel-model.js";

const theme: any = new Proxy({}, { get: (_t, key) => (key === "fg" || key === "bg" ? (_c: string, text: string) => text : (text: string) => text) });
const task = (id: number, status: Task["status"], over: Partial<Task> = {}): Task => ({ id, subject: `Task ${id}`, status, ...over });

/** An overlay wired to a fake widget host. `state` and `run` can be changed between renders. */
function build(initial: Task[], options: { sections?: PanelModel["sections"]; run?: RunState; budget?: number } = {}) {
	const model = { state: { tasks: initial, nextId: initial.reduce((m, t) => Math.max(m, t.id + 1), 1) } as TaskState, sections: options.sections };
	const run = { value: options.run ?? ("idle" as RunState) };
	const overlay = new TodoOverlay(() => ({ state: model.state, sections: model.sections }), () => run.value);
	let factory: any;
	const requestRender = vi.fn();
	const setWidget = vi.fn((_key: string, f: unknown) => void (factory = f));
	overlay.setUICtx({ setWidget, theme, getToolsExpanded: () => false } as any);
	const render = (): string[] => (factory ? (factory({ requestRender }, theme).render(120) as string[]).filter((l) => l !== "") : []);
	const set = (tasks: Task[], nextId?: number) => void (model.state = { tasks, nextId: nextId ?? tasks.reduce((m, t) => Math.max(m, t.id + 1), 1) });
	return { overlay, model, run, render, set, setWidget, requestRender, registered: () => overlay.isRegistered() };
}

describe("heading counts every non-deleted task, before any row is hidden", () => {
	it("keeps 2 of 5 after two completed rows are hidden on the next turn, and says so", () => {
		const t = build([task(1, "completed"), task(2, "completed"), task(3, "pending"), task(4, "pending"), task(5, "pending")]);
		t.overlay.update();
		expect(t.render()[0]).toBe("● Todos (2/5)");
		expect(t.render().filter((l) => /Task [12]/.test(l))).toHaveLength(2);
		t.overlay.hideCompletedTasksFromPreviousTurn();
		const lines = t.render();
		expect(lines[0]).toBe("● Todos (2/5)");
		expect(lines.join("\n")).not.toMatch(/Task [12]\b/);
		expect(lines.join("\n")).toContain("Task 3");
		expect(lines[lines.length - 1]).toBe("└─ +2 more (2 completed hidden)");
	});

	it("matches the totals /todos reports", () => {
		const tasks = [task(1, "completed"), task(2, "in_progress"), task(3, "pending"), task(4, "deleted")];
		const t = build(tasks);
		t.overlay.update();
		t.overlay.hideCompletedTasksFromPreviousTurn();
		expect(t.render()[0]).toBe("● Todos (1/3)"); // deleted rows are not counted, the hidden completed row is
	});

	it("does not reset the completed count when a row is hidden on a later turn", () => {
		const t = build([task(1, "completed"), task(2, "pending")]);
		t.overlay.update();
		t.overlay.hideCompletedTasksFromPreviousTurn();
		t.set([task(1, "completed"), task(2, "completed"), task(3, "pending")]);
		t.overlay.update();
		expect(t.render()[0]).toBe("● Todos (2/3)");
		t.overlay.hideCompletedTasksFromPreviousTurn();
		expect(t.render()[0]).toBe("● Todos (2/3)");
	});

	it("reports hidden completed rows and overflow separately when the budget is tight", () => {
		const tasks = [task(1, "completed"), ...Array.from({ length: 14 }, (_, i) => task(i + 2, "pending"))];
		const t = build(tasks);
		t.overlay.update();
		const last = t.render().at(-1)!;
		expect(last).toMatch(/^└─ \+\d+ more \(1 completed hidden, \d+ pending\)$/);
		expect(t.render()[0]).toBe("● Todos (1/15)");
	});
});

describe("an all-completed list keeps a compact summary", () => {
	it("stays registered after the completed rows are hidden", () => {
		const t = build([task(1, "completed"), task(2, "completed"), task(3, "completed")]);
		t.overlay.update();
		expect(t.render().join("\n")).toContain("Task 1");
		expect(t.render()[0]).toBe("○ Todos (3/3)");
		t.overlay.hideCompletedTasksFromPreviousTurn();
		t.overlay.update();
		expect(t.registered()).toBe(true);
		expect(t.render()).toEqual(["○ Todos (3/3)", "└─ all completed (3 rows hidden)"]);
	});

	it("does not disappear on later repaints or next turns", () => {
		const t = build([task(1, "completed")]);
		t.overlay.update();
		t.render(); // the row is displayed once, which is what lets the next turn hide it
		for (let i = 0; i < 3; i++) {
			t.overlay.hideCompletedTasksFromPreviousTurn();
			t.overlay.update();
		}
		expect(t.registered()).toBe(true);
		expect(t.render()).toEqual(["○ Todos (1/1)", "└─ all completed (1 rows hidden)".replace("1 rows", "1 row")]);
	});

	it("goes away when the list is cleared", () => {
		const t = build([task(1, "completed"), task(2, "completed")]);
		t.overlay.update();
		t.render();
		t.overlay.hideCompletedTasksFromPreviousTurn();
		t.set([], 1);
		t.overlay.update();
		expect(t.registered()).toBe(false);
		expect(t.setWidget).toHaveBeenLastCalledWith("rpiv-todos", undefined);
	});

	it("is replaced when the list is replaced, and the new rows are not treated as already hidden", () => {
		const t = build([task(1, "completed"), task(2, "completed"), task(3, "completed")]);
		t.overlay.update();
		t.render();
		t.overlay.hideCompletedTasksFromPreviousTurn();
		t.set([task(1, "pending")], 2); // a new list whose next id is lower than before
		t.overlay.update();
		expect(t.render().join("\n")).toContain("Task 1");
		expect(t.render()[0]).toBe("● Todos (0/1)");
	});

	it("a replacement list does not inherit hidden rows from the old one, even for the same ids", () => {
		const t = build([task(1, "completed"), task(2, "completed"), task(3, "completed")]);
		t.overlay.update();
		t.render();
		t.overlay.hideCompletedTasksFromPreviousTurn();
		expect(t.render()).toEqual(["○ Todos (3/3)", "└─ all completed (3 rows hidden)"]);
		t.set([task(1, "completed")], 2); // a new list: its next id is lower
		t.overlay.update();
		expect(t.render().join("\n")).toContain("Task 1");
		expect(t.render()[0]).toBe("○ Todos (1/1)");
	});

	it("a list holding only deleted tasks shows nothing and counts nothing", () => {
		const t = build([task(1, "pending")]);
		t.overlay.update();
		t.set([task(1, "deleted"), task(2, "deleted")]);
		expect(t.render()).toEqual([]);
		t.overlay.update();
		expect(t.registered()).toBe(false);
	});

	it("still shows the rows when nothing is hidden yet", () => {
		const t = build([task(1, "completed"), task(2, "completed")]);
		t.overlay.update();
		expect(t.render().join("\n")).toContain("Task 2");
		expect(t.render().join("\n")).not.toContain("all completed");
	});
});

describe("sync mode headings keep OpenSpec and incidental progress apart", () => {
	const tasks = [task(1, "completed"), task(2, "pending"), task(3, "pending"), task(1_000_001, "completed"), task(1_000_002, "pending")];

	it("labels each, using OpenSpec's own numbers", () => {
		const t = build(tasks, { sections: { openspec: { complete: 1, total: 3, freshness: "fresh" }, incidental: { complete: 1, total: 2 } } });
		t.overlay.update();
		expect(t.render()[0]).toBe("● Todos · OpenSpec 1/3 · incidental 1/2");
	});

	it("omits the incidental label when there are none", () => {
		const t = build(tasks.slice(0, 3), { sections: { openspec: { complete: 1, total: 3, freshness: "fresh" }, incidental: { complete: 0, total: 0 } } });
		t.overlay.update();
		expect(t.render()[0]).toBe("● Todos · OpenSpec 1/3");
	});

	it("marks a stale or unavailable view in the heading", () => {
		for (const freshness of ["stale", "unavailable"] as const) {
			const t = build(tasks.slice(0, 3), { sections: { openspec: { complete: 1, total: 3, freshness }, incidental: { complete: 0, total: 0 } } });
			t.overlay.update();
			expect(t.render()[0]).toBe(`● Todos · OpenSpec 1/3 ⚠ ${freshness}`);
		}
	});

	it("keeps both totals when completed rows are hidden", () => {
		const t = build(tasks, { sections: { openspec: { complete: 1, total: 3, freshness: "fresh" }, incidental: { complete: 1, total: 2 } } });
		t.overlay.update();
		t.render();
		t.overlay.hideCompletedTasksFromPreviousTurn();
		expect(t.render()[0]).toBe("● Todos · OpenSpec 1/3 · incidental 1/2");
		expect(t.render().at(-1)).toBe("└─ +2 more (2 completed hidden)");
	});
});

describe("rows say what the task is doing, not just what its status is", () => {
	const row = (lines: string[], n: number) => lines.find((l) => l.includes(`Task ${n}`))!;

	it("an in-progress task shows its activity only while the agent runs", () => {
		const t = build([task(1, "in_progress", { activeForm: "writing tests" })], { run: "running" });
		t.overlay.update();
		expect(row(t.render(), 1)).toBe("├─ ◐ Task 1 (writing tests)".replace("├─", "└─"));
		t.run.value = "idle";
		expect(row(t.render(), 1)).toBe("└─ ◌ Task 1 Idle");
		t.run.value = "paused";
		expect(row(t.render(), 1)).toBe("└─ ◌ Task 1 Paused");
	});

	it("no running indicator appears when the saved status alone says in progress", () => {
		const t = build([task(1, "in_progress", { activeForm: "writing" })]);
		t.overlay.update();
		expect(t.render().join("\n")).not.toContain("◐");
		expect(t.render().join("\n")).not.toContain("writing");
	});

	it("a task with an unresolved dependency is Blocked and never running, whatever the run state", () => {
		for (const run of ["running", "idle", "paused"] as const) {
			const t = build([task(1, "pending"), task(2, "in_progress", { blockedBy: [1], activeForm: "x" })], { run });
			t.overlay.update();
			const line = row(t.render(), 2);
			expect(line).toContain("⊘");
			expect(line).toContain("Blocked by #1");
			expect(line).not.toContain("◐");
			expect(line).not.toContain("(x)");
		}
	});

	it("a resolved dependency no longer blocks, and still shows its marker", () => {
		const t = build([task(1, "completed"), task(2, "pending", { blockedBy: [1] })]);
		t.overlay.update();
		expect(row(t.render(), 2)).toContain("⛓ #1");
		expect(row(t.render(), 2)).not.toContain("Blocked");
	});

	it("waiting and failure reasons are shown exactly as the agent supplied them", () => {
		const t = build([task(1, "in_progress", { waitingReason: "approval from Sam" }), task(2, "pending", { failureReason: "review failed" })], { run: "running" });
		t.overlay.update();
		expect(row(t.render(), 1)).toContain("waiting: approval from Sam");
		expect(row(t.render(), 2)).toContain("failed: review failed");
	});

	it("a reason does not make a stopped task look active, and completed tasks hide their old reasons", () => {
		const t = build([task(1, "in_progress", { waitingReason: "input" }), task(2, "completed", { failureReason: "old" })], { run: "idle" });
		t.overlay.update();
		expect(row(t.render(), 1)).toContain("Idle");
		expect(row(t.render(), 1)).not.toContain("◐");
		expect(row(t.render(), 2)).not.toContain("failed");
	});

	it("strips terminal control sequences from reasons", () => {
		const t = build([task(1, "pending", { waitingReason: "a\u001b[31mred\u001b[0m\u0007" })]);
		t.overlay.update();
		expect(t.render().join("\n")).not.toMatch(/\u001b|\u0007/);
	});

	it("the heading icon follows unfinished work, not the run state", () => {
		const t = build([task(1, "in_progress")], { run: "idle" });
		t.overlay.update();
		expect(t.render()[0]).toBe("● Todos (0/1)");
	});
});

describe("repainting", () => {
	it("update schedules a render on the registered widget", () => {
		const t = build([task(1, "pending")]);
		t.overlay.update();
		t.render(); // creates the widget
		const before = t.requestRender.mock.calls.length;
		t.overlay.update();
		expect(t.requestRender.mock.calls.length).toBe(before + 1);
	});

	it("forceReregister registers again on the live host, even when the old registration looks fine", () => {
		const t = build([task(1, "pending")]);
		t.overlay.update();
		const calls = t.setWidget.mock.calls.length;
		const fresh = vi.fn();
		t.overlay.reregister({ setWidget: fresh, theme } as any);
		expect(fresh).toHaveBeenCalledTimes(1);
		expect(fresh.mock.calls[0][0]).toBe("rpiv-todos");
		expect(t.setWidget.mock.calls.length).toBe(calls);
	});

	it("reregister throws when the host cannot register, and the next update retries", () => {
		const t = build([task(1, "pending")]);
		let fail = true;
		const host: any = { theme, setWidget: () => { if (fail) throw new Error("host gone"); } };
		expect(() => t.overlay.reregister(host)).toThrow("host gone");
		expect(t.overlay.isRegistered()).toBe(false);
		fail = false;
		t.overlay.update();
		expect(t.overlay.isRegistered()).toBe(true);
	});
});
