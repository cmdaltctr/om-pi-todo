import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescer, watchTarget } from "../src/openspec/watch.js";

describe("coalescer", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function make(run: () => Promise<void> | void, onError: (error: unknown) => void = () => undefined) {
		return createCoalescer(run, { delayMs: 100, onError });
	}

	it("runs once for a burst of triggers, after the quiet period", async () => {
		const run = vi.fn();
		const c = make(run);
		for (let i = 0; i < 20; i++) {
			c.trigger();
			await vi.advanceTimersByTimeAsync(30);
		}
		expect(run).not.toHaveBeenCalled(); // still inside the burst
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("does nothing without a trigger", async () => {
		const run = vi.fn();
		make(run);
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).not.toHaveBeenCalled();
	});

	it("runs again after a trigger that arrives while a run is in progress, never concurrently", async () => {
		let release!: () => void;
		let inside = 0;
		let peak = 0;
		let calls = 0;
		const run = async () => {
			calls++;
			peak = Math.max(peak, ++inside);
			if (calls === 1) await new Promise<void>((r) => (release = r));
			inside--;
		};
		const c = make(run);
		c.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toBe(1);
		c.trigger(); // arrives mid-run
		c.trigger();
		await vi.advanceTimersByTimeAsync(500);
		expect(calls).toBe(1); // still waiting for the first run
		release();
		await vi.advanceTimersByTimeAsync(200);
		expect(calls).toBe(2);
		expect(peak).toBe(1);
	});

	it("reports a failing run and keeps working", async () => {
		const errors: unknown[] = [];
		let n = 0;
		const c = make(
			async () => {
				if (++n === 1) throw new Error("boom");
			},
			(e) => void errors.push(e),
		);
		c.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(errors).toHaveLength(1);
		c.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(n).toBe(2);
	});

	it("cancel drops a pending run and a queued rerun", async () => {
		const run = vi.fn();
		const c = make(run);
		c.trigger();
		c.cancel();
		await vi.advanceTimersByTimeAsync(500);
		expect(run).not.toHaveBeenCalled();

		let release!: () => void;
		let calls = 0;
		const c2 = make(async () => {
			if (++calls === 1) await new Promise<void>((r) => (release = r));
		});
		c2.trigger();
		await vi.advanceTimersByTimeAsync(100);
		c2.trigger(); // queued rerun
		c2.cancel();
		release();
		await vi.advanceTimersByTimeAsync(500);
		expect(calls).toBe(1);
	});

	it("cancel clears a pending timer", async () => {
		const c = make(vi.fn());
		c.trigger();
		expect(vi.getTimerCount()).toBe(1);
		c.cancel();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores triggers after cancel and leaves no timers behind", async () => {
		const run = vi.fn();
		const c = make(run);
		c.cancel();
		c.trigger();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(500);
		expect(run).not.toHaveBeenCalled();
	});

	it("idle resolves when the pending work has finished", async () => {
		let done = false;
		const c = make(async () => {
			await new Promise((r) => setTimeout(r, 50));
			done = true;
		});
		c.trigger();
		const idle = c.idle();
		await vi.advanceTimersByTimeAsync(300);
		await idle;
		expect(done).toBe(true);
	});
});

// Real file-system events can arrive late on a busy machine. The wait inside each test is 10 s,
// so the test timeout must be longer than that, or the wait can never help.
/** A fake `fs.watch` that records every watcher, so tests can fire events and failures by hand. */
function fakeWatch() {
	const watchers: Array<{
		path: string;
		closed: boolean;
		fire: (event: string, name: string | null) => void;
		/** Deliver an event even after close, as a platform can for an event already queued. */
		late: (event: string, name: string | null) => void;
		fail: (error: Error) => void;
	}> = [];
	const impl = ((path: string, _options: unknown, listener: (event: string, name: string | null) => void) => {
		const handlers: Array<(e: unknown) => void> = [];
		const w = {
			path,
			closed: false,
			fire: (event: string, name: string | null) => {
				if (!w.closed) listener(event, name);
			},
			late: (event: string, name: string | null) => listener(event, name),
			fail: (error: Error) => handlers.forEach((h) => h(error)),
		};
		watchers.push(w);
		return { close: () => void (w.closed = true), on: (_: string, h: (e: unknown) => void) => void handlers.push(h) };
	}) as never;
	return { watchers, impl };
}

describe("watching the file's folder and its parent", () => {
	const FILE = "/r/openspec/changes/a/tasks.md";

	it("watches the folder that holds the file, and that folder's parent", () => {
		const { watchers, impl } = fakeWatch();
		watchTarget(FILE, () => undefined, { watchImpl: impl });
		expect(watchers.map((w) => w.path)).toEqual(["/r/openspec/changes/a", "/r/openspec/changes"]);
	});

	it("reports an event in the folder that names the file, and ignores other names", () => {
		const { watchers, impl } = fakeWatch();
		let events = 0;
		watchTarget(FILE, () => void events++, { watchImpl: impl });
		watchers[0].fire("change", "tasks.md");
		watchers[0].fire("rename", "tasks.md");
		expect(events).toBe(2);
		watchers[0].fire("change", "other.md");
		watchers[0].fire("rename", "tasks.md.pi-todo.lock");
		expect(events).toBe(2);
	});

	it("reports the change folder being renamed or removed, seen from its parent", () => {
		const { watchers, impl } = fakeWatch();
		let events = 0;
		watchTarget(FILE, () => void events++, { watchImpl: impl });
		watchers[1].fire("rename", "a");
		expect(events).toBe(1);
	});

	it("ignores a sibling change in the parent folder, and edits inside the parent that are not renames", () => {
		const { watchers, impl } = fakeWatch();
		let events = 0;
		watchTarget(FILE, () => void events++, { watchImpl: impl });
		watchers[1].fire("rename", "another-change");
		watchers[1].fire("change", "a");
		expect(events).toBe(0);
	});

	it("reports when the platform does not say what changed, in either watcher", () => {
		const { watchers, impl } = fakeWatch();
		let events = 0;
		watchTarget(FILE, () => void events++, { watchImpl: impl });
		watchers[0].fire("rename", null);
		watchers[1].fire("rename", null);
		expect(events).toBe(2);
	});

	it("closes both watchers, once, and reports nothing afterwards", () => {
		const { watchers, impl } = fakeWatch();
		let events = 0;
		const w = watchTarget(FILE, () => void events++, { watchImpl: impl });
		w.close();
		w.close();
		expect(watchers.every((x) => x.closed)).toBe(true);
		watchers[0].fire("change", "tasks.md");
		watchers[1].fire("rename", "a");
		expect(events).toBe(0);
	});

	it("ignores an event the platform delivers after close, in both watchers and with no name", () => {
		const { watchers, impl } = fakeWatch();
		let events = 0;
		watchTarget(FILE, () => void events++, { watchImpl: impl }).close();
		watchers[0].late("change", "tasks.md");
		watchers[0].late("rename", null);
		watchers[1].late("rename", "a");
		watchers[1].late("rename", null);
		expect(events).toBe(0);
	});

	it("a failing parent watcher is reported, and the folder watcher keeps working", () => {
		const { watchers, impl } = fakeWatch();
		const errors: string[] = [];
		let events = 0;
		watchTarget(FILE, () => void events++, { watchImpl: impl, onError: (e) => errors.push(String(e)) });
		watchers[1].fail(new Error("EMFILE"));
		expect(errors).toEqual(["Error: EMFILE"]);
		expect(watchers[1].closed).toBe(true);
		expect(watchers[0].closed).toBe(false);
		watchers[0].fire("change", "tasks.md");
		expect(events).toBe(1);
	});

	it("a failing folder watcher is reported and stops everything, as before", () => {
		const { watchers, impl } = fakeWatch();
		const errors: string[] = [];
		watchTarget(FILE, () => undefined, { watchImpl: impl, onError: (e) => errors.push(String(e)) });
		watchers[0].fail(new Error("EBADF"));
		expect(errors).toEqual(["Error: EBADF"]);
		expect(watchers.every((w) => w.closed)).toBe(true);
	});

	it("a parent that cannot be watched does not stop the folder watcher", () => {
		const { watchers, impl } = fakeWatch();
		const errors: string[] = [];
		const flaky = ((path: string, o: unknown, l: never) => {
			if (path === "/r/openspec/changes") throw new Error("ENOENT");
			return (impl as unknown as (p: string, o: unknown, l: never) => unknown)(path, o, l);
		}) as never;
		watchTarget(FILE, () => undefined, { watchImpl: flaky, onError: (e) => errors.push(String(e)) });
		expect(errors).toEqual(["Error: ENOENT"]);
		expect(watchers.map((w) => w.path)).toEqual(["/r/openspec/changes/a"]);
		expect(watchers[0].closed).toBe(false);
	});

	it("a file at the root of the file system has no parent to watch", () => {
		const { watchers, impl } = fakeWatch();
		watchTarget("/tasks.md", () => undefined, { watchImpl: impl });
		expect(watchers.map((w) => w.path)).toEqual(["/"]);
	});
});

describe("file watcher", { timeout: 30_000 }, () => {
	let dir = "";
	let file = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-todo-watch-"));
		file = join(dir, "tasks.md");
		writeFileSync(file, "- [ ] A\n");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	async function until(check: () => boolean, ms = 10_000) {
		const end = Date.now() + ms;
		while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
		return check();
	}

	it("reports an in-place edit", async () => {
		let events = 0;
		const w = watchTarget(file, () => void events++);
		await new Promise((r) => setTimeout(r, 400)); // let the platform finish arming the watch
		writeFileSync(file, "- [x] A\n");
		expect(await until(() => events > 0)).toBe(true);
		w.close();
	});

	it("reports an atomic replace by rename, as the writer and most editors do", async () => {
		let events = 0;
		const w = watchTarget(file, () => void events++);
		await new Promise((r) => setTimeout(r, 400)); // let the platform finish arming the watch
		writeFileSync(join(dir, "staged.tmp"), "- [x] A\n");
		renameSync(join(dir, "staged.tmp"), file);
		expect(await until(() => events > 0)).toBe(true);
		w.close();
	});

	it("keeps reporting after the first replace", async () => {
		let events = 0;
		const w = watchTarget(file, () => void events++);
		await new Promise((r) => setTimeout(r, 400)); // let the platform finish arming the watch
		for (let i = 0; i < 2; i++) {
			const before = events;
			writeFileSync(join(dir, `s${i}.tmp`), `- [ ] ${i}\n`);
			renameSync(join(dir, `s${i}.tmp`), file);
			expect(await until(() => events > before)).toBe(true);
		}
		w.close();
	});

	it("ignores unrelated files in the same directory, including the writer's staging files", async () => {
		let events = 0;
		const w = watchTarget(file, () => void events++);
		await new Promise((r) => setTimeout(r, 400)); // let any late event for the setup write arrive
		events = 0;
		writeFileSync(join(dir, "other.md"), "x");
		writeFileSync(join(dir, "tasks.md.123.abcd.pi-todo.tmp"), "x");
		writeFileSync(join(dir, "tasks.md.pi-todo.lock"), "x");
		await new Promise((r) => setTimeout(r, 300));
		expect(events).toBe(0);
		w.close();
	});

	it("stops reporting once closed, and closing twice is harmless", async () => {
		let events = 0;
		const w = watchTarget(file, () => void events++);
		w.close();
		w.close();
		writeFileSync(file, "- [x] A\n");
		await new Promise((r) => setTimeout(r, 300));
		expect(events).toBe(0);
	});

	it("reports the directory being moved away, as when a change is archived", async () => {
		const changeDir = join(dir, "change");
		mkdirSync(changeDir);
		const inner = join(changeDir, "tasks.md");
		writeFileSync(inner, "- [ ] A\n");
		let events = 0;
		const w = watchTarget(inner, () => void events++);
		await new Promise((r) => setTimeout(r, 400)); // let the platform finish arming the watch
		renameSync(changeDir, join(dir, "archived"));
		expect(await until(() => events > 0)).toBe(true);
		w.close();
	});

	it("does not throw for a path that does not exist, and reports the failure", () => {
		const failures: string[] = [];
		const w = watchTarget(join(dir, "nope", "tasks.md"), () => undefined, { onError: (e) => failures.push(String(e)) });
		expect(failures).toHaveLength(1);
		w.close();
	});
});
