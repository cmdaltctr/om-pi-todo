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
		const c = make(async () => {
			if (++n === 1) throw new Error("boom");
		}, (e) => void errors.push(e));
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

describe("file watcher", () => {
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
