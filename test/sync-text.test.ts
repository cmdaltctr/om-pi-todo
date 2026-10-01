import { describe, expect, it } from "vitest";
import type { LinkedRow } from "../src/openspec/reconcile.js";
import type { Snapshot } from "../src/openspec/snapshot.js";
import { fingerprint } from "../src/openspec/tasks.js";
import {
	describeLinked,
	describeSnapshot,
	INCIDENTAL_ID_OFFSET,
	linkedToTask,
	projectPanelModel,
	projectPanelState,
} from "../src/sync/text.js";
import type { Task } from "../src/tool/types.js";

const row = (id: number, description: string, over: Partial<LinkedRow> = {}): LinkedRow => ({
	id,
	rowId: String(id),
	description,
	fingerprint: fingerprint(description),
	done: false,
	mapping: { ok: true, file: "/r/tasks.md", fingerprint: fingerprint(description), revision: "rev1" },
	...over,
});

const counts = (tasks: Task[]) => ({ total: tasks.length, pending: 0, inProgress: 0, completed: 0 });

function snap(over: Partial<Snapshot> = {}): Snapshot {
	return {
		mode: "openspec",
		binding: { root: "/r", change: "add-thing" },
		freshness: "fresh",
		writable: true,
		refreshing: false,
		needsReselect: false,
		planning: { isComplete: true, artifacts: [] },
		implementation: { state: "ready", total: 3, complete: 1, remaining: 2 },
		linked: [row(1, "1.1 Done", { done: true }), row(2, "1.2 Open"), row(3, "1.3 Later")],
		linkedNextId: 4,
		ordinary: [],
		ordinaryCounts: counts([]),
		revision: "rev1",
		file: "/r/tasks.md",
		notes: [],
		diagnostics: [],
		...over,
	};
}

describe("describing the view", () => {
	it("shows mode, change, root, freshness, revision, separate readiness and progress, then the linked tasks", () => {
		expect(describeSnapshot(snap())).toEqual([
			"OpenSpec sync: add-thing (/r) · fresh · revision rev1",
			"Planning artefacts: complete (readiness only, not implementation progress).",
			"OpenSpec tasks: 1/3 checked, 2 remaining. A checked box records task progress; it does not show that tests passed or that the work was verified.",
			"Linked tasks (from tasks.md):",
			"[completed] #1 1.1 Done",
			"[pending] #2 1.2 Open",
			"[pending] #3 1.3 Later",
			"Incidental tasks: none.",
		]);
	});

	it("says a read is running while still showing the last committed view", () => {
		const out = describeSnapshot(snap({ refreshing: true }));
		expect(out[0]).toBe(
			"OpenSpec sync: add-thing (/r) · fresh · revision rev1 · refreshing, showing the last committed view",
		);
		expect(out.join("\n")).toContain("[pending] #2 1.2 Open");
		expect(describeSnapshot(snap())[0]).not.toContain("refreshing");
	});

	it("never presents complete planning as implementation progress", () => {
		const lines = describeSnapshot(
			snap({
				planning: { isComplete: true, artifacts: [] },
				implementation: { state: "ready", total: 3, complete: 0, remaining: 3 },
			}),
		).join("\n");
		expect(lines).toContain("Planning artefacts: complete (readiness only");
		expect(lines).toContain("0/3 checked, 3 remaining");
		expect(lines).not.toMatch(/all done|implementation complete/i);
	});

	it("reports incomplete planning", () => {
		expect(describeSnapshot(snap({ planning: { isComplete: false, artifacts: [] } })).join("\n")).toContain(
			"Planning artefacts: incomplete",
		);
	});

	it("keeps incidental tasks in their own section, labelled and outside OpenSpec totals", () => {
		const ordinary: Task[] = [
			{
				id: 1,
				subject: "Debug flaky test",
				status: "in_progress",
				activeForm: "debugging",
				metadata: { reason: "temporary step" },
			},
		];
		const lines = describeSnapshot(snap({ ordinary }));
		expect(lines.slice(-2)).toEqual([
			`Incidental tasks (scope "incidental"; not counted in OpenSpec progress):`,
			"[in_progress] #1 Debug flaky test (debugging) (incidental: temporary step)",
		]);
		expect(lines.join("\n")).toContain("1/3 checked"); // unchanged by the incidental task
	});

	it("shows session activity, blockers, owners and reasons on linked rows", () => {
		const linked = [
			row(1, "A", { done: true }),
			row(2, "B", { activity: { status: "in_progress", activeForm: "writing B", owner: "me" } }),
			row(3, "C", { activity: { blockedBy: [2], waitingReason: "approval from Sam" } }),
			row(4, "D", { activity: { failureReason: "review failed" } }),
		];
		const out = describeSnapshot(snap({ linked })).join("\n");
		expect(out).toContain("[in_progress] #2 B (writing B)");
		expect(out).toContain("[pending] #3 C (waiting: approval from Sam) ⛓ #2");
		expect(out).toContain("[pending] #4 D (failed: review failed)");
	});

	it("puts a checked box ahead of stale in-progress activity", () => {
		const out = describeSnapshot(
			snap({ linked: [row(1, "A", { done: true, activity: { status: "in_progress", activeForm: "x" } })] }),
		).join("\n");
		expect(out).toContain("[completed] #1 A");
		expect(out).not.toContain("in_progress");
	});

	it("marks unmappable rows read-only with the reason", () => {
		const r = row(1, "Same", { mapping: { ok: false, reason: "duplicate task wording (2 identical rows)." } });
		expect(describeSnapshot(snap({ linked: [r] })).join("\n")).toContain(
			"[pending] #1 Same (read-only: duplicate task wording (2 identical rows).)",
		);
	});

	it("filters every section by status and hides deleted incidental tasks unless asked", () => {
		const ordinary: Task[] = [
			{ id: 1, subject: "A", status: "pending" },
			{ id: 2, subject: "B", status: "deleted" },
		];
		expect(describeSnapshot(snap({ ordinary })).join("\n")).not.toContain("#2 B");
		expect(describeSnapshot(snap({ ordinary }), { includeDeleted: true }).join("\n")).toContain("[deleted] #2 B");
		const completed = describeSnapshot(snap({ ordinary }), { status: "completed" });
		expect(completed).toContain("[completed] #1 1.1 Done");
		expect(completed.join("\n")).not.toContain("1.2 Open");
		expect(completed.join("\n")).not.toContain("#1 A");
	});

	it("warns loudly when the view is stale or unavailable", () => {
		for (const freshness of ["stale", "unavailable"] as const) {
			const out = describeSnapshot(snap({ freshness, writable: false, diagnostics: ["OpenSpec command timed out"] }), {
				forTool: true,
			});
			expect(out).toContain(`⚠ The OpenSpec view is ${freshness}, so linked changes are disabled. Run /todos refresh.`);
			expect(out).toContain("Note: OpenSpec command timed out");
			expect(out.join("\n")).not.toContain("expectedRevision");
		}
	});

	it("explains an unbound session and a normal-mode session", () => {
		expect(
			describeSnapshot(
				snap({ binding: undefined, freshness: "unbound", linked: [], implementation: undefined, planning: undefined }),
			)[0],
		).toMatch(/no change is chosen/);
		const normal = describeSnapshot(
			snap({
				mode: "normal",
				freshness: "inactive",
				binding: undefined,
				linked: [],
				ordinary: [{ id: 1, subject: "Plain", status: "pending" }],
			}),
		);
		expect(normal).toEqual(["Normal mode: no OpenSpec file is read or written.", "[pending] #1 Plain"]);
	});

	it("offers the revision and the CLI notes to the tool, and not to /todos", () => {
		const s = snap({ notes: ["Use British English."] });
		const tool = describeSnapshot(s, { forTool: true }).join("\n");
		expect(tool).toContain('pass expectedRevision "rev1"');
		expect(tool).toContain("OpenSpec note: Use British English.");
		const human = describeSnapshot(s).join("\n");
		expect(human).not.toContain("expectedRevision");
		expect(human).not.toContain("OpenSpec note");
	});

	it("does not offer a revision when writes are disabled", () => {
		expect(describeSnapshot(snap({ writable: false }), { forTool: true }).join("\n")).not.toContain("expectedRevision");
	});

	it("strips terminal control sequences from task wording", () => {
		const out = describeSnapshot(snap({ linked: [row(1, "Bad \u001b[31mred\u001b[0m \u0007 task")] })).join("\n");
		expect(out).not.toMatch(/\u001b|\u0007/);
	});

	it("is identical for every reader of the same snapshot", () => {
		const s = snap({ ordinary: [{ id: 1, subject: "X", status: "pending" }] });
		expect(describeSnapshot(s)).toEqual(describeSnapshot(structuredClone(s)));
	});
});

describe("describing one linked task", () => {
	it("shows status, source, revision, and session fields, including derived blocks", () => {
		const linked = [
			row(1, "1.1 First", { label: "1.1" }),
			row(2, "1.2 Second", { label: "1.2", activity: { blockedBy: [1], owner: "me", waitingReason: "review" } }),
		];
		const s = snap({ linked });
		expect(describeLinked(linked[0], s)).toEqual([
			"#1 [pending] 1.1 First",
			"  source: tasks.md task 1.1 (revision rev1)",
			"  blocks: #2",
		]);
		expect(describeLinked(linked[1], s)).toEqual([
			"#2 [pending] 1.2 Second",
			"  source: tasks.md task 1.2 (revision rev1)",
			"  blockedBy: #1",
			"  owner: me",
			"  waiting: review",
		]);
	});

	it("shows why a row is read-only", () => {
		const r = row(1, "Same", { mapping: { ok: false, reason: "duplicate" } });
		expect(describeLinked(r, snap({ linked: [r] })).join("\n")).toContain("  read-only: duplicate");
	});
});

describe("panel data from the same snapshot", () => {
	it("lists linked tasks first with the same status the text shows", () => {
		const s = snap();
		const panel = projectPanelState(s);
		expect(panel.tasks.map((t) => [t.id, t.status, t.subject])).toEqual([
			[1, "completed", "1.1 Done"],
			[2, "pending", "1.2 Open"],
			[3, "pending", "1.3 Later"],
		]);
	});

	it("shifts incidental ids so they cannot collide, including their dependencies, and drops deleted ones", () => {
		const ordinary: Task[] = [
			{ id: 1, subject: "I1", status: "pending" },
			{ id: 2, subject: "I2", status: "pending", blockedBy: [1] },
			{ id: 3, subject: "gone", status: "deleted" },
		];
		const panel = projectPanelState(snap({ ordinary }));
		const inc = panel.tasks.filter((t) => t.id >= INCIDENTAL_ID_OFFSET);
		expect(inc.map((t) => [t.id, t.blockedBy])).toEqual([
			[INCIDENTAL_ID_OFFSET + 1, undefined],
			[INCIDENTAL_ID_OFFSET + 2, [INCIDENTAL_ID_OFFSET + 1]],
		]);
		expect("blockedBy" in inc[0]).toBe(false);
		expect(panel.tasks.some((t) => t.subject === "gone")).toBe(false);
	});

	it("counts the same linked tasks as the text", () => {
		const s = snap();
		const panel = projectPanelState(s);
		const text = describeSnapshot(s).filter((l) => /^\[(completed|pending|in_progress)\] #\d+ 1\./.test(l));
		expect(panel.tasks.filter((t) => t.id < INCIDENTAL_ID_OFFSET)).toHaveLength(text.length);
	});

	it("carries activity fields onto the projected task", () => {
		const t = linkedToTask(
			row(2, "B", {
				activity: {
					status: "in_progress",
					activeForm: "b",
					owner: "me",
					blockedBy: [1],
					metadata: { k: 1 },
					waitingReason: "w",
					failureReason: "f",
				},
			}),
		);
		expect(t).toEqual({
			id: 2,
			subject: "B",
			status: "in_progress",
			activeForm: "b",
			owner: "me",
			blockedBy: [1],
			metadata: { k: 1 },
			waitingReason: "w",
			failureReason: "f",
		});
	});

	it("does not let the projection alias the snapshot's activity", () => {
		const r = row(2, "B", { activity: { blockedBy: [1], metadata: { k: 1 } } });
		const t = linkedToTask(r);
		t.blockedBy!.push(9);
		t.metadata!.k = 2;
		expect(r.activity).toEqual({ blockedBy: [1], metadata: { k: 1 } });
	});

	it("keeps the next-id number falling after an incidental clear so the overlay resets its memory", () => {
		const before = projectPanelState(snap({ ordinary: [{ id: 5, subject: "x", status: "pending" }] })).nextId;
		const after = projectPanelState(snap({ ordinary: [] })).nextId;
		expect(after).toBeLessThan(before);
	});
});

describe("panel model", () => {
	it("uses OpenSpec's own totals for the heading, the same numbers /todos reports, even when the CLI counts boxes without text", () => {
		const s = snap({ implementation: { state: "ready", total: 4, complete: 1, remaining: 3 } }); // 3 tracked rows, 1 textless box
		expect(projectPanelModel(s).sections!.openspec).toMatchObject({ complete: 1, total: 4 });
		expect(describeSnapshot(s).join("\n")).toContain("1/4 checked");
	});

	it("falls back to the tracked rows when no CLI view exists", () => {
		const s = snap({ implementation: undefined, freshness: "unavailable" });
		expect(projectPanelModel(s).sections!.openspec).toEqual({
			complete: 1,
			total: 3,
			freshness: "unavailable",
			refreshing: false,
		});
		expect(projectPanelModel(snap({ refreshing: true })).sections!.openspec.refreshing).toBe(true);
	});

	it("carries freshness so the heading can warn", () => {
		for (const freshness of ["fresh", "stale", "unavailable"] as const)
			expect(projectPanelModel(snap({ freshness })).sections!.openspec.freshness).toBe(freshness);
	});

	it("counts incidental tasks apart from OpenSpec, leaving out deleted ones", () => {
		const ordinary: Task[] = [
			{ id: 1, subject: "a", status: "completed" },
			{ id: 2, subject: "b", status: "pending" },
			{ id: 3, subject: "c", status: "deleted" },
			{ id: 4, subject: "d", status: "completed" },
		];
		const model = projectPanelModel(snap({ ordinary }));
		expect(model.sections!.incidental).toEqual({ complete: 2, total: 3 });
		expect(model.sections!.openspec).toMatchObject({ complete: 1, total: 3 });
	});

	it("shares its rows with the panel state", () => {
		const s = snap({ ordinary: [{ id: 1, subject: "x", status: "pending" }] });
		expect(projectPanelModel(s).state).toEqual(projectPanelState(s));
	});
});
