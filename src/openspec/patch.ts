/**
 * Narrow checkbox patch: mark one task done and change nothing else.
 *
 * The target is found by the fingerprint of its wording in a fresh scan of the
 * bytes about to be replaced, never by a CLI row number or a stored offset. Only
 * the marker character inside the matched box changes, so line endings, byte
 * order marks, spacing and every other line stay byte-identical. A file that does
 * not survive a UTF-8 round trip is refused, because rewriting it would alter
 * bytes other than the marker.
 */

import { listTasks, scanTasks } from "./tasks.js";

export interface PatchTarget {
	/** Fingerprint of the task's normalised wording. */
	fingerprint: string;
}

export type PatchResult =
	| { ok: true; bytes: Buffer; changed: boolean }
	| { ok: false; code: "not-utf8" | "missing" | "ambiguous"; reason: string };

export function patchCompletion(original: Buffer, target: PatchTarget): PatchResult {
	const text = original.toString("utf-8");
	if (!Buffer.from(text, "utf-8").equals(original)) {
		return {
			ok: false,
			code: "not-utf8",
			reason: "The task file is not valid UTF-8, so it cannot be edited without changing other bytes.",
		};
	}

	const matches = listTasks(scanTasks(text)).filter((task) => task.fingerprint === target.fingerprint);
	if (matches.length === 0)
		return { ok: false, code: "missing", reason: "The task wording is no longer in the file. Refresh and retry." };
	if (matches.length > 1)
		return {
			ok: false,
			code: "ambiguous",
			reason: `${matches.length} tasks share this wording. Make each task unique in tasks.md.`,
		};

	const task = matches[0];
	if (task.done) return { ok: true, bytes: original, changed: false };

	const inner = text.slice(task.boxStart + 1, task.boxEnd);
	const marker = inner.search(/\S/);
	// Replace the marker in place; in a whitespace-only box replace its first space, or fill an empty box.
	const at = task.boxStart + 1 + (marker >= 0 ? marker : 0);
	const replaced = marker >= 0 || inner.length > 0 ? 1 : 0;
	const patched = `${text.slice(0, at)}x${text.slice(at + replaced)}`;
	return { ok: true, bytes: Buffer.from(patched, "utf-8"), changed: true };
}
