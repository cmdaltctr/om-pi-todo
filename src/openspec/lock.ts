/**
 * Short-lived write lock for one task file.
 *
 * Two layers. Inside this process a per-target queue runs critical sections one
 * at a time. Across processes an exclusively created lock file, `<file>.pi-todo.lock`
 * beside the target, records the owner (pid, host, time, target, random token).
 * The lock covers one write only: it never reserves a project or a session.
 *
 * A lock is never taken over because of its age or because its owner looks dead.
 * After the bounded wait the caller gets the owner's details and the manual
 * recovery step, which needs a person to confirm the owner has stopped. Release
 * removes the file only while it still holds this lock's token. The read-then-
 * remove in release cannot be atomic with plain files; that narrow window is a
 * known limit.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

export interface LockOwner {
	pid: number;
	host: string;
	createdAt: string;
	target: string;
	token: string;
}

export type OwnerState = "running" | "not-running" | "other-host";

export interface LockOptions {
	/** Longest time to wait for a held lock. */
	waitMs?: number;
	pollMs?: number;
	signal?: AbortSignal;
}

export type ReleaseResult =
	| { released: true }
	| { released: false; reason: "not-owner" | "missing" | "already-released" | "error"; message?: string };

export interface HeldLock {
	path: string;
	token: string;
	release(): Promise<ReleaseResult>;
}

export type AcquireResult =
	| { ok: true; lock: HeldLock }
	| { ok: false; kind: "contended"; message: string; lockPath: string; owner?: LockOwner & { state: OwnerState } }
	| { ok: false; kind: "cancelled"; message: string; lockPath: string }
	| { ok: false; kind: "error"; message: string; lockPath: string; code?: string };

export type SectionResult<T> = { ok: true; value: T } | Exclude<AcquireResult, { ok: true }>;

const DEFAULT_WAIT_MS = 3_000;
const DEFAULT_POLL_MS = 50;

export function lockPathFor(target: string): string {
	// nosemgrep: AIK_ts_generic_path_traversal -- path is resolved and checked inside the confirmed OpenSpec root
	return join(dirname(target), `${basename(target)}.pi-todo.lock`);
}

function parseOwner(text: string): LockOwner | undefined {
	try {
		const v = JSON.parse(text) as Partial<LockOwner> | null;
		if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
		const { pid, host, createdAt, target, token } = v;
		if (
			typeof pid !== "number" ||
			!Number.isInteger(pid) ||
			typeof host !== "string" ||
			typeof createdAt !== "string" ||
			typeof target !== "string" ||
			typeof token !== "string"
		)
			return undefined;
		return { pid, host, createdAt, target, token };
	} catch {
		return undefined;
	}
}

/** Compare two tokens in constant time. Tokens of different length never match. */
function sameToken(a: string | undefined, b: string): boolean {
	if (a === undefined) return false;
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function ownerState(owner: LockOwner): OwnerState {
	if (owner.host !== hostname()) return "other-host";
	try {
		process.kill(owner.pid, 0);
		return "running";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "not-running" : "running";
	}
}

/** Sleep that ends early, without throwing, when the signal aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

async function contended(lockPath: string): Promise<AcquireResult> {
	let text = "";
	try {
		// nosemgrep: AIK_ts_generic_path_traversal
		text = await readFile(lockPath, "utf-8");
	} catch {
		// vanished between attempts; report as unreadable below
	}
	const owner = parseOwner(text);
	if (!owner) {
		return {
			ok: false,
			kind: "contended",
			lockPath,
			message: `The task file lock ${lockPath} exists and its owner cannot be read. If no other Pi session is editing this task file, delete it and retry.`,
		};
	}
	const state = ownerState(owner);
	const label =
		state === "other-host"
			? "on another host, so liveness is unknown"
			: state === "not-running"
				? "which no longer appears to be running"
				: "which is running";
	return {
		ok: false,
		kind: "contended",
		lockPath,
		owner: { ...owner, state },
		message: `The task file is locked by process ${owner.pid} on ${owner.host} since ${owner.createdAt} (${label}). If that process has stopped, delete ${lockPath} and retry.`,
	};
}

/** Take the file lock, waiting up to `waitMs`. Never throws. */
export async function acquireLock(target: string, options: LockOptions = {}): Promise<AcquireResult> {
	const { signal } = options;
	const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const lockPath = lockPathFor(target);
	const deadline = Date.now() + waitMs;
	const cancelled = (): AcquireResult => ({ ok: false, kind: "cancelled", lockPath, message: "Lock wait cancelled" });

	for (;;) {
		if (signal?.aborted) return cancelled();
		const token = randomBytes(16).toString("hex");
		const owner: LockOwner = { pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), target, token };
		try {
			// nosemgrep: AIK_ts_generic_path_traversal -- path is resolved and checked inside the confirmed OpenSpec root
			const handle = await open(lockPath, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(owner));
			} catch (error) {
				await handle.close().catch(() => undefined);
				await unlink(lockPath).catch(() => undefined);
				return {
					ok: false,
					kind: "error",
					lockPath,
					code: (error as NodeJS.ErrnoException).code,
					message: `Could not write the lock ${lockPath}: ${(error as Error).message}`,
				};
			}
			await handle.close();
			if (signal?.aborted) {
				await unlink(lockPath).catch(() => undefined);
				return cancelled();
			}
			let released = false;
			return {
				ok: true,
				lock: {
					path: lockPath,
					token,
					async release(): Promise<ReleaseResult> {
						if (released) return { released: false, reason: "already-released" };
						released = true;
						try {
							// nosemgrep: AIK_ts_generic_path_traversal -- path is resolved and checked inside the confirmed OpenSpec root
							const current = parseOwner(await readFile(lockPath, "utf-8"));
							if (!sameToken(current?.token, token)) return { released: false, reason: "not-owner" };
							await unlink(lockPath);
							return { released: true };
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return { released: false, reason: "missing" };
							return { released: false, reason: "error", message: (error as Error).message };
						}
					},
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				return {
					ok: false,
					kind: "error",
					lockPath,
					code: (error as NodeJS.ErrnoException).code,
					message: `Could not create the lock ${lockPath}: ${(error as Error).message}`,
				};
			}
		}
		if (Date.now() >= deadline) return contended(lockPath);
		await pause(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
	}
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Run `section` while holding this process's turn for `target` and the file lock.
 * Sections for one target run in call order; different targets run together.
 * A section that throws releases the lock and the error propagates.
 */
export function withTargetLock<T>(
	target: string,
	options: LockOptions,
	section: () => Promise<T>,
): Promise<SectionResult<T>> {
	const { signal } = options;
	const lockPath = lockPathFor(target);
	const previous = (queues.get(target) ?? Promise.resolve()).catch(() => undefined);
	let started = false;

	const work = previous.then(async (): Promise<SectionResult<T>> => {
		if (signal?.aborted)
			return { ok: false, kind: "cancelled", lockPath, message: "Cancelled before the write started" };
		const acquired = await acquireLock(target, options);
		if (!acquired.ok) return acquired;
		started = true; // from here an abort no longer overrides the section's own result
		try {
			return { ok: true, value: await section() };
		} finally {
			await acquired.lock.release();
		}
	});

	const tail = work.catch(() => undefined);
	queues.set(target, tail);
	void tail.finally(() => {
		if (queues.get(target) === tail) queues.delete(target);
	});

	if (!signal) return work;
	// A caller that aborts while queued is released at once; its turn still passes in order and does nothing.
	let onAbort: () => void = () => undefined;
	const aborted = new Promise<SectionResult<T>>((resolve) => {
		onAbort = () => {
			if (!started)
				resolve({ ok: false, kind: "cancelled", lockPath, message: "Cancelled while waiting for an earlier write" });
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}
