import { describe, expect, it } from "vitest";
import { getSessionMode, setSessionMode } from "../src/session-mode.js";
import { describeSnapshot } from "../src/sync/text.js";
import { getState } from "../src/state/store.js";
import { buildSync, md, useSyncRoot } from "./sync-harness.js";
import { createCtx, useCleanEnvironment } from "./helpers.js";

useCleanEnvironment();
const paths = useSyncRoot();
const make = (content: string, over = {}, ids = ["s1"]) => buildSync(paths, content, over, ids);

describe("list and get read the shared snapshot", () => {
	it("list shows the same lines as the snapshot, plus the revision hint", async () => {
		const t = make(md("- [x] 1.1 Done", "- [ ] 1.2 Open"));
		const text = (await t.call({ action: "list" })).text;
		const snap = t.runtime.provider.getSnapshot("s1");
		expect(text).toBe(describeSnapshot(snap, { forTool: true }).join("\n"));
		expect(text).toContain("[completed] #1 1.1 Done");
		expect(text).toContain("[pending] #2 1.2 Open");
		expect(text).toContain(`pass expectedRevision "${snap.revision}"`);
	});

	it("/todos shows the same linked tasks and totals as list and the panel data", async () => {
		const t = make(md("- [x] 1.1 Done", "- [ ] 1.2 Open", "- [ ] 1.3 Later"));
		const notes: string[] = [];
		const ctx = createCtx("s1", [], { hasUI: true, ui: { notify: (m: string) => notes.push(m) } });
		await t.host.commands.get("todos").handler("", ctx);
		const listText = (await t.call({ action: "list" })).text;
		const snap = t.runtime.provider.getSnapshot("s1");
		const pick = (text: string) => text.split("\n").filter((l) => /^\[(completed|pending|in_progress)\] #\d+ /.test(l));
		expect(pick(notes[0])).toEqual(pick(listText));
		expect(notes[0]).toContain("1/3 checked, 2 remaining");
		expect(notes[0]).toBe(describeSnapshot(snap).join("\n"));
		const panel = t.runtime.panelState("s1");
		expect(panel.tasks.map((x) => [x.id, x.status])).toEqual(
			snap.linked.map((r) => [r.id, r.done ? "completed" : "pending"]),
		);
		expect(panel.tasks.filter((x: { status: string }) => x.status === "completed")).toHaveLength(
			snap.implementation!.complete,
		);
	});

	it("reads fresh data before every list, so an external edit is visible at once", async () => {
		const t = make(md("- [ ] A"));
		await t.call({ action: "list" });
		require("node:fs").writeFileSync(paths.tasksPath, md("- [x] A", "- [ ] B"));
		const text = (await t.call({ action: "list" })).text;
		expect(text).toContain("[completed] #1 A");
		expect(text).toContain("[pending] #2 B");
	});

	it("get shows one linked task with its source and revision", async () => {
		const t = make(md("- [ ] 1.1 First", "- [ ] 1.2 Second"));
		const out = (await t.call({ action: "get", id: 2 })).text;
		expect(out).toMatch(/^#2 \[pending\] 1\.2 Second\n  source: tasks\.md task 1\.2 \(revision [0-9a-f]{16}\)$/);
	});

	it("get and list filter by status", async () => {
		const t = make(md("- [x] A", "- [ ] B"));
		const done = (await t.call({ action: "list", status: "completed" })).text;
		expect(done).toContain("#1 A");
		expect(done).not.toContain("#2 B");
	});

	it("says which ids exist when an id is not linked, and how to reach incidental tasks", async () => {
		const t = make(md("- [ ] A"));
		const r = await t.call({ action: "get", id: 9 });
		expect(r.text).toBe(
			'Error: #9 is not a linked task (linked ids: #1). To address one of your own tasks, pass scope "incidental".',
		);
		expect(r.details.error).toBeDefined();
	});

	it("reports an unavailable view without inventing tasks", async () => {
		const t = make(md("- [ ] A"));
		await t.call({ action: "list" });
		t.cli.hooks.apply = () => ({ ok: false, kind: "timeout", message: "timed out" });
		const text = (await t.call({ action: "list" })).text;
		expect(text).toContain("⚠ The OpenSpec view is stale");
		expect(text).toContain("Note: timed out");
		expect(text).not.toContain("expectedRevision");
	});

	it("an unbound sync session lists only incidental tasks and says why", async () => {
		const t = make(md("- [ ] A"));
		setSessionMode("s1", { mode: "openspec" });
		const text = (await t.call({ action: "list" })).text;
		expect(text).toContain("no change is chosen");
		expect(t.cli.calls).toEqual([]);
	});

	it("leaves normal-mode sessions on the original path even with a runtime registered", async () => {
		const t = make(md("- [ ] A"), {}, ["s1", "plain"]);
		setSessionMode("plain", { mode: "normal" });
		expect((await t.call({ action: "create", subject: "Plain task" }, "plain")).text).toBe(
			"Created #1: Plain task (pending)",
		);
		expect(t.cli.calls).toEqual([]);
	});
});

describe("linked status updates need the current revision", () => {
	it("starting work is session activity: the file is untouched and the list shows it", async () => {
		const t = make(md("- [ ] A", "- [ ] B"));
		const rev = await t.revision();
		const before = t.disk();
		const r = await t.call({
			action: "update",
			id: 2,
			status: "in_progress",
			activeForm: "working on B",
			expectedRevision: rev,
		});
		expect(r.text).toBe(`Updated #2 (pending → in_progress) (revision ${rev})`);
		expect(t.disk().equals(before)).toBe(true);
		expect((await t.call({ action: "list" })).text).toContain("[in_progress] #2 B (working on B)");
		expect(t.runtime.panelState("s1").tasks.find((x) => x.id === 2)).toMatchObject({
			status: "in_progress",
			activeForm: "working on B",
		});
	});

	it("requires a revision and names the current one", async () => {
		const t = make(md("- [ ] A"));
		const rev = await t.revision();
		const r = await t.call({ action: "update", id: 1, status: "in_progress" });
		expect(r.text).toBe(
			`Error: expectedRevision is required to change a linked task's status. The current revision is "${rev}".`,
		);
		expect(t.runtime.provider.getSnapshot("s1").linked[0].activity).toBeUndefined();
	});

	it("rejects a stale revision and changes nothing", async () => {
		const t = make(md("- [ ] A", "- [ ] B"));
		const old = await t.revision();
		require("node:fs").writeFileSync(paths.tasksPath, md("- [ ] New", "- [ ] A", "- [ ] B"));
		const edited = t.disk();
		for (const status of ["in_progress", "completed"]) {
			const r = await t.call({ action: "update", id: 2, status, expectedRevision: old });
			expect(r.text).toMatch(
				/^Error: The task file changed since you last read it .* Run list again and retry with the new revision\.$/,
			);
		}
		expect(t.disk().equals(edited)).toBe(true);
	});

	it("completes through the writer: the box is checked and the result says the CLI confirmed it", async () => {
		const t = make(md("- [x] 1.1 Done", "- [ ] 1.2 Open", "- [ ] 1.3 Later"));
		const rev = await t.revision();
		const r = await t.call({ action: "update", id: 2, status: "completed", expectedRevision: rev });
		expect(t.disk().toString()).toBe(md("- [x] 1.1 Done", "- [x] 1.2 Open", "- [ ] 1.3 Later"));
		expect(r.text).toMatch(
			/^Updated #2 \(pending → completed\)\. The checkbox was written and the OpenSpec CLI confirmed this task as done\. Revision [0-9a-f]{16}\. OpenSpec tasks: 2\/3 checked \(recorded progress; it does not show that tests passed\)\.\nHint: no task is in_progress\. Mark the next task in_progress with todo update before you start it\.$/,
		);
		expect(r.details.error).toBeUndefined();
		const after = t.runtime.provider.getSnapshot("s1");
		expect(after.revision).not.toBe(rev);
		expect(after.linked.map((x) => x.done)).toEqual([true, true, false]);
		expect(t.repaints.length).toBeGreaterThan(0);
	});

	it("completing an in-progress task clears its in-progress activity but keeps owner and reasons", async () => {
		const t = make(md("- [ ] A"));
		let rev = await t.revision();
		await t.call({
			action: "update",
			id: 1,
			status: "in_progress",
			activeForm: "a",
			owner: "me",
			expectedRevision: rev,
		});
		rev = await t.revision();
		await t.call({ action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(t.runtime.provider.getSnapshot("s1").linked[0]).toMatchObject({ done: true, activity: { owner: "me" } });
	});

	it("an already checked task is a no-op success with no file write", async () => {
		const t = make(md("- [x] A"));
		const rev = await t.revision();
		const r = await t.call({ action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(r.text).toBe(`No change: #1 is already completed in tasks.md (revision ${rev}).`);
	});

	it("reports a failed write as an error and leaves the task incomplete everywhere", async () => {
		const t = make(md("- [ ] A"), {
			fs: {
				rename: async () => {
					throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
				},
			},
		});
		const rev = await t.revision();
		const r = await t.call({ action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(r.text).toMatch(/^Error: The task file could not be written: disk full/);
		expect(r.details.error).toBeDefined();
		expect(t.disk().toString()).toBe(md("- [ ] A"));
		expect(t.runtime.provider.getSnapshot("s1").linked[0].done).toBe(false);
	});

	it("does not report success when the writer persisted nothing", async () => {
		const t = make(md("- [ ] A", "- [ ] B"), { fs: { rename: async () => undefined } });
		const rev = await t.revision();
		const r = await t.call({ action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(r.text).toMatch(/^Error: Task #1 was not confirmed as done by OpenSpec/);
		expect(r.details.error).toBeDefined();
		expect(t.runtime.provider.getSnapshot("s1").linked[0].done).toBe(false);
		expect(t.runtime.provider.getSnapshot("s1").writable).toBe(false); // blocked until reconciled
		// The next tool call reconciles first; that successful read lifts the block and shows the truth.
		expect((await t.call({ action: "list" })).text).toContain("[pending] #1 A");
		expect(t.runtime.provider.getSnapshot("s1").writable).toBe(true);
		expect(t.disk().toString()).toBe(md("- [ ] A", "- [ ] B"));
	});

	it("reports a write whose confirming read failed as an error, not as success", async () => {
		const t = make(md("- [ ] A", "- [ ] B"));
		const rev = await t.revision();
		let n = 0;
		t.cli.hooks.apply = () => (++n === 3 ? { ok: false, kind: "timeout", message: "timed out" } : undefined); // refresh, writer refresh, then the confirming read
		const r = await t.call({ action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(r.text).toMatch(
			/^Error: The checkbox for task #1 was written, but the OpenSpec view could not be refreshed/,
		);
		expect(r.text).toContain("Do not repeat the completion.");
		expect(r.details.error).toBeDefined();
		expect(t.disk().toString()).toBe(md("- [x] A", "- [ ] B"));
	});

	it("applies nothing when the binding changes while an activity update is running", async () => {
		const t = make(md("- [ ] A"));
		const rev = await t.revision();
		t.cli.hooks.apply = () => {
			t.runtime.bump("s1"); // the session rebinds during the tool's own refresh
			return undefined;
		};
		const r = await t.call({ action: "update", id: 1, status: "in_progress", expectedRevision: rev });
		expect(r.text).toBe(
			"Error: The session's binding changed while this update was running. Nothing was applied. Retry.",
		);
		expect(t.runtime.provider.getSnapshot("s1").linked[0].activity).toBeUndefined();
	});

	it("reports a repaint problem as a warning on a completed write", async () => {
		const t = make(md("- [ ] A"), {
			onRepaint: () => {
				throw new Error("widget gone");
			},
		});
		const rev = await t.revision();
		const r = await t.call({ action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(r.text).toContain("CLI confirmed this task as done");
		expect(r.text).toContain("could not be repainted: widget gone");
		expect(t.disk().toString()).toBe(md("- [x] A"));
	});

	it("never reopens a completed task; the file is the way", async () => {
		const t = make(md("- [x] A"));
		const rev = await t.revision();
		for (const status of ["pending", "in_progress"]) {
			expect((await t.call({ action: "update", id: 1, status, expectedRevision: rev })).text).toBe(
				"Error: #1 is already completed in tasks.md. Reopen it by editing the file, then refresh.",
			);
		}
		expect(t.disk().toString()).toBe(md("- [x] A"));
	});

	it("an external uncheck reopens the task in the view, with no replay undoing it", async () => {
		const t = make(md("- [x] A"));
		await t.revision();
		require("node:fs").writeFileSync(paths.tasksPath, md("- [ ] A"));
		expect((await t.call({ action: "list" })).text).toContain("[pending] #1 A");
		expect(t.disk().toString()).toBe(md("- [ ] A"));
	});

	it("moving back to pending clears the in-progress state", async () => {
		const t = make(md("- [ ] A"));
		let rev = await t.revision();
		await t.call({ action: "update", id: 1, status: "in_progress", activeForm: "a", expectedRevision: rev });
		rev = await t.revision();
		await t.call({ action: "update", id: 1, status: "pending", expectedRevision: rev });
		expect(t.runtime.provider.getSnapshot("s1").linked[0].activity?.status).toBeUndefined();
	});

	it("disables linked changes while the view is stale, and again after a write goes unconfirmed", async () => {
		const t = make(md("- [ ] A"));
		const rev = await t.revision();
		t.cli.hooks.apply = () => ({ ok: false, kind: "timeout", message: "timed out" });
		const r = await t.call({ action: "update", id: 1, status: "in_progress", expectedRevision: rev });
		expect(r.text).toMatch(
			/^Error: Linked tasks cannot be changed now: timed out\. Run \/todos refresh, then retry\.$/,
		);
	});
});

describe("protected fields", () => {
	it("rejects wording changes and deletion, leaving the file unchanged", async () => {
		const t = make(md("- [ ] A"));
		const rev = await t.revision();
		const before = t.disk();
		const msg =
			"Linked task wording is owned by tasks.md and cannot be changed here. Revise the OpenSpec plan (for example with /opsx-update), then refresh.";
		expect((await t.call({ action: "update", id: 1, subject: "Renamed", expectedRevision: rev })).text).toBe(
			`Error: ${msg}`,
		);
		expect((await t.call({ action: "update", id: 1, description: "new", expectedRevision: rev })).text).toBe(
			`Error: ${msg}`,
		);
		expect((await t.call({ action: "update", id: 1, status: "deleted", expectedRevision: rev })).text).toBe(
			`Error: Linked tasks cannot be deleted here. ${msg}`,
		);
		expect((await t.call({ action: "delete", id: 1 })).text).toBe(`Error: Linked tasks cannot be deleted here. ${msg}`);
		expect(t.disk().equals(before)).toBe(true);
		expect(t.runtime.provider.getSnapshot("s1").linked).toHaveLength(1);
	});

	it("rejects an update with nothing to change", async () => {
		const t = make(md("- [ ] A"));
		expect((await t.call({ action: "update", id: 1 })).text).toMatch(
			/^Error: update requires at least one mutable field: status, activeForm/,
		);
	});

	it("refuses changes to rows that cannot be mapped to one checkbox", async () => {
		const t = make(md("- [ ] Same", "- [ ] Same"));
		const rev = await t.revision();
		expect((await t.call({ action: "update", id: 1, status: "in_progress", expectedRevision: rev })).text).toMatch(
			/^Error: Task #1 cannot be changed: duplicate task wording/,
		);
		expect((await t.call({ action: "update", id: 1, owner: "me" })).text).toMatch(/cannot be changed/);
	});
});

describe("activity without a status", () => {
	it("owner, reasons, metadata and dependencies are session-only and need no revision", async () => {
		const t = make(md("- [ ] A", "- [ ] B"));
		const before = t.disk();
		expect(
			(
				await t.call({
					action: "update",
					id: 2,
					owner: "me",
					waitingReason: "approval",
					metadata: { k: 1 },
					addBlockedBy: [1],
				})
			).text,
		).toMatch(/^Updated #2 \(revision [0-9a-f]{16}\)$/);
		const row = t.runtime.provider.getSnapshot("s1").linked[1];
		expect(row.activity).toEqual({ owner: "me", waitingReason: "approval", metadata: { k: 1 }, blockedBy: [1] });
		expect(t.disk().equals(before)).toBe(true);
		expect((await t.call({ action: "list" })).text).toContain("[pending] #2 B (waiting: approval) ⛓ #1");
	});

	it("validates dependencies: missing task, itself, cycles", async () => {
		const t = make(md("- [ ] A", "- [ ] B"));
		await t.call({ action: "update", id: 2, addBlockedBy: [1] });
		expect((await t.call({ action: "update", id: 1, addBlockedBy: [2] })).text).toBe(
			"Error: addBlockedBy would create a cycle in the blockedBy graph",
		);
		expect((await t.call({ action: "update", id: 1, addBlockedBy: [1] })).text).toBe(
			"Error: cannot block #1 on itself",
		);
		expect((await t.call({ action: "update", id: 1, addBlockedBy: [9] })).text).toBe(
			"Error: addBlockedBy: #9 not found",
		);
	});

	it("clears reasons with empty strings and reports an unchanged update", async () => {
		const t = make(md("- [ ] A"));
		await t.call({ action: "update", id: 1, failureReason: "review failed" });
		expect((await t.call({ action: "update", id: 1, failureReason: "review failed" })).text).toMatch(/^No change: #1/);
		await t.call({ action: "update", id: 1, failureReason: "" });
		expect(t.runtime.provider.getSnapshot("s1").linked[0].activity).toBeUndefined();
	});

	it("applies activity given together with a completion after the write succeeds", async () => {
		const t = make(md("- [ ] A"));
		const rev = await t.revision();
		await t.call({ action: "update", id: 1, status: "completed", owner: "me", expectedRevision: rev });
		expect(t.runtime.provider.getSnapshot("s1").linked[0]).toMatchObject({ done: true, activity: { owner: "me" } });
	});
});

describe("session activity is saved with the session", () => {
	it("results carry ids, fingerprints and activity, never wording or completion, and keep ordinary tasks replayable", async () => {
		const t = make(md("- [x] 1.1 Done", "- [ ] 1.2 Open"));
		await t.call({ action: "create", subject: "Debug step", scope: "incidental", reason: "temporary" });
		const rev = await t.revision();
		const r = await t.call({ action: "update", id: 2, status: "in_progress", activeForm: "b", expectedRevision: rev });
		expect(r.details.tasks).toEqual(getState("s1").tasks);
		expect(r.details.nextId).toBe(getState("s1").nextId);
		expect(r.details.linked?.rows.map((x: { id: number }) => x.id)).toEqual([1, 2]);
		expect(r.details.linked?.rows[1].activity).toEqual({ status: "in_progress", activeForm: "b" });
		expect(JSON.stringify(r.details.linked)).not.toMatch(/"description"|"done"|Done|Open/);
		expect(getSessionMode("s1").mode).toBe("openspec");
	});
});

describe("incidental tasks", () => {
	it("creation needs the incidental scope", async () => {
		const t = make(md("- [ ] A"));
		const r = await t.call({ action: "create", subject: "Anything" });
		expect(r.text).toMatch(
			/^Error: In OpenSpec sync mode, implementation work uses the imported tasks shown by list\./,
		);
		expect(getState("s1").tasks).toEqual([]);
	});

	it("creation needs a reason", async () => {
		const t = make(md("- [ ] A"));
		for (const reason of [undefined, "", "   "]) {
			expect((await t.call({ action: "create", subject: "X", scope: "incidental", reason })).text).toBe(
				"Error: An incidental task needs a reason. Pass reason: why this temporary step is needed.",
			);
		}
		expect(getState("s1").tasks).toEqual([]);
	});

	it("tracks a temporary step separately, with its reason, leaving OpenSpec numbers alone", async () => {
		const t = make(md("- [x] A", "- [ ] B"));
		const before = t.disk();
		const created = await t.call({
			action: "create",
			subject: "Debug flaky test",
			scope: "incidental",
			reason: "investigating a failure",
		});
		expect(created.text).toBe("Created #1: Debug flaky test (pending) [incidental]");
		expect(getState("s1").tasks[0]).toMatchObject({ metadata: { reason: "investigating a failure" } });
		const list = (await t.call({ action: "list" })).text;
		expect(list).toContain("1/2 checked");
		expect(list).toContain("[pending] #1 Debug flaky test (incidental: investigating a failure)");
		expect(list).toContain("[pending] #2 B"); // linked #2, unrelated to incidental #1
		expect(t.disk().equals(before)).toBe(true);
	});

	it("rejects copies of imported tasks by wording, spacing, label and label plus wording", async () => {
		const t = make(md("- [ ] 3.4 Implement the parser", "- [ ] Write docs"));
		const copies = [
			"3.4 Implement the parser",
			"  3.4   Implement  the parser ",
			"Implement the parser",
			"3.4 do it differently",
			"Write docs",
			"3.4",
		];
		for (const subject of copies) {
			const r = await t.call({ action: "create", subject, scope: "incidental", reason: "x" });
			expect(r.text, subject).toMatch(/^Error: This looks like a copy of linked task #\d/);
		}
		expect(getState("s1").tasks).toEqual([]);
		const r = await t.call({ action: "create", subject: "3.4 do it differently", scope: "incidental", reason: "x" });
		expect(r.text).toContain("Use #1 for that work");
	});

	it("rejects a copy given in the description, and accepts unrelated wording", async () => {
		const t = make(md("- [ ] Write docs"));
		expect(
			(
				await t.call({
					action: "create",
					subject: "Something",
					description: "Write docs",
					scope: "incidental",
					reason: "x",
				})
			).text,
		).toMatch(/copy of linked task #1/);
		expect(
			(await t.call({ action: "create", subject: "Write documentation site", scope: "incidental", reason: "x" })).text,
		).toMatch(/^Created #1/);
	});

	it("checks for copies against the last good rows even when the view is stale", async () => {
		const t = make(md("- [ ] Write docs"));
		await t.revision();
		t.cli.hooks.apply = () => ({ ok: false, kind: "timeout", message: "t" });
		expect((await t.call({ action: "create", subject: "Write docs", scope: "incidental", reason: "x" })).text).toMatch(
			/copy of linked task #1/,
		);
	});

	it("addresses its own tasks with the incidental scope, separately from linked ids", async () => {
		const t = make(md("- [ ] Linked one"));
		await t.call({ action: "create", subject: "Mine", scope: "incidental", reason: "r" });
		expect((await t.call({ action: "get", id: 1, scope: "incidental" })).text).toBe("#1 [pending] Mine");
		expect(
			(await t.call({ action: "update", id: 1, status: "in_progress", activeForm: "doing", scope: "incidental" })).text,
		).toBe("Updated #1 (pending → in_progress) [incidental]");
		expect((await t.call({ action: "get", id: 1 })).text).toMatch(/Linked one/);
	});

	it("incidental completion never changes OpenSpec progress or the file", async () => {
		const t = make(md("- [ ] A"));
		const before = t.disk();
		await t.call({ action: "create", subject: "Mine", scope: "incidental", reason: "r" });
		expect((await t.call({ action: "update", id: 1, status: "completed", scope: "incidental" })).text).toBe(
			`Updated #1 (pending → completed) [incidental]\nHint: no task is in_progress. Mark the next task in_progress with todo update before you start it.`,
		);
		const list = (await t.call({ action: "list" })).text;
		expect(list).toContain("0/1 checked");
		expect(list).toContain("[completed] #1 Mine");
		expect(t.disk().equals(before)).toBe(true);
	});

	it("labels incidental errors so they are not mistaken for linked ones", async () => {
		const t = make(md("- [ ] A"));
		expect((await t.call({ action: "update", id: 7, status: "completed", scope: "incidental" })).text).toBe(
			"Error: (incidental) #7 not found",
		);
	});

	it("deleting an incidental task leaves linked tasks alone", async () => {
		const t = make(md("- [ ] A"));
		await t.call({ action: "create", subject: "Mine", scope: "incidental", reason: "r" });
		expect((await t.call({ action: "delete", id: 1, scope: "incidental" })).text).toBe(
			`Deleted #1: Mine [incidental]\nHint: no task is in_progress. Mark the next task in_progress with todo update before you start it.`,
		);
		expect(t.runtime.provider.getSnapshot("s1").linked).toHaveLength(1);
	});

	it("clear removes only incidental tasks, reports what stayed, and never touches the file", async () => {
		const t = make(md("- [x] A", "- [ ] B"));
		const before = t.disk();
		await t.call({ action: "create", subject: "One", scope: "incidental", reason: "r" });
		await t.call({ action: "create", subject: "Two", scope: "incidental", reason: "r" });
		expect((await t.call({ action: "clear" })).text).toBe(
			"Cleared 2 incidental tasks. 2 linked OpenSpec tasks were kept and tasks.md is unchanged.",
		);
		expect(getState("s1").tasks).toEqual([]);
		expect((await t.call({ action: "list" })).text).toContain("Linked tasks (from tasks.md):");
		expect(t.disk().equals(before)).toBe(true);
	});

	it("switching to normal mode restores the ordinary list, and back keeps linked rows", async () => {
		const t = make(md("- [ ] A"));
		await t.call({ action: "create", subject: "Mine", scope: "incidental", reason: "r" });
		setSessionMode("s1", { mode: "normal" });
		expect((await t.call({ action: "list" })).text).toBe("[pending] #1 Mine");
		setSessionMode("s1", { mode: "openspec", binding: { root: paths.root, change: "a" } });
		expect((await t.call({ action: "list" })).text).toContain("Linked tasks (from tasks.md):");
		expect(t.disk().toString()).toBe(md("- [ ] A"));
	});
});
