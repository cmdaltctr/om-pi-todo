/**
 * Guarded completion of one linked task.
 *
 * A completion succeeds only when three things hold: the checkbox is persisted
 * in the tracked file, a fresh CLI read shows the same task done, and nothing on
 * the way contradicted either. Everything else is reported as what it is:
 * rejected (nothing written), unconfirmed or view-unavailable (written, not
 * proven), or cancelled. There is no local-only fallback, and a write that has
 * landed is never rolled back or repeated.
 *
 * Steps: refresh the view, check the caller's revision, resolve the real path
 * inside the confirmed change directory, then under a short per-file lock re-read
 * and compare the revision, patch only the target's marker, stage the bytes beside
 * the file, compare the revision again, and replace the file atomically.
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { isInside } from "./discover.js";
import { type LockOptions, withTargetLock } from "./lock.js";
import { patchCompletion } from "./patch.js";
import type { Snapshot, createSnapshotProvider } from "./snapshot.js";
import { revisionOf } from "./tasks.js";

type Provider = ReturnType<typeof createSnapshotProvider>;

/** File operations the writer uses. Tests replace single members to inject faults. */
export interface WriterFs {
	realpath(path: string): Promise<string>;
	readFile(path: string): Promise<Buffer>;
	stat(path: string): Promise<{ mode: number }>;
	/** Resolves when the file can be written by this process. */
	access(path: string): Promise<void>;
	/** Create `path` exclusively, write `bytes`, flush to disk, and set `mode`. */
	writeStaged(path: string, bytes: Buffer, mode: number): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

export const defaultFs: WriterFs = {
	realpath: (path) => realpath(path),
	readFile: (path) => readFile(path),
	stat: (path) => stat(path),
	access: (path) => access(path, constants.W_OK),
	async writeStaged(path, bytes, mode) {
		const handle = await open(path, "wx", mode);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await chmod(path, mode);
	},
	rename: (from, to) => rename(from, to),
	unlink: (path) => unlink(path),
};

export type RejectCode =
	| "unbound"
	| "not-writable"
	| "stale-revision"
	| "unknown-task"
	| "unmappable"
	| "not-editable"
	| "unsafe-path"
	| "permission"
	| "conflict"
	| "lock-contended"
	| "write-failed";

export type CompletionOutcome =
	| { kind: "completed"; changed: boolean; revision: string; snapshot: Snapshot; warnings?: string[] }
	| { kind: "rejected"; code: RejectCode; message: string; action: string; snapshot: Snapshot }
	| { kind: "unconfirmed"; message: string; action: string; snapshot: Snapshot; warnings?: string[] }
	| { kind: "persisted-view-unavailable"; message: string; action: string; snapshot: Snapshot; warnings?: string[] }
	| { kind: "cancelled"; message: string; snapshot: Snapshot };

export interface WriterDeps {
	provider: Provider;
	fs?: Partial<WriterFs>;
	lock?: Pick<LockOptions, "waitMs" | "pollMs">;
	/**
	 * Called after every write that persisted, so the panel can repaint. A failure
	 * is reported as a warning and never changes the outcome of the write.
	 */
	onCommitted?: (snapshot: Snapshot) => void | Promise<void>;
}

const PERMISSION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
const REFRESH = "Run /todos refresh, list the tasks again, then retry with the new revision.";

/** Internal result of the locked section. */
type Staged = { persisted: true } | { persisted: false; code: RejectCode; message: string; action: string };

export function createWriter(deps: WriterDeps) {
	const { provider } = deps;
	const fs = (): WriterFs => ({ ...defaultFs, ...deps.fs });

	async function complete(sessionId: string, localId: number, expectedRevision: string, options: { signal?: AbortSignal } = {}): Promise<CompletionOutcome> {
		const { signal } = options;
		const view = () => provider.getSnapshot(sessionId);
		const reject = (code: RejectCode, message: string, action: string): CompletionOutcome => ({ kind: "rejected", code, message, action, snapshot: view() });
		const cancelled = (message: string): CompletionOutcome => ({ kind: "cancelled", message, snapshot: view() });

		const mode = view();
		if (mode.freshness === "inactive" || mode.freshness === "unbound" || !mode.binding) {
			return reject("unbound", "This session is not bound to an OpenSpec change.", "Choose a change with /todo-settings.");
		}
		if (signal?.aborted) return cancelled("Cancelled before the completion started");

		const snap = await provider.refresh(sessionId, { signal });
		if (signal?.aborted) return cancelled("Cancelled while reading the task file");
		if (snap.freshness !== "fresh" || !snap.writable || !snap.file || !snap.changeRoot || !snap.revision) {
			return reject("not-writable", `Linked tasks cannot be changed now: ${snap.diagnostics.join("; ") || snap.freshness}`, REFRESH);
		}
		if (!expectedRevision || expectedRevision !== snap.revision) {
			return reject("stale-revision", `The task file changed since you last read it (your revision ${expectedRevision || "missing"}, current ${snap.revision}).`, REFRESH);
		}

		const row = snap.linked.find((r) => r.id === localId);
		if (!row) return reject("unknown-task", `Task #${localId} is not in the current OpenSpec task list. It may have been removed or reworded.`, REFRESH);
		if (!row.mapping.ok) return reject("unmappable", `Task #${localId} cannot be matched to one checkbox: ${row.mapping.reason}`, "Fix tasks.md so the task is unique, then refresh.");
		if (row.done) return { kind: "completed", changed: false, revision: snap.revision, snapshot: snap };

		const io = fs();
		let real: string;
		try {
			const [file, dir, planning] = await Promise.all([io.realpath(snap.file), io.realpath(snap.changeRoot), io.realpath(snap.binding!.root)]);
			if (!isInside(planning, dir) || !isInside(dir, file)) {
				return reject("unsafe-path", "The task file resolves outside the confirmed change directory, so it will not be edited.", "Fix the link or choose another change with /todo-settings.");
			}
			real = file;
		} catch (error) {
			return reject("unsafe-path", `The task file path could not be resolved: ${(error as Error).message}`, REFRESH);
		}
		try {
			await io.access(real);
		} catch (error) {
			return reject("permission", `The task file is not writable: ${(error as Error).message}`, "Make the file writable or check the box yourself, then refresh.");
		}

		const section = async (): Promise<Staged> => {
			const f = fs();
			const fail = (code: RejectCode, message: string, action: string): Staged => ({ persisted: false, code, message, action });
			let staged: string | undefined;
			try {
				const bytes = await f.readFile(real);
				if (revisionOf(bytes) !== snap.revision) return fail("conflict", "The task file changed while the write was waiting.", REFRESH);

				const patch = patchCompletion(bytes, { fingerprint: row.fingerprint });
				if (!patch.ok) {
					const code: RejectCode = patch.code === "not-utf8" ? "not-editable" : patch.code === "ambiguous" ? "unmappable" : "conflict";
					return fail(code, patch.reason, REFRESH);
				}

				const { mode } = await f.stat(real);
				staged = `${real}.${process.pid}.${randomBytes(4).toString("hex")}.pi-todo.tmp`;
				await f.writeStaged(staged, patch.bytes, mode & 0o777);

				if (revisionOf(await f.readFile(real)) !== snap.revision) return fail("conflict", "The task file changed while the new version was being staged.", REFRESH);
				if (signal?.aborted) return fail("write-failed", "Cancelled before the file was replaced.", "Retry when ready.");

				await f.rename(staged, real);
				staged = undefined;
				return { persisted: true };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code && PERMISSION_CODES.has(code)) return fail("permission", `The task file could not be written: ${(error as Error).message}`, "Fix the permissions or check the box yourself, then refresh.");
				return fail("write-failed", `The task file could not be written: ${(error as Error).message}`, REFRESH);
			} finally {
				if (staged) await f.unlink(staged).catch(() => undefined);
			}
		};

		const locked = await withTargetLock(real, { ...deps.lock, signal }, section);
		if (!locked.ok) {
			if (locked.kind === "cancelled") return cancelled(locked.message);
			if (locked.kind === "contended") return reject("lock-contended", locked.message, "Wait for the other writer to finish, or follow the recovery step above, then retry.");
			if (locked.code && PERMISSION_CODES.has(locked.code)) return reject("permission", locked.message, "Fix the directory permissions or check the box yourself, then refresh.");
			return reject("write-failed", locked.message, REFRESH);
		}
		const staged = locked.value;
		if (!staged.persisted) {
			if (staged.message === "Cancelled before the file was replaced.") return cancelled(staged.message);
			return reject(staged.code, staged.message, staged.action);
		}

		// Persisted. From here nothing is rolled back or repeated; only the truth is reported.
		const repaint = async (snapshot: Snapshot): Promise<string[] | undefined> => {
			try {
				await deps.onCommitted?.(snapshot);
				return undefined;
			} catch (error) {
				return [`The panel could not be repainted: ${(error as Error).message}. Run /todos refresh.`];
			}
		};
		const after = await provider.refresh(sessionId, { signal });
		if (after.freshness !== "fresh") {
			provider.blockWrites(sessionId, "A completion was written but the view could not be refreshed.");
			const warnings = await repaint(view());
			return {
				kind: "persisted-view-unavailable",
				message: `The checkbox for task #${localId} was written, but the OpenSpec view could not be refreshed: ${after.diagnostics.join("; ") || after.freshness}.`,
				action: "Run /todos refresh. Do not repeat the completion.",
				snapshot: view(),
				...(warnings ? { warnings } : {}),
			};
		}
		const confirmed = after.linked.filter((r) => r.fingerprint === row.fingerprint);
		if (confirmed.length !== 1 || !confirmed[0].done) {
			provider.blockWrites(sessionId, "A completion was written but OpenSpec did not confirm the task as done.");
			const warnings = await repaint(view());
			return {
				kind: "unconfirmed",
				message: `Task #${localId} was not confirmed as done by OpenSpec after the write. No other task or count is accepted as proof.`,
				action: "Run /todos refresh and check tasks.md before trying again.",
				snapshot: view(),
				...(warnings ? { warnings } : {}),
			};
		}
		const warnings = await repaint(after);
		return { kind: "completed", changed: true, revision: after.revision!, snapshot: after, ...(warnings ? { warnings } : {}) };
	}

	return { complete };
}
