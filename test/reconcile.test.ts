import { describe, expect, it } from "vitest";
import { type LinkedRow, reconcile } from "../src/openspec/reconcile.js";
import { listTasks, scanTasks } from "../src/openspec/tasks.js";

const FILE = "/work/project/openspec/changes/a/tasks.md";

/** What the CLI would report for this content, built with the scanner (parity is tested separately). */
function cliFor(content: string) {
	const scanned = scanTasks(content);
	return {
		tasks: listTasks(scanned).map((t) => ({ id: t.rowId, description: t.description, done: t.done })),
		total: scanned.length,
		complete: scanned.filter((t) => t.done).length,
	};
}

function run(content: string, previous: readonly LinkedRow[] = [], nextId = 1, cli = cliFor(content)) {
	return reconcile({ previous, nextId, cli, file: { path: FILE, content } });
}

const md = (...lines: string[]) => `${lines.join("\n")}\n`;
const ids = (rows: readonly LinkedRow[]) => rows.map((r) => r.id);
const words = (rows: readonly LinkedRow[]) => rows.map((r) => r.description);
const withActivity = (rows: readonly LinkedRow[], id: number, activity: LinkedRow["activity"]) =>
	rows.map((r) => (r.id === id ? { ...r, activity } : r));

describe("first import", () => {
	it("numbers rows from 1 in file order, with authoritative wording and state", () => {
		const r = run(md("- [x] 1.1 Done", "- [ ] 1.2 Open"));
		expect(r.rows.map((x) => [x.id, x.rowId, x.description, x.done, x.label])).toEqual([
			[1, "1", "1.1 Done", true, "1.1"],
			[2, "2", "1.2 Open", false, "1.2"],
		]);
		expect(r.nextId).toBe(3);
		expect(r.writable).toBe(true);
		expect(r.diagnostics).toEqual([]);
	});

	it("maps every unique row to the file and revision, never to a CLI row number", () => {
		const r = run(md("- [ ] A", "- [ ] B"));
		for (const row of r.rows) {
			expect(row.mapping.ok).toBe(true);
			if (row.mapping.ok) {
				expect(row.mapping.file).toBe(FILE);
				expect(row.mapping.revision).toBe(r.revision);
				expect(row.mapping.fingerprint).toBe(row.fingerprint);
				expect(Object.keys(row.mapping)).not.toContain("rowId");
			}
		}
	});

	it("handles an empty file", () => {
		const r = run("");
		expect(r.rows).toEqual([]);
		expect(r.nextId).toBe(1);
		expect(r.writable).toBe(true);
	});
});

describe("revisions", () => {
	it("repeat for identical bytes and change for any byte difference", () => {
		const a = run(md("- [ ] A")).revision;
		expect(run(md("- [ ] A")).revision).toBe(a);
		expect(run(md("- [ ] A", "")).revision).not.toBe(a);
		expect(run("- [ ] A\r\n").revision).not.toBe(a);
		expect(run(md("- [x] A")).revision).not.toBe(a);
	});
});

describe("stable local ids across refreshes", () => {
	const first = () => run(md("- [ ] A", "- [ ] B", "- [ ] C"));

	it("keeps ids and session activity for unchanged rows", () => {
		const f = first();
		const active = withActivity(f.rows, 2, {
			status: "in_progress",
			activeForm: "working on B",
			owner: "me",
			blockedBy: [1],
			metadata: { k: 1 },
		});
		const again = run(md("- [ ] A", "- [ ] B", "- [ ] C"), active, f.nextId);
		expect(ids(again.rows)).toEqual([1, 2, 3]);
		expect(again.rows[1].activity).toEqual({
			status: "in_progress",
			activeForm: "working on B",
			owner: "me",
			blockedBy: [1],
			metadata: { k: 1 },
		});
	});

	it("follows wording when rows are reordered, and updates CLI row numbers", () => {
		const f = first();
		const active = withActivity(f.rows, 3, { status: "in_progress", activeForm: "C" });
		const again = run(md("- [ ] C", "- [ ] A", "- [ ] B"), active, f.nextId);
		expect(words(again.rows)).toEqual(["C", "A", "B"]);
		expect(ids(again.rows)).toEqual([3, 1, 2]);
		expect(again.rows.map((r) => r.rowId)).toEqual(["1", "2", "3"]);
		expect(again.rows[0].activity).toEqual({ status: "in_progress", activeForm: "C" });
		expect(again.revision).not.toBe(f.revision);
	});

	it("gives an inserted row a new id and leaves the rest alone", () => {
		const f = first();
		const again = run(md("- [ ] A", "- [ ] New", "- [ ] B", "- [ ] C"), f.rows, f.nextId);
		expect(ids(again.rows)).toEqual([1, 4, 2, 3]);
		expect(again.nextId).toBe(5);
	});

	it("treats a rewritten description as a new row and drops the old id and its activity", () => {
		const f = first();
		const active = withActivity(f.rows, 2, { status: "in_progress", activeForm: "B" });
		const again = run(md("- [ ] A", "- [ ] B reworded", "- [ ] C"), active, f.nextId);
		expect(ids(again.rows)).toEqual([1, 4, 3]);
		expect(again.removed).toEqual([2]);
		expect(again.rows[1].activity).toBeUndefined();
	});

	it("removes a deleted row and never reuses its id, even if the wording returns", () => {
		const f = first();
		const without = run(md("- [ ] A", "- [ ] C"), f.rows, f.nextId);
		expect(ids(without.rows)).toEqual([1, 3]);
		expect(without.removed).toEqual([2]);
		const back = run(md("- [ ] A", "- [ ] B", "- [ ] C"), without.rows, without.nextId);
		expect(ids(back.rows)).toEqual([1, 4, 3]);
	});

	it("does not mutate its inputs", () => {
		const f = first();
		const snapshot = JSON.stringify(f.rows);
		run(md("- [ ] X"), f.rows, f.nextId);
		expect(JSON.stringify(f.rows)).toBe(snapshot);
	});

	it("never hands out one id twice, even when the previous state repeats an id", () => {
		const f = run(md("- [ ] A", "- [ ] B"));
		const corrupt = f.rows.map((r) => ({ ...r, id: 1 }));
		const again = run(md("- [ ] A", "- [ ] B"), corrupt, 3);
		expect(new Set(ids(again.rows)).size).toBe(2);
	});

	it("does not copy nested activity by reference from the previous rows", () => {
		const f = run(md("- [ ] A"));
		const active = withActivity(f.rows, 1, { status: "in_progress", blockedBy: [9], metadata: { list: [1] } });
		const again = run(md("- [ ] A"), active, f.nextId);
		again.rows[0].activity!.blockedBy!.push(10);
		(again.rows[0].activity!.metadata!.list as number[]).push(2);
		expect(active[0].activity).toEqual({ status: "in_progress", blockedBy: [9], metadata: { list: [1] } });
	});

	it("treats case and punctuation changes as a rewrite but ignores spacing", () => {
		const f = run(md("- [ ] Do the thing"));
		expect(ids(run(md("- [ ] do the thing"), f.rows, f.nextId).rows)).toEqual([2]);
		expect(ids(run(md("- [ ]   Do   the thing  "), f.rows, f.nextId).rows)).toEqual([1]);
	});
});

describe("completion comes from the file", () => {
	it("shows an externally checked task as done and clears its in-progress activity", () => {
		const f = run(md("- [ ] A"));
		const active = withActivity(f.rows, 1, {
			status: "in_progress",
			activeForm: "A",
			owner: "me",
			blockedBy: [],
			metadata: { k: 1 },
		});
		const again = run(md("- [x] A"), active, f.nextId);
		expect(again.rows[0].done).toBe(true);
		expect(again.rows[0].activity).toEqual({ owner: "me", blockedBy: [], metadata: { k: 1 } });
	});

	it("reopens an externally unchecked task as pending with no stale activity", () => {
		const f = run(md("- [x] A"));
		const again = run(md("- [ ] A"), f.rows, f.nextId);
		expect(again.rows[0].done).toBe(false);
		expect(again.rows[0].activity?.status).toBeUndefined();
	});

	it("takes completion from the CLI list even when local state says otherwise", () => {
		const f = run(md("- [ ] A"));
		const stale = f.rows.map((r) => ({ ...r, done: true }));
		expect(run(md("- [ ] A"), stale, f.nextId).rows[0].done).toBe(false);
	});
});

describe("ambiguous mappings are refused", () => {
	const reason = (row: LinkedRow) => (row.mapping.ok ? undefined : row.mapping.reason);

	it("marks duplicate wording unmappable but keeps ids stable by occurrence", () => {
		const f = run(md("- [ ] Same", "- [ ] Same", "- [ ] Other"));
		expect(f.rows.map((r) => r.mapping.ok)).toEqual([false, false, true]);
		expect(reason(f.rows[0])).toMatch(/duplicate task wording/);
		expect(f.writable).toBe(true);
		const again = run(md("- [ ] Same", "- [ ] Same", "- [ ] Other"), f.rows, f.nextId);
		expect(ids(again.rows)).toEqual([1, 2, 3]);
	});

	it("does not carry activity onto ambiguous rows", () => {
		const f = run(md("- [ ] Same", "- [ ] Same"));
		const active = withActivity(f.rows, 1, { status: "in_progress", activeForm: "x" });
		expect(run(md("- [ ] Same", "- [ ] Same"), active, f.nextId).rows[0].activity).toBeUndefined();
	});

	it("does not move activity onto a row that was ambiguous before it became unique", () => {
		const f = run(md("- [ ] Same", "- [ ] Same"));
		const active = withActivity(f.rows, 1, { status: "in_progress", activeForm: "x" });
		const again = run(md("- [ ] Same"), active, f.nextId);
		expect(again.rows[0].mapping.ok).toBe(true);
		expect(again.rows[0].activity).toBeUndefined();
	});

	it("makes a row mappable again once the wording is unique", () => {
		const f = run(md("- [ ] Same", "- [ ] Same"));
		const again = run(md("- [ ] Same", "- [ ] Same changed"), f.rows, f.nextId);
		expect(again.rows.map((r) => r.mapping.ok)).toEqual([true, true]);
	});

	it("marks rows that share a label unmappable", () => {
		const f = run(md("- [ ] 1.1 First", "- [ ] 1.1 Second", "- [ ] 1.2 Third"));
		expect(f.rows.map((r) => r.mapping.ok)).toEqual([false, false, true]);
		expect(reason(f.rows[0])).toMatch(/duplicate task label 1\.1/);
	});

	it("reports boxes without text as counted but untrackable, without blocking others", () => {
		const f = run(md("- [ ] Real", "- [ ]", "- []"));
		expect(f.rows).toHaveLength(1);
		expect(f.rows[0].mapping.ok).toBe(true);
		expect(f.diagnostics).toEqual([
			"2 checkboxes without text are counted by OpenSpec but cannot be tracked. Add wording in tasks.md.",
		]);
		expect(f.writable).toBe(true);
	});
});

describe("file and CLI disagree", () => {
	const content = md("- [ ] A", "- [ ] B");
	const base = cliFor(content);
	const cases: Array<[string, typeof base]> = [
		["different wording", { ...base, tasks: [base.tasks[0], { ...base.tasks[1], description: "B edited" }] }],
		["fewer rows", { ...base, tasks: [base.tasks[0]] }],
		["extra row", { ...base, tasks: [...base.tasks, { id: "3", description: "C", done: false }] }],
		["different done state", { ...base, tasks: [{ ...base.tasks[0], done: true }, base.tasks[1]] }],
		["different total", { ...base, total: 5 }],
		["different completed count", { ...base, complete: 1 }],
	];
	for (const [name, cli] of cases) {
		it(`disables writes when the CLI shows ${name}`, () => {
			const r = run(content, [], 1, cli);
			expect(r.writable).toBe(false);
			expect(r.diagnostics.join(" ")).toMatch(/does not match the CLI/);
			expect(r.rows.every((row) => !row.mapping.ok)).toBe(true);
		});
	}

	it("still shows the CLI's rows so the view stays honest", () => {
		const cli = { ...base, tasks: [{ id: "1", description: "A", done: true }] };
		const r = run(content, [], 1, { ...cli, total: 1, complete: 1 });
		expect(r.rows.map((x) => [x.description, x.done])).toEqual([["A", true]]);
	});

	it("keeps ids stable while writes are disabled", () => {
		const f = run(content);
		const r = run(content, f.rows, f.nextId, { ...base, total: 9 });
		expect(ids(r.rows)).toEqual([1, 2]);
	});
});
