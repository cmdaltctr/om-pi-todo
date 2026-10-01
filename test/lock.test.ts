import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockPathFor, withTargetLock } from "../src/openspec/lock.js";

let dir = "";
let target = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-todo-lock-"));
	target = join(dir, "tasks.md");
	writeFileSync(target, "- [ ] A\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAST = { waitMs: 150, pollMs: 10 };

function held(result: Awaited<ReturnType<typeof acquireLock>>) {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.message);
	return result.lock;
}

describe("lock file and owner metadata", () => {
	it("sits beside the target with a recognisable name", () => {
		expect(lockPathFor(target)).toBe(join(dir, "tasks.md.pi-todo.lock"));
	});

	it("is created with owner pid, host, time, target, and a random token, readable only by the owner", async () => {
		const lock = held(await acquireLock(target, FAST));
		const meta = JSON.parse(readFileSync(lock.path, "utf-8"));
		expect(meta).toMatchObject({ pid: process.pid, host: hostname(), target });
		expect(new Date(meta.createdAt).toISOString()).toBe(meta.createdAt);
		expect(meta.token).toMatch(/^[0-9a-f]{32}$/);
		expect(meta.token).toBe(lock.token);
		expect(statSync(lock.path).mode & 0o777).toBe(0o600);
		await lock.release();
	});

	it("uses a different token for every lock", async () => {
		const a = held(await acquireLock(target, FAST));
		await a.release();
		const b = held(await acquireLock(target, FAST));
		expect(a.token).not.toBe(b.token);
		await b.release();
	});

	it("reports a missing directory as an error without creating anything", async () => {
		const result = await acquireLock(join(dir, "missing-dir", "tasks.md"), FAST);
		expect(result).toMatchObject({ ok: false, kind: "error" });
	});
});

describe("contention", () => {
	it("lets exactly one of several simultaneous acquirers win", async () => {
		const results = await Promise.all(Array.from({ length: 8 }, () => acquireLock(target, { waitMs: 0, pollMs: 5 })));
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		for (const r of results) if (r.ok) await r.lock.release();
	});

	it("waits for a release that arrives within the bound", async () => {
		const first = held(await acquireLock(target, FAST));
		const pending = acquireLock(target, { waitMs: 2000, pollMs: 10 });
		await sleep(60);
		await first.release();
		held(await pending);
	});

	it("gives up after the bound and names the owner and the manual recovery step", async () => {
		const first = held(await acquireLock(target, FAST));
		const started = Date.now();
		const result = await acquireLock(target, FAST);
		const waited = Date.now() - started;
		expect(result).toMatchObject({
			ok: false,
			kind: "contended",
			owner: { pid: process.pid, host: hostname(), state: "running" },
		});
		expect(waited).toBeGreaterThanOrEqual(140);
		expect(waited).toBeLessThan(1500);
		if (result.ok) return;
		expect(result.message).toContain(`process ${process.pid}`);
		expect(result.message).toContain(first.path);
		expect(result.message).toMatch(/If that process has stopped, delete/);
		expect(existsSync(first.path)).toBe(true);
		await first.release();
	});
});

describe("never steals a lock it cannot prove is free", () => {
	const writeLock = (content: string) => writeFileSync(lockPathFor(target), content);

	it("keeps an ancient lock whose process is gone, and reports that state", async () => {
		const meta = {
			pid: 2_000_000_000,
			host: hostname(),
			createdAt: "2001-01-01T00:00:00.000Z",
			target,
			token: "a".repeat(32),
		};
		writeLock(JSON.stringify(meta));
		const result = await acquireLock(target, FAST);
		expect(result).toMatchObject({ ok: false, kind: "contended", owner: { pid: 2_000_000_000, state: "not-running" } });
		expect(JSON.parse(readFileSync(lockPathFor(target), "utf-8"))).toEqual(meta);
	});

	it("keeps a lock from another host and says liveness is unknown", async () => {
		writeLock(
			JSON.stringify({
				pid: 1,
				host: "some-other-machine",
				createdAt: new Date().toISOString(),
				target,
				token: "b".repeat(32),
			}),
		);
		const result = await acquireLock(target, FAST);
		expect(result).toMatchObject({ ok: false, kind: "contended", owner: { state: "other-host" } });
		expect(existsSync(lockPathFor(target))).toBe(true);
	});

	it("keeps a lock whose contents cannot be read", async () => {
		for (const junk of ["", "not json", "[]", '{"pid":"x"}']) {
			writeLock(junk);
			const result = await acquireLock(target, { waitMs: 30, pollMs: 10 });
			expect(result).toMatchObject({ ok: false, kind: "contended" });
			expect((result as { owner?: unknown }).owner).toBeUndefined();
			expect(!result.ok && result.message).toMatch(/cannot be read/);
			expect(readFileSync(lockPathFor(target), "utf-8")).toBe(junk);
		}
	});
});

describe("release", () => {
	it("removes the lock when the token matches", async () => {
		const lock = held(await acquireLock(target, FAST));
		expect(await lock.release()).toEqual({ released: true });
		expect(existsSync(lock.path)).toBe(false);
	});

	it("leaves a lock that now belongs to someone else", async () => {
		const lock = held(await acquireLock(target, FAST));
		const other = JSON.stringify({
			pid: 4242,
			host: "x",
			createdAt: new Date().toISOString(),
			target,
			token: "c".repeat(32),
		});
		writeFileSync(lock.path, other);
		expect(await lock.release()).toMatchObject({ released: false, reason: "not-owner" });
		expect(readFileSync(lock.path, "utf-8")).toBe(other);
	});

	it("reports a lock that has already gone without throwing", async () => {
		const lock = held(await acquireLock(target, FAST));
		rmSync(lock.path);
		expect(await lock.release()).toMatchObject({ released: false, reason: "missing" });
	});

	it("releases only once", async () => {
		const lock = held(await acquireLock(target, FAST));
		await lock.release();
		const again = held(await acquireLock(target, FAST));
		expect(await lock.release()).toEqual({ released: false, reason: "already-released" });
		expect(existsSync(again.path)).toBe(true);
		await again.release();
	});
});

describe("cancellation", () => {
	it("does not create a lock when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await acquireLock(target, { ...FAST, signal: controller.signal })).toMatchObject({
			ok: false,
			kind: "cancelled",
		});
		expect(existsSync(lockPathFor(target))).toBe(false);
	});

	it("removes a lock it just created when the signal aborts right after acquisition", async () => {
		let reads = 0;
		const signal = {
			get aborted() {
				return ++reads > 1;
			},
			addEventListener() {},
			removeEventListener() {},
		} as unknown as AbortSignal;
		expect(await acquireLock(target, { ...FAST, signal })).toMatchObject({ ok: false, kind: "cancelled" });
		expect(existsSync(lockPathFor(target))).toBe(false);
	});

	it("stops waiting when aborted and leaves the holder's lock alone", async () => {
		const first = held(await acquireLock(target, FAST));
		const controller = new AbortController();
		const pending = acquireLock(target, { waitMs: 60_000, pollMs: 30_000, signal: controller.signal }); // long poll: only a real abort wake-up ends it quickly
		await sleep(40);
		const started = Date.now();
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, kind: "cancelled" });
		expect(Date.now() - started).toBeLessThan(500);
		expect(JSON.parse(readFileSync(first.path, "utf-8")).token).toBe(first.token);
		await first.release();
	});
});

describe("serialising writers inside one process", () => {
	it("runs critical sections for one target one at a time, in order, losing no update", async () => {
		const counter = join(dir, "counter");
		writeFileSync(counter, "0");
		const order: number[] = [];
		await Promise.all(
			Array.from({ length: 15 }, (_, i) =>
				withTargetLock(target, FAST, async () => {
					const current = Number(readFileSync(counter, "utf-8"));
					await sleep(3); // a window in which an unserialised writer would interleave
					writeFileSync(counter, String(current + 1));
					order.push(i);
				}),
			),
		);
		expect(readFileSync(counter, "utf-8")).toBe("15");
		expect(order).toEqual(Array.from({ length: 15 }, (_, i) => i));
		expect(existsSync(lockPathFor(target))).toBe(false);
	});

	it("does not make queued writers wait on the file lock timeout", async () => {
		const slow = withTargetLock(target, { waitMs: 50, pollMs: 5 }, async () => sleep(200));
		const queued = withTargetLock(target, { waitMs: 50, pollMs: 5 }, async () => "ran");
		expect(await slow).toMatchObject({ ok: true });
		expect(await queued).toEqual({ ok: true, value: "ran" });
	});

	it("lets different targets run at the same time", async () => {
		const other = join(dir, "other.md");
		writeFileSync(other, "- [ ] B\n");
		let inside = 0;
		let peak = 0;
		const section = async () => {
			peak = Math.max(peak, ++inside);
			await sleep(60);
			inside--;
		};
		await Promise.all([withTargetLock(target, FAST, section), withTargetLock(other, FAST, section)]);
		expect(peak).toBe(2);
	});

	it("releases the lock and rethrows when the section throws, and later sections still run", async () => {
		await expect(
			withTargetLock(target, FAST, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(lockPathFor(target))).toBe(false);
		expect(await withTargetLock(target, FAST, async () => 7)).toEqual({ ok: true, value: 7 });
	});

	it("reports a file lock held elsewhere without running the section", async () => {
		const foreign = held(await acquireLock(target, FAST));
		let ran = false;
		const result = await withTargetLock(target, FAST, async () => {
			ran = true;
		});
		expect(result).toMatchObject({ ok: false, kind: "contended" });
		expect(ran).toBe(false);
		await foreign.release();
	});

	it("cancels a queued section without running it, and the queue carries on", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const first = withTargetLock(target, FAST, () => gate);
		const controller = new AbortController();
		let ran = false;
		const queued = withTargetLock(target, { ...FAST, signal: controller.signal }, async () => {
			ran = true;
		});
		await sleep(20);
		controller.abort();
		expect(await queued).toMatchObject({ ok: false, kind: "cancelled" });
		release();
		await first;
		expect(await withTargetLock(target, FAST, async () => "after")).toEqual({ ok: true, value: "after" });
		expect(ran).toBe(false); // the cancelled turn has passed by now and did nothing
	});

	it("returns the section's own result when the abort arrives after it has started", async () => {
		const controller = new AbortController();
		const result = await withTargetLock(target, { ...FAST, signal: controller.signal }, async () => {
			controller.abort();
			await sleep(20);
			return "finished";
		});
		expect(result).toEqual({ ok: true, value: "finished" });
		expect(existsSync(lockPathFor(target))).toBe(false);
	});

	it("leaves no lock file behind after a busy run", async () => {
		await Promise.all(Array.from({ length: 5 }, () => withTargetLock(target, FAST, async () => undefined)));
		expect(readdirSync(dir).filter((f) => f.endsWith(".lock"))).toEqual([]);
		expect(basename(lockPathFor(target))).toBe("tasks.md.pi-todo.lock");
	});
});
