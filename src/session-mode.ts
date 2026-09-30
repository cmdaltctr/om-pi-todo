/**
 * Per-session todo mode and OpenSpec binding.
 *
 * Each session owns its slot, keyed by session id. The slot is persisted as a
 * custom session entry and restored by replaying the active branch, so reload,
 * compaction and branch navigation bring back the mode the branch last chose.
 * The saved default mode only seeds sessions that hold no entry yet.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPreferences, type TodoMode } from "./preferences.js";

export const SESSION_ENTRY_TYPE = "pi-todo-session";

/** The OpenSpec change a session writes to, as confirmed by the user. */
export interface Binding {
	root: string;
	change: string;
}

export interface SessionMode {
	mode: TodoMode;
	binding?: Binding;
}

const slots = new Map<string, SessionMode>();

function copy(value: SessionMode): SessionMode {
	return value.binding ? { mode: value.mode, binding: { ...value.binding } } : { mode: value.mode };
}

function isBinding(value: unknown): value is Binding {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.root === "string" && v.root !== "" && typeof v.change === "string" && v.change !== "";
}

/** A persisted entry's data as a session mode, or undefined when malformed. */
function parseEntryData(data: unknown): SessionMode | undefined {
	if (!data || typeof data !== "object") return undefined;
	const v = data as Record<string, unknown>;
	if (v.mode === "normal") return { mode: "normal" };
	if (v.mode !== "openspec") return undefined;
	if (v.binding === undefined) return { mode: "openspec" };
	return isBinding(v.binding) ? { mode: "openspec", binding: { root: v.binding.root, change: v.binding.change } } : undefined;
}

/**
 * Walk the branch in order; the last valid entry wins. With no valid entry the
 * session starts in the saved default mode, unbound. Pure of module state.
 */
export function replaySessionMode(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): SessionMode {
	let found: SessionMode | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; customType?: string; data?: unknown };
		if (e.type !== "custom" || e.customType !== SESSION_ENTRY_TYPE) continue;
		found = parseEntryData(e.data) ?? found;
	}
	return found ?? { mode: getPreferences().mode };
}

/** A session's mode; the saved default until the session has started. */
export function getSessionMode(sessionId: string): SessionMode {
	const slot = slots.get(sessionId);
	return slot ? copy(slot) : { mode: getPreferences().mode };
}

export function setSessionMode(sessionId: string, value: SessionMode): void {
	slots.set(sessionId, copy(value));
}

export function evictSessionMode(sessionId: string): void {
	slots.delete(sessionId);
}

/** Change a session's mode and persist it on the branch. */
export function persistSessionMode(pi: Pick<ExtensionAPI, "appendEntry">, sessionId: string, value: SessionMode): void {
	setSessionMode(sessionId, value);
	pi.appendEntry(SESSION_ENTRY_TYPE, copy(value));
}

/** One-line label for menus and the panel heading. */
export function describeSessionMode(value: SessionMode): string {
	if (value.mode === "normal") return "Normal";
	if (!value.binding) return "OpenSpec sync: change selection required";
	return `OpenSpec sync: ${value.binding.change} (${value.binding.root})`;
}

/** Test reset. */
export function __resetSessionModes(): void {
	slots.clear();
}
