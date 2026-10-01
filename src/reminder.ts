/**
 * The reminder shown once when the agent settles with work still in progress.
 *
 * It is a visible notice for the user, built from committed state. It never marks a task
 * complete, never touches a planning file, and never asks the agent to continue: it is
 * sent from a notification-only event.
 */

import { getState } from "./state/store.js";
import type { Runtime } from "./sync/runtime.js";
import { getSessionMode } from "./session-mode.js";
import { sanitizeTerminalText } from "./tool/sanitize.js";

export interface Unresolved {
	label: string;
	subject: string;
}

const LISTED = 5;
const SUBJECT_LIMIT = 60;

/** Tasks the session still shows as in progress. A checked linked box is finished, whatever its saved activity. */
export function unresolvedInProgress(sessionId: string, runtime: Runtime | undefined): Unresolved[] {
	const ordinary = getState(sessionId).tasks.filter((t) => t.status === "in_progress");
	if (!runtime || getSessionMode(sessionId).mode !== "openspec") return ordinary.map((t) => ({ label: `#${t.id}`, subject: t.subject }));
	const linked = runtime.provider
		.getSnapshot(sessionId)
		.linked.filter((r) => !r.done && r.activity?.status === "in_progress")
		.map((r) => ({ label: `#${r.id}`, subject: r.description }));
	return [...linked, ...ordinary.map((t) => ({ label: `incidental #${t.id}`, subject: t.subject }))];
}

function clip(subject: string): string {
	const clean = sanitizeTerminalText(subject);
	return clean.length > SUBJECT_LIMIT ? `${clean.slice(0, SUBJECT_LIMIT - 1)}…` : clean;
}

/** One message for all unresolved tasks, or undefined when there are none. */
export function buildSettleReminder(items: readonly Unresolved[]): string | undefined {
	if (items.length === 0) return undefined;
	const shown = items.slice(0, LISTED).map((i) => `${i.label} ${clip(i.subject)}`);
	const more = items.length > LISTED ? ` and ${items.length - LISTED} more` : "";
	const noun = items.length === 1 ? "1 task is" : `${items.length} tasks are`;
	return `Reminder: ${noun} still in progress: ${shown.join(", ")}${more}. Update each one: mark it completed or pending, or record what it is waiting for with waitingReason or failureReason.`;
}
