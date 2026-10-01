/**
 * How a task looks, separate from what its saved status is.
 *
 * Order matters: a finished task is completed whatever else is set. An
 * unresolved dependency makes a task Blocked before activity is considered, so a
 * blocked task can never look like it is executing. Only an `in_progress` task
 * with no unresolved dependency can look like it is running, and only while the
 * agent is running. When the agent has stopped or finished its turn the task is
 * shown as Paused or Idle, with no running indicator.
 *
 * Labels never mark work complete and never infer an approval from text.
 */

import type { RunState } from "../state/run-state.js";
import type { Task } from "../tool/types.js";

export type PresentationKind = "completed" | "pending" | "running" | "paused" | "idle" | "blocked";

export interface Presentation {
	kind: PresentationKind;
	label: string;
	/** True only for a task that is executing right now. Drives the running indicator. */
	running: boolean;
	blockers?: number[];
}

/** Dependencies that exist and are not yet completed or deleted. */
export function unresolvedBlockers(task: Task, byId: ReadonlyMap<number, Task>): number[] {
	return (task.blockedBy ?? []).filter((id) => {
		const dep = byId.get(id);
		return dep !== undefined && dep.status !== "completed" && dep.status !== "deleted";
	});
}

export function presentTask(task: Task, byId: ReadonlyMap<number, Task>, run: RunState): Presentation {
	if (task.status === "completed") return { kind: "completed", label: "completed", running: false };
	if (task.status === "deleted") return { kind: "completed", label: "deleted", running: false };

	const blockers = unresolvedBlockers(task, byId);
	if (blockers.length > 0) return { kind: "blocked", label: `Blocked by ${blockers.map((id) => `#${id}`).join(", ")}`, running: false, blockers };

	if (task.status === "pending") return { kind: "pending", label: "pending", running: false };
	if (run === "running") return { kind: "running", label: "in progress", running: true };
	return run === "paused" ? { kind: "paused", label: "Paused", running: false } : { kind: "idle", label: "Idle", running: false };
}
