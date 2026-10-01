/**
 * Reminders about task status that the agent forgot to update.
 *
 * The settle reminder is a visible notice for the user, built from committed state, and is sent
 * from a notification-only event. The nudge is one message to the agent before a run settles,
 * and the status hint is one line on an update result. None of them marks a task complete or
 * touches a planning file.
 */

import { getState } from "./state/store.js";
import type { Task } from "./tool/types.js";
import type { Runtime } from "./sync/runtime.js";
import { getSessionMode } from "./session-mode.js";
import { sanitizeTerminalText } from "./tool/sanitize.js";

export interface Unresolved {
	label: string;
	subject: string;
	/** The task already says what it waits for or why it failed, so it is not forgotten. */
	explained: boolean;
}

const LISTED = 5;
const SUBJECT_LIMIT = 60;

/** Tasks the session still shows as in progress. A checked linked box is finished, whatever its saved activity. */
export function unresolvedInProgress(sessionId: string, runtime: Runtime | undefined): Unresolved[] {
	const ordinary = getState(sessionId).tasks.filter((t) => t.status === "in_progress");
	if (!runtime || getSessionMode(sessionId).mode !== "openspec")
		return ordinary.map((t) => ({ label: `#${t.id}`, subject: t.subject, explained: hasReason(t) }));
	const linked = runtime.provider
		.getSnapshot(sessionId)
		.linked.filter((r) => !r.done && r.activity?.status === "in_progress")
		.map((r) => ({
			label: `#${r.id}`,
			subject: r.description,
			explained: Boolean(r.activity?.waitingReason || r.activity?.failureReason),
		}));
	return [
		...linked,
		...ordinary.map((t) => ({ label: `incidental #${t.id}`, subject: t.subject, explained: hasReason(t) })),
	];
}

function hasReason(t: Task): boolean {
	return Boolean(t.waitingReason || t.failureReason);
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

/**
 * The one message sent to the agent before a run settles, or undefined when every task in progress
 * already says what it waits for. The agent is told what to do, not what it did wrong.
 */
export function buildNudge(items: readonly Unresolved[]): string | undefined {
	if (items.length === 0) return undefined;
	const shown = items.slice(0, LISTED).map((i) => `${i.label} ${clip(i.subject)}`);
	const more = items.length > LISTED ? ` and ${items.length - LISTED} more` : "";
	const noun = items.length === 1 ? "1 task is" : `${items.length} tasks are`;
	return `Todo check: ${noun} still marked in_progress: ${shown.join(", ")}${more}. Call todo update for each one now. Use status completed if the work is done, status pending if you have not started it, or set waitingReason or failureReason if it waits for someone or failed. Then carry on or finish.`;
}

/** Sessions already nudged since their last prompt. A continuation never starts a new prompt. */
const nudged = new Set<string>();

/** True the first time it is called for a session after `resetNudge`, so one prompt gets one nudge. */
export function claimNudge(sessionId: string): boolean {
	if (nudged.has(sessionId)) return false;
	nudged.add(sessionId);
	return true;
}

export function resetNudge(sessionId: string): void {
	nudged.delete(sessionId);
}

export function __resetNudges(): void {
	nudged.clear();
}

/**
 * One line for the end of an update result when work is waiting but nothing is marked in progress,
 * the usual sign that the agent started the next task without saying so.
 */
export function statusHint(tasks: readonly Task[]): string | undefined {
	const live = tasks.filter((t) => t.status !== "deleted");
	if (live.some((t) => t.status === "in_progress")) return undefined;
	if (!live.some((t) => t.status === "pending")) return undefined;
	return "Hint: no task is in_progress. Mark the next task in_progress with todo update before you start it.";
}
