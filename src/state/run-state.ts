/**
 * Whether the agent is working, kept per session and apart from task status.
 *
 * A saved `in_progress` status says what the task is, not that anything is
 * executing it. A session that has just resumed is idle, never running. A run
 * that ended by abort or error leaves the session paused; any other end leaves
 * it idle. This state never changes a task and never marks anything complete.
 */

export type RunState = "running" | "idle" | "paused";

const states = new Map<string, RunState>();

export function getRunState(sessionId: string): RunState {
	return states.get(sessionId) ?? "idle";
}

export function setRunState(sessionId: string, state: RunState): void {
	states.set(sessionId, state);
}

export function evictRunState(sessionId: string): void {
	states.delete(sessionId);
}

export function __resetRunStates(): void {
	states.clear();
}

/** The state a session is left in when an agent run ends, from the last assistant message. */
export function runStateFromAgentEnd(messages: unknown): RunState {
	if (!Array.isArray(messages)) return "idle";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; stopReason?: unknown } | null;
		if (!message || typeof message !== "object" || message.role !== "assistant") continue;
		return message.stopReason === "aborted" || message.stopReason === "error" ? "paused" : "idle";
	}
	return "idle";
}
