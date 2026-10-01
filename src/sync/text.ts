/**
 * Text and panel data built from one snapshot.
 *
 * The tool's `list`/`get`, the `/todos` command and the panel all use these
 * functions on the same committed snapshot, so what the user and the agent see
 * cannot drift. Nothing here reads files or starts a process.
 */

import type { LinkedRow } from "../openspec/reconcile.js";
import type { Snapshot } from "../openspec/snapshot.js";
import type { TaskState } from "../state/state.js";
import { deriveBlocks } from "../state/task-graph.js";
import { sanitizeTerminalText } from "../tool/sanitize.js";
import type { PanelModel } from "../view/panel-model.js";
import type { Task, TaskStatus } from "../tool/types.js";

/** Incidental task ids are shifted by this much in panel data so they never collide with linked ids. */
export const INCIDENTAL_ID_OFFSET = 1_000_000;

export function linkedStatus(row: LinkedRow): TaskStatus {
	return row.done ? "completed" : (row.activity?.status ?? "pending");
}

/** A linked row as a task, with its session activity. Wording and completion come from the file. */
export function linkedToTask(row: LinkedRow): Task {
	const a = row.activity;
	const task: Task = { id: row.id, subject: row.description, status: linkedStatus(row) };
	if (a?.activeForm) task.activeForm = a.activeForm;
	if (a?.owner) task.owner = a.owner;
	if (a?.blockedBy?.length) task.blockedBy = [...a.blockedBy];
	if (a?.metadata) task.metadata = { ...a.metadata };
	if (a?.waitingReason) task.waitingReason = a.waitingReason;
	if (a?.failureReason) task.failureReason = a.failureReason;
	return task;
}

/** Linked tasks, then incidental ones with shifted ids. Deleted tasks are left out. */
export function projectPanelState(snapshot: Snapshot): TaskState {
	const linked = snapshot.linked.map(linkedToTask);
	const incidental = snapshot.ordinary
		.filter((t) => t.status !== "deleted")
		.map((t) => ({ ...t, id: t.id + INCIDENTAL_ID_OFFSET, blockedBy: t.blockedBy?.map((d) => d + INCIDENTAL_ID_OFFSET) }));
	const tasks = [...linked, ...incidental].map((t) => (t.blockedBy ? t : { ...t, blockedBy: undefined })) as Task[];
	for (const t of tasks) if (t.blockedBy === undefined) delete t.blockedBy;
	// The overlay resets its display memory when this number falls, as it does after a `clear`.
	const ordinaryNext = snapshot.ordinary.reduce((max, t) => Math.max(max, t.id + 1), 1);
	return { tasks, nextId: snapshot.linkedNextId + ordinaryNext };
}

function taskLine(task: Task, extra = ""): string {
	const form = task.status === "in_progress" && task.activeForm ? ` (${sanitizeTerminalText(task.activeForm)})` : "";
	const waiting = task.waitingReason ? ` (waiting: ${sanitizeTerminalText(task.waitingReason)})` : "";
	const failed = task.failureReason ? ` (failed: ${sanitizeTerminalText(task.failureReason)})` : "";
	const block = task.blockedBy?.length ? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `[${task.status}] #${task.id} ${sanitizeTerminalText(task.subject)}${form}${waiting}${failed}${block}${extra}`;
}

function linkedLine(row: LinkedRow): string {
	return taskLine(linkedToTask(row), row.mapping.ok ? "" : ` (read-only: ${sanitizeTerminalText(row.mapping.reason)})`);
}

function incidentalLine(task: Task): string {
	const reason = typeof task.metadata?.reason === "string" ? ` (incidental: ${sanitizeTerminalText(task.metadata.reason)})` : " (incidental)";
	return taskLine(task, reason);
}

export interface DescribeOptions {
	status?: TaskStatus;
	includeDeleted?: boolean;
	/** Add the CLI's notes and the revision hint. The tool's `list` sets this. */
	forTool?: boolean;
}

/** The whole view as lines. Identical input gives identical output for every reader. */
export function describeSnapshot(snapshot: Snapshot, options: DescribeOptions = {}): string[] {
	const keep = (t: Task) => (options.includeDeleted || t.status !== "deleted") && (!options.status || t.status === options.status);
	const lines: string[] = [];

	if (snapshot.mode !== "openspec") {
		lines.push("Normal mode: no OpenSpec file is read or written.");
	} else if (!snapshot.binding) {
		lines.push("OpenSpec sync: no change is chosen. Run /todo-settings to choose one. Linked tasks are unavailable.");
	} else {
		const rev = snapshot.revision ? ` · revision ${snapshot.revision}` : "";
		const pending = snapshot.refreshing ? " · refreshing, showing the last committed view" : "";
		lines.push(`OpenSpec sync: ${snapshot.binding.change} (${snapshot.binding.root}) · ${snapshot.freshness}${rev}${pending}`);
		if (snapshot.freshness === "stale" || snapshot.freshness === "unavailable") {
			lines.push(`⚠ The OpenSpec view is ${snapshot.freshness}, so linked changes are disabled. Run /todos refresh.`);
		}
		if (snapshot.planning) {
			lines.push(`Planning artefacts: ${snapshot.planning.isComplete ? "complete" : "incomplete"} (readiness only, not implementation progress).`);
		}
		if (snapshot.implementation) {
			const i = snapshot.implementation;
			lines.push(`OpenSpec tasks: ${i.complete}/${i.total} checked, ${i.remaining} remaining. A checked box records task progress; it does not show that tests passed or that the work was verified.`);
		}
		for (const d of snapshot.diagnostics) lines.push(`Note: ${sanitizeTerminalText(d)}`);
		if (options.forTool) for (const n of snapshot.notes) lines.push(`OpenSpec note: ${sanitizeTerminalText(n)}`);

		const linked = snapshot.linked.map(linkedToTask).filter(keep);
		const byId = new Map(snapshot.linked.map((r) => [r.id, r]));
		lines.push(linked.length ? "Linked tasks (from tasks.md):" : "Linked tasks: none.");
		for (const t of linked) lines.push(linkedLine(byId.get(t.id)!));
		if (options.forTool && snapshot.freshness === "fresh" && snapshot.writable && snapshot.revision) {
			lines.push(`To change a linked task's status, pass expectedRevision "${snapshot.revision}".`);
		}
	}

	const ordinary = snapshot.ordinary.filter(keep);
	if (snapshot.mode === "openspec") {
		lines.push(ordinary.length ? `Incidental tasks (scope "incidental"; not counted in OpenSpec progress):` : "Incidental tasks: none.");
		for (const t of ordinary) lines.push(incidentalLine(t));
	} else {
		for (const t of ordinary) lines.push(taskLine(t));
		if (ordinary.length === 0) lines.push("No tasks");
	}
	return lines;
}

/** Detail lines for one linked task. */
export function describeLinked(row: LinkedRow, snapshot: Snapshot): string[] {
	const task = linkedToTask(row);
	const blocks = deriveBlocks(snapshot.linked.map(linkedToTask)).get(row.id) ?? [];
	const lines = [`#${row.id} [${task.status}] ${sanitizeTerminalText(row.description)}`, `  source: tasks.md${row.label ? ` task ${row.label}` : ""} (revision ${snapshot.revision ?? "unknown"})`];
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	if (blocks.length) lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	if (task.waitingReason) lines.push(`  waiting: ${sanitizeTerminalText(task.waitingReason)}`);
	if (task.failureReason) lines.push(`  failed: ${sanitizeTerminalText(task.failureReason)}`);
	if (!row.mapping.ok) lines.push(`  read-only: ${sanitizeTerminalText(row.mapping.reason)}`);
	return lines;
}

/**
 * Everything the panel shows, from one snapshot. The heading numbers are OpenSpec's own, the same
 * ones `/todos` reports, with incidental progress kept apart. Without a CLI read they fall back to
 * the tracked rows.
 */
export function projectPanelModel(snapshot: Snapshot): PanelModel {
	const state = projectPanelState(snapshot);
	const linked = snapshot.linked;
	const i = snapshot.implementation;
	const incidental = snapshot.ordinary.filter((t) => t.status !== "deleted");
	return {
		state,
		sections: {
			openspec: { complete: i?.complete ?? linked.filter((r) => r.done).length, total: i?.total ?? linked.length, freshness: snapshot.freshness, refreshing: snapshot.refreshing },
			incidental: { complete: incidental.filter((t) => t.status === "completed").length, total: incidental.length },
		},
	};
}
