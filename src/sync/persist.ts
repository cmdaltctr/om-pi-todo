/**
 * Restoring linked ids and activity from session history.
 *
 * Sync-mode `todo` results carry a `linked` block beside the ordinary tasks. On
 * resume the last block that belongs to the current binding seeds the provider,
 * so ids and session activity survive reload and compaction. Wording and
 * completion are never stored: they always come from tasks.md.
 */

import type { PersistedLinked } from "../openspec/snapshot.js";
import type { Binding } from "../session-mode.js";

function validRow(value: unknown): value is PersistedLinked["rows"][number] {
	if (!value || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return Number.isSafeInteger(r.id) && (r.id as number) > 0 && typeof r.fingerprint === "string" && r.fingerprint !== "" && (r.label === undefined || typeof r.label === "string") && (r.activity === undefined || (typeof r.activity === "object" && r.activity !== null && !Array.isArray(r.activity)));
}

function parseLinked(value: unknown): PersistedLinked | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	const b = v.binding as Record<string, unknown> | undefined;
	if (!b || typeof b.root !== "string" || typeof b.change !== "string") return undefined;
	if (!Number.isSafeInteger(v.nextId) || !Array.isArray(v.rows) || !v.rows.every(validRow)) return undefined;
	return { binding: { root: b.root, change: b.change }, nextId: v.nextId as number, rows: v.rows as PersistedLinked["rows"] };
}

/** The last persisted linked data on the branch that was saved for `binding`. */
export function replayLinked(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }, binding: Binding): PersistedLinked | undefined {
	let found: PersistedLinked | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type !== "message" || e.message?.role !== "toolResult" || e.message.toolName !== "todo") continue;
		const details = e.message.details as { linked?: unknown } | undefined;
		const linked = parseLinked(details?.linked);
		if (linked && linked.binding.root === binding.root && linked.binding.change === binding.change) found = linked;
	}
	return found;
}
