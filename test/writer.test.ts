import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockPathFor } from "../src/openspec/lock.js";
import type { ExecResult } from "../src/openspec/exec.js";
import { createSnapshotProvider } from "../src/openspec/snapshot.js";
import { createWriter, defaultFs, type WriterFs } from "../src/openspec/writer.js";
import type { SessionMode } from "../src/session-mode.js";
import { makeFakeCli } from "./fake-cli.js";

let root = "";
let changeRoot = "";
let tasksPath = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-todo-writer-"));
	changeRoot = join(root, "openspec", "changes", "a");
	mkdirSync(changeRoot, { recursive: true });
	tasksPath = join(changeRoot, "tasks.md");
});
afterEach(() => {
	try {
		chmodSync(changeRoot, 0o700);
	} catch {}
	rmSync(root, { recursive: true, force: true });
});

const md = (...lines: string[]) => `${lines.join("\n")}\n`;
const fail = (kind: any, message: string): ExecResult => ({ ok: false, kind, message });
const bound = (): SessionMode => ({ mode: "openspec", binding: { root, change: "a" } });
const disk = () => readFileSync(tasksPath);
const leftovers = () => readdirSync(changeRoot).filter((f) => f !== "tasks.md");

function setup(
	content: string | Buffer,
	mode: (id: string) => SessionMode = bound,
	fs: Partial<WriterFs> = {},
	lock = { waitMs: 150, pollMs: 10 },
) {
	writeFileSync(tasksPath, content);
	const cli = makeFakeCli({ root, change: "a", tasksPath, changeRoot });
	const provider = createSnapshotProvider(
		{ run: cli.run as any },
		{ getMode: (id) => mode(id), getOrdinary: () => [] },
	);
	const writer = createWriter({ provider, fs, lock });
	/** Read the view, as the agent does, and return it with its revision. */
	const read = async (session = "s1") => provider.refresh(session);
	return { cli, provider, writer, read };
}

describe("completing a task", () => {
	it("checks only the target box and leaves every other byte alone", async () => {
		const original = Buffer.from("# Tasks\r\n- [x] 1.1 Done\r\n- [ ] 1.2 Open\r\n- [ ] 1.3 Later\r\n", "utf-8");
		const { writer, read } = setup(original);
		const view = await read();
		const outcome = await writer.complete("s1", 2, view.revision!);
		expect(outcome).toMatchObject({ kind: "completed", changed: true });
		expect(disk().toString()).toBe("# Tasks\r\n- [x] 1.1 Done\r\n- [x] 1.2 Open\r\n- [ ] 1.3 Later\r\n");
		let differing = 0;
		for (let i = 0; i < original.length; i++) if (original[i] !== disk()[i]) differing++;
		expect(differing).toBe(1);
		expect(leftovers()).toEqual([]);
	});

	it("reports refreshed CLI state: the same task done, totals up by one, and a new revision", async () => {
		const { writer, read } = setup(md("- [ ] A", "- [ ] B"));
		const view = await read();
		const outcome = await writer.complete("s1", 1, view.revision!);
		if (outcome.kind !== "completed") throw new Error(outcome.kind);
		expect(outcome.snapshot.linked.map((r) => [r.id, r.done])).toEqual([
			[1, true],
			[2, false],
		]);
		expect(outcome.snapshot.implementation).toMatchObject({ complete: 1, remaining: 1 });
		expect(outcome.revision).not.toBe(view.revision);
		expect(outcome.snapshot.writable).toBe(true);
	});

	it("preserves file permissions", async () => {
		const { writer, read } = setup(md("- [ ] A"));
		chmodSync(tasksPath, 0o640);
		const view = await read();
		await writer.complete("s1", 1, view.revision!);
		expect(statSync(tasksPath).mode & 0o777).toBe(0o640);
	});

	it("follows the wording when rows were reordered, using a fresh revision", async () => {
		const { writer, read } = setup(md("- [ ] A", "- [ ] B", "- [ ] C"));
		await read();
		writeFileSync(tasksPath, md("- [ ] C", "- [ ] A", "- [ ] B"));
		const view = await read();
		await writer.complete("s1", 2, view.revision!); // local id 2 is "B"
		expect(disk().toString()).toBe(md("- [ ] C", "- [ ] A", "- [x] B"));
	});
});

describe("already completed tasks", () => {
	it("succeeds without writing", async () => {
		let writes = 0;
		const { writer, read } = setup(md("- [x] A", "- [ ] B"), bound, { rename: async () => void writes++ });
		const view = await read();
		const before = statSync(tasksPath).mtimeMs;
		utimesSync(tasksPath, new Date(1000), new Date(1000));
		const outcome = await writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "completed", changed: false });
		expect(writes).toBe(0);
		expect(statSync(tasksPath).mtimeMs).toBe(1000);
		void before;
	});
});

describe("refusals that change nothing", () => {
	async function untouched(content: string, act: (t: ReturnType<typeof setup>) => Promise<unknown>) {
		const t = setup(content);
		const before = Buffer.from(content);
		await act(t);
		expect(disk().equals(before)).toBe(true);
		expect(leftovers()).toEqual([]);
	}

	it("rejects a revision the agent read before the file changed", async () => {
		const t = setup(md("- [ ] A", "- [ ] B"));
		const old = (await t.read()).revision!;
		writeFileSync(tasksPath, md("- [ ] New first", "- [ ] A", "- [ ] B"));
		const edited = disk();
		const outcome = await t.writer.complete("s1", 2, old);
		expect(outcome).toMatchObject({ kind: "rejected", code: "stale-revision" });
		expect(outcome.kind === "rejected" && outcome.action).toMatch(/list the tasks again/i);
		expect(disk().equals(edited)).toBe(true);
	});

	it("never checks a box by the CLI's old row number after a reorder", async () => {
		const t = setup(md("- [ ] A", "- [ ] B", "- [ ] C"));
		const old = (await t.read()).revision!;
		writeFileSync(tasksPath, md("- [ ] C", "- [ ] B", "- [ ] A"));
		const reordered = disk();
		expect(await t.writer.complete("s1", 1, old)).toMatchObject({ kind: "rejected", code: "stale-revision" });
		expect(disk().equals(reordered)).toBe(true);
	});

	it("rejects a missing revision", async () => {
		await untouched(md("- [ ] A"), async (t) => {
			await t.read();
			expect(await t.writer.complete("s1", 1, undefined as any)).toMatchObject({
				kind: "rejected",
				code: "stale-revision",
			});
			expect(await t.writer.complete("s1", 1, "")).toMatchObject({ kind: "rejected", code: "stale-revision" });
		});
	});

	it("rejects an id that does not exist or was removed", async () => {
		await untouched(md("- [ ] A", "- [ ] B"), async (t) => {
			let view = await t.read();
			expect(await t.writer.complete("s1", 9, view.revision!)).toMatchObject({
				kind: "rejected",
				code: "unknown-task",
			});
			writeFileSync(tasksPath, md("- [ ] A"));
			view = await t.read();
			expect(await t.writer.complete("s1", 2, view.revision!)).toMatchObject({
				kind: "rejected",
				code: "unknown-task",
			});
			writeFileSync(tasksPath, md("- [ ] A", "- [ ] B"));
		});
	});

	it("rejects ambiguous wording with the reason", async () => {
		await untouched(md("- [ ] Same", "- [ ] Same"), async (t) => {
			const view = await t.read();
			const outcome = await t.writer.complete("s1", 1, view.revision!);
			expect(outcome).toMatchObject({ kind: "rejected", code: "unmappable" });
			expect(outcome.kind === "rejected" && outcome.message).toMatch(/duplicate task wording/);
		});
	});

	it("rejects sessions that are not bound", async () => {
		for (const mode of [{ mode: "normal" } as SessionMode, { mode: "openspec" } as SessionMode]) {
			const t = setup(md("- [ ] A"), () => mode);
			expect(await t.writer.complete("s1", 1, "x")).toMatchObject({ kind: "rejected", code: "unbound" });
			expect(t.cli.calls).toEqual([]);
		}
	});

	it("rejects when the view is unavailable or stale", async () => {
		await untouched(md("- [ ] A"), async (t) => {
			t.cli.hooks.apply = () => fail("timeout", "timed out");
			expect(await t.writer.complete("s1", 1, "x")).toMatchObject({ kind: "rejected", code: "not-writable" });
		});
	});

	it("rejects a non-UTF-8 file", async () => {
		const bytes = Buffer.concat([Buffer.from("- [ ] A\n"), Buffer.from([0xff, 0xfe, 0x0a])]);
		const t = setup(bytes);
		const view = await t.read();
		expect(await t.writer.complete("s1", 1, view.revision!)).toMatchObject({ kind: "rejected", code: "not-editable" });
		expect(disk().equals(bytes)).toBe(true);
	});
});

describe("unsafe paths", () => {
	it("refuses a task file that resolves outside the change directory", async () => {
		const outside = join(root, "outside.md");
		writeFileSync(outside, md("- [ ] A"));
		const t = setup(md("- [ ] A"));
		rmSync(tasksPath);
		symlinkSync(outside, tasksPath);
		const view = await t.read();
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(view.freshness).toBe("unavailable"); // the read already refused the link
		expect(outcome).toMatchObject({ kind: "rejected", code: "not-writable" });
		expect(readFileSync(outside, "utf-8")).toBe(md("- [ ] A"));
	});

	it("refuses when the change directory itself resolves outside the planning root", async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "pi-todo-elsewhere-"));
		try {
			writeFileSync(join(elsewhere, "tasks.md"), md("- [ ] A"));
			rmSync(changeRoot, { recursive: true });
			symlinkSync(elsewhere, changeRoot);
			const t = setup(md("- [ ] A"));
			const view = await t.read();
			expect(view.freshness).toBe("unavailable");
			expect(await t.writer.complete("s1", 1, view.revision!)).toMatchObject({
				kind: "rejected",
				code: "not-writable",
			});
			expect(readFileSync(join(elsewhere, "tasks.md"), "utf-8")).toBe(md("- [ ] A"));
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("the writer checks again itself: a link swapped in after the read is refused and nothing is written", async () => {
		const outside = mkdtempSync(join(tmpdir(), "pi-todo-swap-"));
		try {
			const t = setup(md("- [ ] A"), bound, {
				realpath: async (p: string) =>
					p === tasksPath ? join(outside, "tasks.md") : (await import("node:fs/promises")).realpath(p),
			});
			const view = await t.read(); // the read sees a normal file
			expect(view.freshness).toBe("fresh");
			expect(await t.writer.complete("s1", 1, view.revision!)).toMatchObject({ kind: "rejected", code: "unsafe-path" });
			expect(disk().toString()).toBe(md("- [ ] A"));
			expect(readdirSync(outside)).toEqual([]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("writes through a link that stays inside the change directory and keeps the link", async () => {
		const real = join(changeRoot, "real-tasks.md");
		const t = setup(md("- [ ] A"));
		writeFileSync(real, md("- [ ] A"));
		rmSync(tasksPath);
		symlinkSync(real, tasksPath);
		const view = await t.read();
		expect(await t.writer.complete("s1", 1, view.revision!)).toMatchObject({ kind: "completed" });
		expect(readFileSync(real, "utf-8")).toBe(md("- [x] A"));
		expect(require("node:fs").lstatSync(tasksPath).isSymbolicLink()).toBe(true);
	});
});

describe("permissions", () => {
	it("refuses a read-only file", async () => {
		const t = setup(md("- [ ] A"));
		chmodSync(tasksPath, 0o444);
		const view = await t.read();
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "rejected", code: "permission" });
		expect(disk().toString()).toBe(md("- [ ] A"));
	});

	it.skipIf(process.getuid?.() === 0)(
		"reports a directory that cannot take a new file, leaving the original and no temporary file",
		async () => {
			const t = setup(md("- [ ] A"));
			const view = await t.read();
			chmodSync(changeRoot, 0o500);
			const outcome = await t.writer.complete("s1", 1, view.revision!);
			chmodSync(changeRoot, 0o700);
			expect(outcome).toMatchObject({ kind: "rejected", code: "permission" });
			expect(disk().toString()).toBe(md("- [ ] A"));
			expect(leftovers()).toEqual([]);
			expect(t.provider.getSnapshot("s1").linked[0].done).toBe(false);
		},
	);

	it("labels a permission error from the replace step as a permission problem", async () => {
		const t = setup(md("- [ ] A"), bound, {
			rename: async () => {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			},
		});
		const view = await t.read();
		expect(await t.writer.complete("s1", 1, view.revision!)).toMatchObject({ kind: "rejected", code: "permission" });
		expect(leftovers()).toEqual([]);
	});

	it("reports a failed replace as a write failure and cleans up its temporary file", async () => {
		const t = setup(md("- [ ] A"), bound, {
			rename: async () => {
				throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			},
		});
		const view = await t.read();
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "rejected", code: "write-failed" });
		expect(outcome.kind === "rejected" && outcome.message).toContain("disk full");
		expect(disk().toString()).toBe(md("- [ ] A"));
		expect(leftovers()).toEqual([]);
	});
});

describe("conflicting edits", () => {
	it("refuses when the file changes before the lock is taken", async () => {
		let staged = 0;
		const fsHooks: Partial<WriterFs> = { writeStaged: async () => void staged++ };
		const t = setup(md("- [ ] A", "- [ ] B"), bound, fsHooks);
		const view = await t.read();
		let edited = Buffer.alloc(0);
		fsHooks.access = async () => {
			// Runs after the writer's own refresh and before it takes the lock.
			writeFileSync(tasksPath, md("- [ ] A", "- [ ] B", "- [ ] Added by someone else"));
			edited = disk();
		};
		const outcome = await t.writer.complete("s1", 2, view.revision!);
		expect(outcome).toMatchObject({ kind: "rejected", code: "conflict" });
		expect(staged).toBe(0); // the in-lock check stops the write before anything is staged
		expect(disk().equals(edited)).toBe(true);
		expect(leftovers()).toEqual([]);
	});

	it("refuses when the file changes after the new bytes are staged but before the replace", async () => {
		let edited = Buffer.alloc(0);
		let renamed = 0;
		const fsHooks: Partial<WriterFs> = {
			rename: async (from, to) => {
				renamed++;
				renameSync(from, to);
			},
		};
		const t = setup(md("- [ ] A", "- [ ] B"), bound, fsHooks);
		const view = await t.read();
		const realStage = (await import("../src/openspec/writer.js")).defaultFs.writeStaged;
		fsHooks.writeStaged = async (path, bytes, mode) => {
			await realStage(path, bytes, mode);
			writeFileSync(tasksPath, md("- [ ] A", "- [ ] B", "- [ ] Late edit"));
			edited = disk();
		};
		const outcome = await t.writer.complete("s1", 2, view.revision!);
		expect(outcome).toMatchObject({ kind: "rejected", code: "conflict" });
		expect(renamed).toBe(0);
		expect(disk().equals(edited)).toBe(true);
		expect(leftovers()).toEqual([]);
	});
});

describe("locks", () => {
	it("reports a lock held elsewhere without touching the file", async () => {
		const t = setup(md("- [ ] A"));
		const view = await t.read();
		const meta = {
			pid: process.pid,
			host: require("node:os").hostname(),
			createdAt: new Date().toISOString(),
			target: tasksPath,
			token: "d".repeat(32),
		};
		writeFileSync(lockPathFor(require("node:fs").realpathSync(tasksPath)), JSON.stringify(meta));
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "rejected", code: "lock-contended" });
		expect(outcome.kind === "rejected" && outcome.message).toContain(`process ${process.pid}`);
		expect(disk().toString()).toBe(md("- [ ] A"));
	});

	it("releases its lock after success and after failure", async () => {
		const ok = setup(md("- [ ] A"));
		await ok.writer.complete("s1", 1, (await ok.read()).revision!);
		expect(existsSync(lockPathFor(tasksPath))).toBe(false);
		const bad = setup(md("- [ ] A"), bound, {
			rename: async () => {
				throw new Error("nope");
			},
		});
		await bad.writer.complete("s1", 1, (await bad.read()).revision!);
		expect(existsSync(lockPathFor(tasksPath))).toBe(false);
	});
});

describe("two sessions on one file", () => {
	it("keeps both completions and gives the stale contender a conflict to refresh", async () => {
		writeFileSync(tasksPath, md("- [ ] A", "- [ ] B", "- [ ] C"));
		const cli = makeFakeCli({ root, change: "a", tasksPath, changeRoot });
		const mk = () => createSnapshotProvider({ run: cli.run as any }, { getMode: () => bound(), getOrdinary: () => [] });
		const p1 = mk();
		const p2 = mk();
		const w1 = createWriter({ provider: p1, lock: { waitMs: 500, pollMs: 10 } });
		const w2 = createWriter({ provider: p2, lock: { waitMs: 500, pollMs: 10 } });
		const r1 = (await p1.refresh("one")).revision!;
		const r2 = (await p2.refresh("two")).revision!;
		const [a, b] = await Promise.all([w1.complete("one", 1, r1), w2.complete("two", 2, r2)]);
		const outcomes = [a.kind, b.kind].sort();
		expect(outcomes).toEqual(["completed", "rejected"]);
		const loser = a.kind === "rejected" ? a : b;
		expect(["stale-revision", "conflict"]).toContain(loser.kind === "rejected" && loser.code);
		const afterFirst = disk().toString();
		expect(afterFirst.match(/\[x\]/g)).toHaveLength(1);

		// The contender refreshes and retries; both completions survive.
		const loserProvider = a.kind === "rejected" ? p1 : p2;
		const loserWriter = a.kind === "rejected" ? w1 : w2;
		const loserSession = a.kind === "rejected" ? "one" : "two";
		const loserId = a.kind === "rejected" ? 1 : 2;
		const fresh = (await loserProvider.refresh(loserSession)).revision!;
		expect(await loserWriter.complete(loserSession, loserId, fresh)).toMatchObject({
			kind: "completed",
			changed: true,
		});
		expect(disk().toString().match(/\[x\]/g)).toHaveLength(2);
		expect(leftovers()).toEqual([]);
	});

	it("serialises simultaneous completions of different rows without losing either", async () => {
		writeFileSync(tasksPath, md("- [ ] A", "- [ ] B"));
		const cli = makeFakeCli({ root, change: "a", tasksPath, changeRoot });
		const mk = () => createSnapshotProvider({ run: cli.run as any }, { getMode: () => bound(), getOrdinary: () => [] });
		const [p1, p2] = [mk(), mk()];
		const w1 = createWriter({ provider: p1, lock: { waitMs: 1000, pollMs: 10 } });
		const w2 = createWriter({ provider: p2, lock: { waitMs: 1000, pollMs: 10 } });
		const r1 = (await p1.refresh("one")).revision!;
		await p2.refresh("two");
		const first = await w1.complete("one", 1, r1);
		const r2 = (await p2.refresh("two")).revision!;
		const second = await w2.complete("two", 2, r2);
		expect([first.kind, second.kind]).toEqual(["completed", "completed"]);
		expect(disk().toString()).toBe(md("- [x] A", "- [x] B"));
	});
});

describe("success needs persistence and CLI confirmation", () => {
	it("does not report completion when the writer persists nothing", async () => {
		const t = setup(md("- [ ] A", "- [ ] B"), bound, { rename: async () => undefined }); // pretends to replace the file
		const view = await t.read();
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "unconfirmed" });
		expect(disk().toString()).toBe(md("- [ ] A", "- [ ] B"));
		const snap = t.provider.getSnapshot("s1");
		expect(snap.linked[0].done).toBe(false);
		expect(snap.implementation?.complete).toBe(0);
		expect(snap.writable).toBe(false);
	});

	it("reports unconfirmed when the refreshed view shows a different task checked", async () => {
		const t = setup(md("- [ ] A", "- [ ] B"));
		const view = await t.read();
		let applyCalls = 0;
		t.cli.hooks.apply = async () => {
			applyCalls++;
			if (applyCalls < 2) return undefined; // the writer's own pre-write refresh
			const tasks = [
				{ id: "1", description: "A", done: false },
				{ id: "2", description: "B", done: true },
			];
			return {
				ok: true,
				stderr: "",
				json: {
					changeName: "a",
					schemaName: "spec-driven",
					state: "ready",
					progress: { total: 2, complete: 1, remaining: 1 },
					tasks,
					root: { path: root, source: "nearest" },
				},
			};
		};
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "unconfirmed" });
		expect(t.provider.getSnapshot("s1").writable).toBe(false);
	});

	it("does not accept a higher total as proof", async () => {
		const t = setup(md("- [ ] A"));
		const view = await t.read();
		let applyCalls = 0;
		t.cli.hooks.apply = async () => {
			applyCalls++;
			if (applyCalls < 2) return undefined;
			const tasks = [
				{ id: "1", description: "A", done: false },
				{ id: "2", description: "Extra", done: true },
			];
			return {
				ok: true,
				stderr: "",
				json: {
					changeName: "a",
					schemaName: "spec-driven",
					state: "ready",
					progress: { total: 2, complete: 1, remaining: 1 },
					tasks,
					root: { path: root, source: "nearest" },
				},
			};
		};
		expect(await t.writer.complete("s1", 1, view.revision!)).toMatchObject({ kind: "unconfirmed" });
	});

	it("keeps the promise pending until the confirming CLI read finishes", async () => {
		const t = setup(md("- [ ] A"));
		const view = await t.read();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let applyCalls = 0;
		t.cli.hooks.apply = async () => {
			applyCalls++;
			if (applyCalls === 2) await gate; // the confirming read
			return undefined;
		};
		let settled = false;
		const pending = t.writer.complete("s1", 1, view.revision!).then((o) => ((settled = true), o));
		await new Promise((r) => setTimeout(r, 120));
		expect(disk().toString()).toBe(md("- [x] A")); // persisted already
		expect(settled).toBe(false); // but not reported
		expect(t.provider.getSnapshot("s1").linked[0].done).toBe(false); // nor shown
		release();
		expect(await pending).toMatchObject({ kind: "completed" });
		expect(t.provider.getSnapshot("s1").linked[0].done).toBe(true);
	});
});

describe("persisted but the view cannot be refreshed", () => {
	it("reports the write and the unavailable view separately, without rollback", async () => {
		const t = setup(md("- [ ] A", "- [ ] B"));
		const view = await t.read();
		let applyCalls = 0;
		t.cli.hooks.apply = async () => {
			applyCalls++;
			return applyCalls >= 2 ? fail("timeout", "OpenSpec command timed out after 15000 ms") : undefined;
		};
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "persisted-view-unavailable" });
		expect(outcome.kind === "persisted-view-unavailable" && outcome.message).toMatch(/was written/i);
		expect(disk().toString()).toBe(md("- [x] A", "- [ ] B"));
		expect(t.provider.getSnapshot("s1")).toMatchObject({ freshness: "stale", writable: false });
	});

	it("blocks further writes, does not write twice, and recovers on the next refresh", async () => {
		let renames = 0;
		const t = setup(md("- [ ] A", "- [ ] B"), bound, {
			rename: async (a, b) => {
				renames++;
				renameSync(a, b);
			},
		});
		const view = await t.read();
		let broken = false;
		t.cli.hooks.apply = async () => {
			if (!broken && t.cli.calls.filter((c) => c.args[0] === "instructions").length >= 3) broken = true; // read, pre-write refresh, then the confirming read
			return broken ? fail("timeout", "timed out") : undefined;
		};
		await t.writer.complete("s1", 1, view.revision!);
		expect(renames).toBe(1);
		expect(await t.writer.complete("s1", 2, "anything")).toMatchObject({ kind: "rejected", code: "not-writable" });
		expect(renames).toBe(1);
		broken = false;
		t.cli.hooks.apply = undefined;
		const recovered = await t.read();
		expect(recovered).toMatchObject({ freshness: "fresh", writable: true });
		expect(recovered.linked.map((r) => r.done)).toEqual([true, false]);
		expect(await t.writer.complete("s1", 1, recovered.revision!)).toMatchObject({ kind: "completed", changed: false });
		expect(renames).toBe(1);
	});

	it("blocks writes after an unconfirmed completion until a later refresh succeeds", async () => {
		const t = setup(md("- [ ] A", "- [ ] B"), bound, { rename: async () => undefined });
		const view = await t.read();
		expect(await t.writer.complete("s1", 1, view.revision!)).toMatchObject({ kind: "unconfirmed" });
		expect(t.provider.getSnapshot("s1").writable).toBe(false);
		expect(t.provider.getSnapshot("s1").diagnostics.join(" ")).toMatch(/did not confirm/);
		expect((await t.read()).writable).toBe(true);
	});

	it("reconciles before any retry, so a completion that did land is not written twice", async () => {
		let renames = 0;
		const t = setup(md("- [ ] A", "- [ ] B"), bound, {
			rename: async (a, b) => {
				renames++;
				renameSync(a, b);
			},
		});
		const view = await t.read();
		let applyCalls = 0;
		t.cli.hooks.apply = async () => (++applyCalls === 2 ? fail("timeout", "timed out") : undefined); // the hook starts after the first read: pre-write refresh is 1, the confirming read is 2
		expect(await t.writer.complete("s1", 1, view.revision!)).toMatchObject({ kind: "persisted-view-unavailable" });
		const retry = await t.writer.complete("s1", 1, "stale-but-irrelevant");
		expect(retry).toMatchObject({ kind: "rejected", code: "stale-revision" }); // the retry reads the new truth first
		const fresh = (await t.read()).revision!;
		expect(await t.writer.complete("s1", 1, fresh)).toMatchObject({ kind: "completed", changed: false });
		expect(renames).toBe(1);
	});
});

describe("repaint after a persisted write", () => {
	function withHook(
		onCommitted: (snapshot: any) => unknown,
		content = md("- [ ] A", "- [ ] B"),
		fs: Partial<WriterFs> = {},
	) {
		writeFileSync(tasksPath, content);
		const cli = makeFakeCli({ root, change: "a", tasksPath, changeRoot });
		const provider = createSnapshotProvider({ run: cli.run as any }, { getMode: () => bound(), getOrdinary: () => [] });
		const writer = createWriter({ provider, fs, lock: { waitMs: 150, pollMs: 10 }, onCommitted: onCommitted as any });
		return { cli, provider, writer };
	}

	it("calls the hook with the confirmed snapshot after a completed write", async () => {
		const seen: any[] = [];
		const t = withHook((snap) => void seen.push(snap));
		const view = await t.provider.refresh("s1");
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "completed" });
		expect(seen).toHaveLength(1);
		expect(seen[0].linked[0].done).toBe(true);
		expect(outcome.kind === "completed" && outcome.warnings).toBeUndefined();
	});

	it("keeps the completion when the hook throws, and reports the repaint problem", async () => {
		let renames = 0;
		const t = withHook(
			() => {
				throw new Error("widget gone");
			},
			md("- [ ] A"),
			{
				rename: async (a, b) => {
					renames++;
					renameSync(a, b);
				},
			},
		);
		const view = await t.provider.refresh("s1");
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "completed", changed: true });
		expect(outcome.kind === "completed" && outcome.warnings?.join(" ")).toMatch(
			/could not be repainted: widget gone.*\/todos refresh/,
		);
		expect(disk().toString()).toBe(md("- [x] A"));
		expect(renames).toBe(1);
		expect(t.provider.getSnapshot("s1").linked[0].done).toBe(true);
	});

	it("keeps the completion when the hook rejects", async () => {
		const t = withHook(async () => {
			throw new Error("async failure");
		});
		const view = await t.provider.refresh("s1");
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "completed" });
		expect(outcome.kind === "completed" && outcome.warnings?.join(" ")).toContain("async failure");
	});

	it("waits for the hook before resolving", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const t = withHook(() => gate);
		const view = await t.provider.refresh("s1");
		let settled = false;
		const pending = t.writer.complete("s1", 1, view.revision!).then((o) => ((settled = true), o));
		await new Promise((r) => setTimeout(r, 80));
		expect(settled).toBe(false);
		release();
		expect(await pending).toMatchObject({ kind: "completed" });
	});

	it("also repaints when the write persisted but the view is unavailable or unconfirmed", async () => {
		const seen: string[] = [];
		const t = withHook((snap) => void seen.push(snap.freshness));
		const view = await t.provider.refresh("s1");
		let n = 0;
		t.cli.hooks.apply = async () => (++n === 2 ? fail("timeout", "timed out") : undefined);
		expect(await t.writer.complete("s1", 1, view.revision!)).toMatchObject({ kind: "persisted-view-unavailable" });
		expect(seen).toEqual(["stale"]);

		const u = withHook((snap) => void seen.push(`unconfirmed:${snap.writable}`), md("- [ ] A"), {
			rename: async () => undefined,
		});
		const v = await u.provider.refresh("s1");
		expect(await u.writer.complete("s1", 1, v.revision!)).toMatchObject({ kind: "unconfirmed" });
		expect(seen).toEqual(["stale", "unconfirmed:false"]);
	});

	it("reports a repaint problem on an unavailable view without changing the outcome", async () => {
		const t = withHook(() => {
			throw new Error("no widget");
		});
		const view = await t.provider.refresh("s1");
		let n = 0;
		t.cli.hooks.apply = async () => (++n === 2 ? fail("timeout", "timed out") : undefined);
		const outcome = await t.writer.complete("s1", 1, view.revision!);
		expect(outcome).toMatchObject({ kind: "persisted-view-unavailable" });
		expect(outcome.kind === "persisted-view-unavailable" && outcome.warnings?.join(" ")).toContain("no widget");
	});

	it("does not call the hook when nothing was written", async () => {
		let calls = 0;
		const t = withHook(() => void calls++, md("- [x] A", "- [ ] B"));
		const view = await t.provider.refresh("s1");
		await t.writer.complete("s1", 1, view.revision!); // already done
		await t.writer.complete("s1", 2, "stale"); // rejected
		await t.writer.complete("s1", 9, view.revision!); // unknown
		expect(calls).toBe(0);
	});
});

describe("obsolete bindings", () => {
	it("writes nothing when the binding moved during the pre-write refresh", async () => {
		let current = true;
		const t = setup(md("- [ ] A"));
		const view = await t.read();
		t.cli.hooks.apply = async () => {
			current = false; // the session rebinds while the writer's own refresh is running
			return undefined;
		};
		const outcome = await t.writer.complete("s1", 1, view.revision!, { isCurrent: () => current });
		expect(outcome).toMatchObject({ kind: "cancelled" });
		expect(outcome.kind === "cancelled" && outcome.message).toMatch(/binding changed/i);
		expect(disk().toString()).toBe(md("- [ ] A"));
	});

	it("checks again immediately before the replace and leaves no temporary file", async () => {
		let current = true;
		let renames = 0;
		const realStage = defaultFs.writeStaged;
		const t = setup(md("- [ ] A"), bound, {
			writeStaged: async (path, bytes, mode) => {
				await realStage(path, bytes, mode);
				current = false; // the binding moves after staging, before the replace
			},
			rename: async () => void renames++,
		});
		const view = await t.read();
		expect(await t.writer.complete("s1", 1, view.revision!, { isCurrent: () => current })).toMatchObject({
			kind: "cancelled",
		});
		expect(renames).toBe(0);
		expect(disk().toString()).toBe(md("- [ ] A"));
		expect(leftovers()).toEqual([]);
	});

	it("reports a write that landed before the binding moved against the original binding, and publishes nothing", async () => {
		let current = true;
		const repainted: unknown[] = [];
		writeFileSync(tasksPath, md("- [ ] A"));
		const cli = makeFakeCli({ root, change: "a", tasksPath, changeRoot });
		const provider = createSnapshotProvider({ run: cli.run as any }, { getMode: () => bound(), getOrdinary: () => [] });
		const writer = createWriter({
			provider,
			lock: { waitMs: 150, pollMs: 10 },
			onCommitted: (snap) => void repainted.push(snap),
			fs: {
				rename: async (a, b) => {
					renameSync(a, b);
					current = false;
				},
			}, // lands, then the binding moves
		});
		const view = await provider.refresh("s1");
		const outcome = await writer.complete("s1", 1, view.revision!, { isCurrent: () => current });
		expect(outcome).toMatchObject({ kind: "persisted-view-unavailable" });
		expect(outcome.kind === "persisted-view-unavailable" && outcome.message).toMatch(/binding changed/i);
		expect(disk().toString()).toBe(md("- [x] A"));
		expect(repainted).toEqual([]);
		expect(provider.getSnapshot("s1").writable).toBe(true); // the new binding is not blocked by the old write
	});
});

describe("cancellation", () => {
	it("cancels before persistence without writing", async () => {
		const t = setup(md("- [ ] A"));
		const view = await t.read();
		const meta = {
			pid: process.pid,
			host: require("node:os").hostname(),
			createdAt: new Date().toISOString(),
			target: tasksPath,
			token: "e".repeat(32),
		};
		writeFileSync(lockPathFor(require("node:fs").realpathSync(tasksPath)), JSON.stringify(meta));
		const controller = new AbortController();
		const pending = t.writer.complete("s1", 1, view.revision!, { signal: controller.signal });
		const slow = createWriter({ provider: t.provider, lock: { waitMs: 60_000, pollMs: 10_000 } });
		const pending2 = slow.complete("s1", 1, view.revision!, { signal: controller.signal });
		await new Promise((r) => setTimeout(r, 30));
		controller.abort();
		expect(await pending2).toMatchObject({ kind: "cancelled" });
		await pending;
		expect(disk().toString()).toBe(md("- [ ] A"));
	});

	it("cancels between staging and replacing, without writing and without a temporary file", async () => {
		const controller = new AbortController();
		const realStage = defaultFs.writeStaged;
		let renames = 0;
		const t = setup(md("- [ ] A"), bound, {
			writeStaged: async (path, bytes, mode) => {
				await realStage(path, bytes, mode);
				controller.abort(); // lands after the bytes are staged, before the replace
			},
			rename: async () => void renames++,
		});
		const view = await t.read();
		expect(await t.writer.complete("s1", 1, view.revision!, { signal: controller.signal })).toMatchObject({
			kind: "cancelled",
		});
		expect(renames).toBe(0);
		expect(disk().toString()).toBe(md("- [ ] A"));
		expect(leftovers()).toEqual([]);
	});

	it("does not start when already aborted", async () => {
		const t = setup(md("- [ ] A"));
		const view = await t.read();
		const controller = new AbortController();
		controller.abort();
		expect(await t.writer.complete("s1", 1, view.revision!, { signal: controller.signal })).toMatchObject({
			kind: "cancelled",
		});
		expect(disk().toString()).toBe(md("- [ ] A"));
	});

	it("reports a write that was persisted before the abort, without rollback or a second write", async () => {
		const controller = new AbortController();
		let renames = 0;
		const t = setup(md("- [ ] A"), bound, {
			rename: async (a, b) => {
				renames++;
				renameSync(a, b);
				controller.abort(); // abort lands just after persistence
			},
		});
		const view = await t.read();
		const outcome = await t.writer.complete("s1", 1, view.revision!, { signal: controller.signal });
		expect(outcome).toMatchObject({ kind: "persisted-view-unavailable" });
		expect(disk().toString()).toBe(md("- [x] A"));
		expect(renames).toBe(1);
	});
});
