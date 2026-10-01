/**
 * Acceptance tests for the asynchronous contract. Each holds one I/O stage open with a
 * deferred promise and checks what must still move, and what must not yet be reported.
 */
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { lockPathFor } from "../src/openspec/lock.js";
import { gate, sleep, ticksDuring, until } from "./gate.js";
import { bootPanel } from "./panel-harness.js";
import { useCleanEnvironment } from "./helpers.js";
import { md, useSyncRoot } from "./sync-harness.js";

useCleanEnvironment();
const paths = useSyncRoot();

const revisionOf = (text: string) => /expectedRevision "([0-9a-f]{16})"/.exec(text)![1];
const leftovers = () => readdirSync(dirname(paths.tasksPath)).filter((f) => f !== "tasks.md");

/** A synced session with a second, unrelated normal session, ready to use. */
async function twoSessions(content = md("- [ ] A", "- [ ] B"), runtime = {}) {
	const t = await bootPanel({ paths, content, runtime });
	const sync = t.session("sync");
	const plain = t.session("plain", []);
	await t.fire("session_start", sync); // the first session with a UI is the foreground, so sync goes first
	await t.fire("session_start", plain);
	await t.settle();
	return { t, sync, plain };
}

describe("7.5 held I/O never blocks input, rendering or unrelated sessions", () => {
	it("a slow CLI read: the committed view still renders, input and unrelated work proceed, and the view says a read is pending", async () => {
		const { t, sync, plain } = await twoSessions();
		const hold = gate();
		t.cli!.hooks.apply = async () => {
			await hold.hold();
			return undefined;
		};
		const slow = t.call(sync, { action: "list" });
		await until(() => hold.entered() > 0);

		// The loop is alive, an unrelated session works, input events dispatch, and the panel renders.
		const ticks = ticksDuring(120);
		expect((await t.call(plain, { action: "create", subject: "Unrelated" })).text).toBe("Created #1: Unrelated (pending)");
		await t.fire("agent_start", plain);
		await t.fire("agent_end", plain, { messages: [{ role: "assistant", stopReason: "stop" }] });
		await t.command("todos", plain);
		expect(await ticks).toBeGreaterThan(10);
		const lines = t.render()!;
		expect(lines.join("\n")).toContain("A");
		expect(lines[0]).toContain("OpenSpec 0/2");

		hold.release();
		await slow;
		expect(t.render()![0]).toBe("● Todos · OpenSpec 0/2");
	});

	it("while a read is pending, the heading marks it and the text says so, without dropping any row", async () => {
		const { t, sync } = await twoSessions();
		const hold = gate();
		t.cli!.hooks.apply = async () => {
			await hold.hold();
			return undefined;
		};
		writeFileSync(paths.tasksPath, md("- [x] A", "- [ ] B"));
		const slow = t.call(sync, { action: "list" });
		await until(() => hold.entered() > 0);
		await sleep(30);
		expect(t.render()![0]).toBe("● Todos · OpenSpec 0/2 ↻");
		expect(t.render()!.join("\n")).toContain("A");
		hold.release();
		const text = (await slow).text;
		expect(text).toContain("[completed] #1 A");
		expect(t.render()![0]).toBe("● Todos · OpenSpec 1/2");
	});

	it("a slow file read during a refresh blocks nothing either", async () => {
		const hold = gate();
		let first = true;
		const { t, sync, plain } = await twoSessions(md("- [ ] A"), {
			readFile: async (path: string) => {
				if (!first) await hold.hold();
				first = false;
				return (await import("node:fs/promises")).readFile(path);
			},
		});
		first = false;
		const slow = t.call(sync, { action: "list" });
		await until(() => hold.entered() > 0);
		const ticks = ticksDuring(100);
		expect((await t.call(plain, { action: "create", subject: "Other" })).text).toContain("Created #1");
		expect(await ticks).toBeGreaterThan(8);
		hold.release();
		expect((await slow).text).toContain("[pending] #1 A");
	});

	it("a held lock wait blocks only that file's writer", async () => {
		const { t, sync, plain } = await twoSessions(md("- [ ] A"), { lock: { waitMs: 3000, pollMs: 10 } });
		const rev = revisionOf((await t.call(sync, { action: "list" })).text);
		const real = (await import("node:fs")).realpathSync(paths.tasksPath);
		writeFileSync(lockPathFor(real), JSON.stringify({ pid: process.pid, host: (await import("node:os")).hostname(), createdAt: new Date().toISOString(), target: real, token: "f".repeat(32) }));
		let settled = false;
		const waiting = t.call(sync, { action: "update", id: 1, status: "completed", expectedRevision: rev }).then((r) => ((settled = true), r));
		await sleep(100);
		expect(settled).toBe(false); // waiting on the lock
		const ticks = ticksDuring(100);
		expect((await t.call(plain, { action: "create", subject: "Free" })).text).toContain("Created #1");
		expect((await t.call(sync, { action: "create", subject: "Mine", scope: "incidental", reason: "r" })).text).toContain("Created #1");
		expect(await ticks).toBeGreaterThan(8);
		expect(t.render()).toBeDefined();
		(await import("node:fs")).rmSync(lockPathFor(real));
		const result = await waiting;
		expect(result.text).toContain("CLI confirmed this task as done");
	});

	it("normal mode with every OpenSpec stage frozen is unaffected, and never starts the CLI", async () => {
		let started = 0;
		const t = await bootPanel({ runtime: { run: async () => (started++, new Promise(() => undefined)) } as any });
		const ctx = t.session("s1", []);
		await t.fire("session_start", ctx);
		const ticks = ticksDuring(80);
		await t.call(ctx, { action: "create", subject: "A" });
		await t.call(ctx, { action: "update", id: 1, status: "in_progress", activeForm: "x" });
		await t.fire("agent_start", ctx);
		await t.command("todos", ctx);
		expect(await ticks).toBeGreaterThan(8);
		expect(started).toBe(0);
		expect(t.render()![1]).toContain("A");
	});
});

describe("7.6 persistence and CLI confirmation are held independently", () => {
	async function ready() {
		const persist = gate();
		const confirm = gate();
		let applyCalls = 0;
		let sinceArm = 0;
		let armedConfirm = false;
		const { t, sync, plain } = await twoSessions(md("- [ ] A", "- [ ] B"), {
			fs: {
				rename: async (from: string, to: string) => {
					await persist.hold();
					renameSync(from, to);
				},
			},
		});
		const rev = revisionOf((await t.call(sync, { action: "list" })).text);
		t.cli!.hooks.apply = async () => {
			applyCalls++;
			// A tool update reads three times: the tool's own refresh, the writer's pre-write refresh, then the confirming read.
			if (armedConfirm && ++sinceArm === 3) await confirm.hold();
			return undefined;
		};
		return { t, sync, plain, rev, persist, confirm, arm: () => (armedConfirm = true), applyCalls: () => applyCalls };
	}

	it("held before the checkbox lands: nothing is reported, shown or written", async () => {
		const x = await ready();
		let resolved = false;
		const pending = x.t.call(x.sync, { action: "update", id: 1, status: "completed", expectedRevision: x.rev }).then((r) => ((resolved = true), r));
		await until(() => x.persist.entered() > 0);
		await sleep(60);
		expect(resolved).toBe(false);
		expect(x.t.disk().toString()).toBe(md("- [ ] A", "- [ ] B"));
		expect(x.t.render()![0]).toBe("● Todos · OpenSpec 0/2");
		expect(x.t.render()!.join("\n")).not.toMatch(/✓/);
		x.persist.release();
		expect((await pending).text).toContain("CLI confirmed this task as done");
	});

	it("persisted but the confirming read is held: the file is written, yet nothing is reported or shown", async () => {
		const x = await ready();
		x.arm();
		x.persist.release();
		let resolved = false;
		const calls = x.applyCalls();
		const pending = x.t.call(x.sync, { action: "update", id: 1, status: "completed", expectedRevision: x.rev }).then((r) => ((resolved = true), r));
		await until(() => x.confirm.entered() > 0);
		await sleep(80);
		expect(x.t.disk().toString()).toBe(md("- [x] A", "- [ ] B")); // persisted
		expect(resolved).toBe(false); // not reported
		expect(x.t.render()![0]).not.toBe("● Todos · OpenSpec 1/2"); // not shown as confirmed
		expect(x.t.render()!.join("\n")).not.toMatch(/✓ A/);
		expect(x.applyCalls()).toBeGreaterThan(calls);
		x.confirm.release();
		const result = await pending;
		expect(result.text).toContain("CLI confirmed this task as done");
		expect(x.t.render()![0]).toBe("● Todos · OpenSpec 1/2");
	});

	it("both stages released in the opposite order of their start still resolve exactly once, as completed", async () => {
		const x = await ready();
		x.arm();
		const pending = x.t.call(x.sync, { action: "update", id: 1, status: "completed", expectedRevision: x.rev });
		await until(() => x.persist.entered() > 0);
		x.confirm.release(); // released early: nothing to confirm yet
		x.persist.release();
		const result = await pending;
		expect(result.text).toContain("CLI confirmed this task as done");
		expect(x.t.disk().toString()).toBe(md("- [x] A", "- [ ] B"));
	});

	it("meanwhile an unrelated session keeps working", async () => {
		const x = await ready();
		const pending = x.t.call(x.sync, { action: "update", id: 1, status: "completed", expectedRevision: x.rev });
		await until(() => x.persist.entered() > 0);
		expect((await x.t.call(x.plain, { action: "create", subject: "Unrelated" })).text).toContain("Created #1");
		x.persist.release();
		await pending;
	});
});

describe("7.7 overlapping refreshes and contention", () => {
	it("refreshes released out of order: the newest committed view survives and nothing older repaints over it", async () => {
		const { t, sync } = await twoSessions(md("- [ ] A"));
		const older = gate();
		let calls = 0;
		t.cli!.hooks.apply = async () => {
			if (++calls === 1) await older.hold();
			return undefined;
		};
		writeFileSync(paths.tasksPath, md("- [ ] A")); // content seen by the older read
		const first = t.call(sync, { action: "list" }); // held
		await until(() => older.entered() > 0);
		writeFileSync(paths.tasksPath, md("- [x] A", "- [ ] New"));
		const second = await t.call(sync, { action: "list" }); // newer, finishes first
		expect(second.text).toContain("[completed] #1 A");
		const repaints = t.renders();
		older.release();
		await first;
		expect(t.render()![0]).toBe("● Todos · OpenSpec 1/2");
		expect(t.render()!.join("\n")).toContain("New");
		expect(t.renders()).toBeGreaterThanOrEqual(repaints);
	});

	it("a watcher event, a tool update and a delayed refresh overlap and settle on the latest file", async () => {
		const { t, sync } = await twoSessions(md("- [ ] A", "- [ ] B"));
		const hold = gate();
		let calls = 0;
		t.cli!.hooks.apply = async () => {
			if (++calls === 1) await hold.hold();
			return undefined;
		};
		writeFileSync(paths.tasksPath, md("- [x] A", "- [ ] B"));
		t.watches.find((w) => !w.closed)!.fire(); // watcher refresh starts and is held
		await until(() => hold.entered() > 0);
		const rev = revisionOf((await t.call(sync, { action: "list" })).text);
		writeFileSync(paths.tasksPath, md("- [x] A", "- [x] B"));
		t.watches.find((w) => !w.closed)!.fire(); // a second event while the first is held
		hold.release();
		await t.settle();
		await sleep(80);
		await t.settle();
		void rev;
		expect(t.render()![0]).toBe("○ Todos · OpenSpec 2/2");
	});

	it("a held write on one file does not hold up a write on an independent file", async () => {
		const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const other = mkdtempSync(join(tmpdir(), "pi-todo-other-"));
		try {
			const otherChange = join(other, "openspec", "changes", "a");
			mkdirSync(otherChange, { recursive: true });
			const otherTasks = join(otherChange, "tasks.md");
			writeFileSync(otherTasks, md("- [ ] X"));
			const { makeFakeCli } = await import("./fake-cli.js");
			const cliA = makeFakeCli({ root: paths.root, change: "a", tasksPath: paths.tasksPath, changeRoot: paths.changeRoot });
			const cliB = makeFakeCli({ root: other, change: "a", tasksPath: otherTasks, changeRoot: otherChange });
			const hold = gate();
			const t = await bootPanel({
				paths,
				content: md("- [ ] A"),
				runtime: {
					run: ((args: readonly string[], o: { cwd: string }) => (o.cwd === other ? cliB : cliA).run(args, o as any)) as any,
					fs: { rename: async (from: string, to: string) => { if (to === (await import("node:fs")).realpathSync(paths.tasksPath)) await hold.hold(); renameSync(from, to); } },
				},
			});
			const one = t.session("one");
			const two = t.session("two", [{ type: "custom", customType: "pi-todo-session", data: { mode: "openspec", binding: { root: other, change: "a" } } }]);
			await t.fire("session_start", one);
			await t.fire("session_start", two);
			await t.settle();
			const revA = revisionOf((await t.call(one, { action: "list" })).text);
			const revB = revisionOf((await t.call(two, { action: "list" })).text);
			const slow = t.call(one, { action: "update", id: 1, status: "completed", expectedRevision: revA });
			await until(() => hold.entered() > 0);
			const started = Date.now();
			const fast = await t.call(two, { action: "update", id: 1, status: "completed", expectedRevision: revB });
			expect(fast.text).toContain("CLI confirmed this task as done");
			expect(Date.now() - started).toBeLessThan(1500);
			expect((await import("node:fs")).readFileSync(otherTasks, "utf-8")).toBe(md("- [x] X"));
			expect(t.disk().toString()).toBe(md("- [ ] A")); // the held one has not landed
			hold.release();
			expect((await slow).text).toContain("CLI confirmed this task as done");
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("two writes to one file under contention both land, in order, with no lost update", async () => {
		const { t, sync } = await twoSessions(md("- [ ] A", "- [ ] B", "- [ ] C"), { lock: { waitMs: 3000, pollMs: 10 } });
		const rev = revisionOf((await t.call(sync, { action: "list" })).text);
		const first = t.call(sync, { action: "update", id: 1, status: "completed", expectedRevision: rev });
		const second = t.call(sync, { action: "update", id: 2, status: "completed", expectedRevision: rev });
		const [a, b] = await Promise.all([first, second]);
		const kinds = [a, b].map((r) => (r.details.error ? "error" : "ok")).sort();
		expect(kinds).toEqual(["error", "ok"]); // one wins; the other holds an old revision and must refresh
		const fresh = revisionOf((await t.call(sync, { action: "list" })).text);
		const loser = a.details.error ? 1 : 2;
		expect((await t.call(sync, { action: "update", id: loser, status: "completed", expectedRevision: fresh })).text).toContain("confirmed");
		expect(t.disk().toString().match(/\[x\]/g)).toHaveLength(2);
		expect(leftovers()).toEqual([]);
	});
});

describe("7.8 faults around persistence give accurate outcomes and clean up", () => {
	async function armed(over: Record<string, unknown> = {}) {
		const { t, sync, plain } = await twoSessions(md("- [ ] A", "- [ ] B"), over);
		const rev = revisionOf((await t.call(sync, { action: "list" })).text);
		return { t, sync, plain, rev };
	}
	const noLocksOrTemps = () => expect(leftovers()).toEqual([]);

	it("rejection before persistence: nothing written, task incomplete, error reported", async () => {
		const x = await armed({ fs: { writeStaged: async () => { throw new Error("staging rejected"); } } });
		const r = await x.t.call(x.sync, { action: "update", id: 1, status: "completed", expectedRevision: x.rev });
		expect(r.text).toMatch(/^Error: The task file could not be written: staging rejected/);
		expect(x.t.disk().toString()).toBe(md("- [ ] A", "- [ ] B"));
		expect(x.t.render()![0]).toBe("● Todos · OpenSpec 0/2");
		noLocksOrTemps();
	});

	it("timeout of the confirming CLI read after persistence: reported separately, no rollback, no second write", async () => {
		const x = await armed();
		let calls = 0;
		x.t.cli!.hooks.apply = () => (++calls === 3 ? { ok: false, kind: "timeout", message: "OpenSpec command timed out after 15000 ms" } : undefined); // tool refresh, writer refresh, confirming read
		const r = await x.t.call(x.sync, { action: "update", id: 1, status: "completed", expectedRevision: x.rev });
		expect(r.text).toMatch(/^Error: The checkbox for task #1 was written, but the OpenSpec view could not be refreshed/);
		expect(x.t.disk().toString()).toBe(md("- [x] A", "- [ ] B"));
		expect(x.t.renames).toHaveBeenCalledTimes(1);
		x.t.cli!.hooks.apply = undefined;
		const again = await x.t.call(x.sync, { action: "list" });
		expect(again.text).toContain("[completed] #1 A");
		noLocksOrTemps();
	});

	it("cancellation before persistence: the held CLI stage sees the abort, nothing is written, the lock is free", async () => {
		const x = await armed();
		const hold = gate();
		let sawAbort = false;
		x.t.cli!.hooks.apply = async () => {
			await hold.hold();
			return undefined;
		};
		const controller = new AbortController();
		const tool = x.t.host.tools.get("todo");
		const pending = tool.execute("c", { action: "update", id: 1, status: "completed", expectedRevision: x.rev }, controller.signal, undefined, x.sync);
		await until(() => hold.entered() > 0);
		controller.abort();
		hold.release();
		const r = await pending;
		void sawAbort;
		expect(r.content[0].text).toMatch(/^Error: Cancelled\./);
		expect(x.t.disk().toString()).toBe(md("- [ ] A", "- [ ] B"));
		expect(x.t.renames).not.toHaveBeenCalled();
		noLocksOrTemps();
	});

	it("the caller's abort signal reaches every CLI call a tool invocation makes, so a cancel stops them", async () => {
		const x = await armed();
		const controller = new AbortController();
		const tool = x.t.host.tools.get("todo");
		const before = x.t.cli!.calls.length;
		for (const params of [{ action: "list" }, { action: "get", id: 1 }, { action: "update", id: 1, status: "in_progress", expectedRevision: x.rev }]) {
			await tool.execute("c", params, controller.signal, undefined, x.sync);
		}
		const made = x.t.cli!.calls.slice(before);
		expect(made.length).toBeGreaterThanOrEqual(6);
		expect(made.every((c) => c.signal === controller.signal)).toBe(true);
	});

	it("rebinding during the write: before persistence nothing lands; after persistence it is reported, not replayed", async () => {
		const early = await armed();
		const hold = gate();
		early.t.cli!.hooks.apply = async () => {
			await hold.hold();
			return undefined;
		};
		const pending = early.t.call(early.sync, { action: "update", id: 1, status: "completed", expectedRevision: early.rev });
		await until(() => hold.entered() > 0);
		await early.t.fire("session_start", early.t.session("sync", [{ type: "custom", customType: "pi-todo-session", data: { mode: "normal" } }]));
		hold.release();
		expect((await pending).text).toMatch(/^Error: /);
		expect(early.t.disk().toString()).toBe(md("- [ ] A", "- [ ] B"));
		noLocksOrTemps();
	});

	it("shutdown during the write releases the lock and leaves no watcher or late repaint", async () => {
		const persist = gate();
		const x = await armed({ fs: { rename: async (a: string, b: string) => { await persist.hold(); renameSync(a, b); } } });
		const pending = x.t.call(x.sync, { action: "update", id: 1, status: "completed", expectedRevision: x.rev });
		await until(() => persist.entered() > 0);
		await x.t.fire("session_shutdown", x.sync);
		const repaintsAtShutdown = x.t.renders();
		persist.release();
		const r = await pending;
		expect(r.text).toMatch(/^Error: /); // the write landed after shutdown; it is reported, not confirmed
		expect(x.t.disk().toString()).toBe(md("- [x] A", "- [ ] B"));
		expect(x.t.watches.every((w) => w.closed)).toBe(true);
		expect(x.t.renders()).toBe(repaintsAtShutdown);
		expect(existsSync(lockPathFor((await import("node:fs")).realpathSync(paths.tasksPath)))).toBe(false);
		noLocksOrTemps();
	});

	it("a rejected CLI run (not an error result) is reported and leaves the session usable", async () => {
		const x = await armed();
		let n = 0;
		x.t.cli!.hooks.apply = () => {
			if (++n === 1) throw new Error("runner exploded");
			return undefined;
		};
		const bad = await x.t.call(x.sync, { action: "update", id: 1, status: "completed", expectedRevision: x.rev });
		expect(bad.text).toMatch(/^Error: /);
		expect(x.t.disk().toString()).toBe(md("- [ ] A", "- [ ] B"));
		const fresh = revisionOf((await x.t.call(x.sync, { action: "list" })).text);
		expect((await x.t.call(x.sync, { action: "update", id: 1, status: "completed", expectedRevision: fresh })).text).toContain("confirmed");
	});
});

describe("7.9 recovery after a rejected async operation", () => {
	it("a failed refresh, a failed write, and a failed repaint do not poison later work", async () => {
		const { t, sync } = await twoSessions(md("- [ ] A", "- [ ] B"));
		let fail = 2;
		t.cli!.hooks.apply = () => (fail-- > 0 ? { ok: false, kind: "timeout", message: "timed out" } : undefined);
		expect((await t.call(sync, { action: "list" })).text).toContain("⚠ The OpenSpec view is stale");
		expect((await t.call(sync, { action: "list" })).text).toContain("⚠ The OpenSpec view is stale");
		const ok = await t.call(sync, { action: "list" });
		expect(ok.text).not.toContain("⚠");
		const rev = revisionOf(ok.text);
		t.widget.tui.requestRender.mockImplementation(() => {
			throw new Error("render failed");
		});
		const done = await t.call(sync, { action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(done.text).toContain("could not be repainted");
		t.widget.tui.requestRender.mockImplementation(() => undefined);
		const next = revisionOf((await t.call(sync, { action: "list" })).text);
		expect((await t.call(sync, { action: "update", id: 2, status: "completed", expectedRevision: next })).text).toContain("confirmed");
		expect(t.disk().toString()).toBe(md("- [x] A", "- [x] B"));
	});

	it("a failing watcher refresh does not stop later watcher refreshes", async () => {
		const { t } = await twoSessions(md("- [ ] A"));
		let n = 0;
		t.cli!.hooks.apply = () => {
			if (++n === 1) throw new Error("first refresh fails");
			return undefined;
		};
		const watch = () => t.watches.find((w) => !w.closed)!;
		watch().fire();
		await t.settle();
		await sleep(60);
		writeFileSync(paths.tasksPath, md("- [x] A"));
		watch().fire();
		await t.settle();
		await sleep(60);
		expect(t.render()![0]).toBe("○ Todos · OpenSpec 1/1");
	});

	it("a lock failure leaves the in-process queue running for the next write", async () => {
		const { t, sync } = await twoSessions(md("- [ ] A", "- [ ] B"), { lock: { waitMs: 60, pollMs: 10 } });
		const rev = revisionOf((await t.call(sync, { action: "list" })).text);
		const real = (await import("node:fs")).realpathSync(paths.tasksPath);
		writeFileSync(lockPathFor(real), JSON.stringify({ pid: 1, host: "elsewhere", createdAt: new Date().toISOString(), target: real, token: "a".repeat(32) }));
		const blocked = await t.call(sync, { action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(blocked.text).toContain("locked by process 1 on elsewhere");
		(await import("node:fs")).rmSync(lockPathFor(real));
		const fresh = revisionOf((await t.call(sync, { action: "list" })).text);
		expect((await t.call(sync, { action: "update", id: 1, status: "completed", expectedRevision: fresh })).text).toContain("confirmed");
	});
});
