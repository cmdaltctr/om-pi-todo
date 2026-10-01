/**
 * The `todo` tool in OpenSpec sync mode.
 *
 * Linked tasks come from tasks.md through the shared snapshot. `id` means a
 * linked task unless `scope: "incidental"` selects the session's own tasks.
 * Wording and mapping of linked tasks are read-only. A status change needs the
 * revision the caller last read. Completing a linked task goes through the
 * guarded writer and is reported as success only when the checkbox is persisted
 * and the CLI confirms the same task. Every other status is session activity and
 * never touches the file.
 */

import type { CompletionOutcome } from "../openspec/writer.js";
import type { LinkedRow } from "../openspec/reconcile.js";
import type { Snapshot } from "../openspec/snapshot.js";
import { fingerprint, labelOf } from "../openspec/tasks.js";
import { applyTaskMutation } from "../state/state-reducer.js";
import { commitState, getState } from "../state/store.js";
import { formatContent } from "../tool/response-envelope.js";
import type { TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "../tool/types.js";
import type { Runtime } from "./runtime.js";
import { describeLinked, describeSnapshot, linkedStatus, linkedToTask } from "./text.js";

export interface ToolReturn {
	content: Array<{ type: "text"; text: string }>;
	details: TaskDetails;
}

const ACTIVITY_FIELDS = [
	"activeForm",
	"owner",
	"addBlockedBy",
	"removeBlockedBy",
	"metadata",
	"waitingReason",
	"failureReason",
] as const;
const PROTECTED_MESSAGE =
	"Linked task wording is owned by tasks.md and cannot be changed here. Revise the OpenSpec plan (for example with /opsx-update), then refresh.";
const REFRESH_HINT = "Run list again and retry with the new revision.";

export async function executeSyncTodo(
	rt: Runtime,
	sessionId: string,
	action: TaskAction,
	params: TaskMutationParams,
	signal?: AbortSignal,
): Promise<ToolReturn> {
	const scope = params.scope === "incidental" ? "incidental" : "linked";

	const result = (text: string, error?: string): ToolReturn => {
		const ordinary = getState(sessionId);
		const linked = rt.provider.persistable(sessionId);
		const details: TaskDetails = {
			action,
			params: params as Record<string, unknown>,
			tasks: ordinary.tasks,
			nextId: ordinary.nextId,
			...(error ? { error } : {}),
			...(linked ? { linked } : {}),
		};
		return { content: [{ type: "text", text }], details };
	};
	const fail = (message: string) => result(`Error: ${message}`, message);

	/** Run a reducer action on the session's own tasks. */
	const incidental = (mutation: TaskMutationParams = params): ToolReturn => {
		const outcome = applyTaskMutation(getState(sessionId), action, mutation);
		commitState(sessionId, outcome.state);
		const text = formatContent(outcome.op, outcome.state);
		if (outcome.op.kind === "error") return fail(`(incidental) ${outcome.op.message}`);
		const tag = action === "list" || action === "get" ? "" : " [incidental]";
		return result(text + tag);
	};

	switch (action) {
		case "list": {
			const snap = await rt.refresh(sessionId, { signal });
			const lines = describeSnapshot(snap, {
				status: params.status,
				includeDeleted: params.includeDeleted === true,
				forTool: true,
			});
			return result(lines.join("\n"));
		}

		case "get": {
			if (scope === "incidental") return incidental();
			if (params.id === undefined) return fail("id required for get");
			const snap = await rt.refresh(sessionId, { signal });
			const row = snap.linked.find((r) => r.id === params.id);
			if (!row) return fail(notLinked(params.id, snap));
			return result(describeLinked(row, snap).join("\n"));
		}

		case "create": {
			if (scope !== "incidental") {
				return fail(
					'In OpenSpec sync mode, implementation work uses the imported tasks shown by list. Use the existing linked task id instead of creating a copy. To track a temporary step that is not part of the plan, pass scope "incidental" and a reason.',
				);
			}
			const reason = params.reason?.trim();
			if (!reason) return fail("An incidental task needs a reason. Pass reason: why this temporary step is needed.");
			// Best effort against the latest view; a stale view still guards against copies of rows it holds.
			const snap = await rt.refresh(sessionId, { signal });
			const copy = findImportedCopy(params, snap.linked);
			if (copy)
				return fail(
					`This looks like a copy of linked task #${copy.row.id} (${copy.why}). Use #${copy.row.id} for that work. Do not paraphrase plan tasks into incidental ones.`,
				);
			return incidental({ ...params, metadata: { ...params.metadata, reason } });
		}

		case "delete": {
			if (scope === "incidental") return incidental();
			return fail(`Linked tasks cannot be deleted here. ${PROTECTED_MESSAGE}`);
		}

		case "clear": {
			const cleared = applyTaskMutation(getState(sessionId), "clear", params);
			commitState(sessionId, cleared.state);
			const count = cleared.op.kind === "clear" ? cleared.op.count : 0;
			const linked = rt.provider.getSnapshot(sessionId).linked.length;
			return result(
				`Cleared ${count} incidental tasks. ${linked} linked OpenSpec tasks were kept and tasks.md is unchanged.`,
			);
		}

		case "update": {
			if (scope === "incidental") return incidental();
			return updateLinked(rt, sessionId, params, signal, { result, fail });
		}
	}
}

function notLinked(id: number, snap: Snapshot): string {
	const known = snap.linked.map((r) => `#${r.id}`).join(", ") || "none";
	return `#${id} is not a linked task (linked ids: ${known}). To address one of your own tasks, pass scope "incidental".`;
}

/** A proposed incidental task that repeats an imported task, by wording or by its label. */
function findImportedCopy(
	params: TaskMutationParams,
	linked: readonly LinkedRow[],
): { row: LinkedRow; why: string } | undefined {
	const subject = params.subject ?? "";
	const words = [subject, params.description ?? ""].filter((w) => w.trim() !== "");
	const label = labelOf(subject.trim());
	for (const row of linked) {
		for (const w of words) {
			if (fingerprint(w) === row.fingerprint) return { row, why: "same wording" };
		}
		if (row.label && fingerprint(`${row.label} ${subject}`) === row.fingerprint)
			return { row, why: `same wording as task ${row.label}` };
		if (row.label && label === row.label) return { row, why: `it refers to task ${row.label}` };
	}
	return undefined;
}

interface Helpers {
	result(text: string, error?: string): ToolReturn;
	fail(message: string): ToolReturn;
}

async function updateLinked(
	rt: Runtime,
	sessionId: string,
	params: TaskMutationParams,
	signal: AbortSignal | undefined,
	h: Helpers,
): Promise<ToolReturn> {
	if (params.id === undefined) return h.fail("id required for update");
	const gen = rt.capture(sessionId);
	const moved = () =>
		h.fail("The session's binding changed while this update was running. Nothing was applied. Retry.");

	const snap = await rt.refresh(sessionId, { signal });
	if (!gen.isCurrent()) return moved();

	const row = snap.linked.find((r) => r.id === params.id);
	if (!row) return h.fail(notLinked(params.id, snap));
	if (params.subject !== undefined || params.description !== undefined) return h.fail(PROTECTED_MESSAGE);
	if (params.status === "deleted") return h.fail(`Linked tasks cannot be deleted here. ${PROTECTED_MESSAGE}`);

	const hasActivity = ACTIVITY_FIELDS.some((k) => (params as Record<string, unknown>)[k] !== undefined);
	if (params.status === undefined && !hasActivity) {
		return h.fail(
			"update requires at least one mutable field: status, activeForm, owner, metadata, addBlockedBy, removeBlockedBy, waitingReason, or failureReason",
		);
	}
	if (snap.freshness !== "fresh" || !snap.writable) {
		return h.fail(
			`Linked tasks cannot be changed now: ${snap.diagnostics.join("; ") || `the view is ${snap.freshness}`}. Run /todos refresh, then retry.`,
		);
	}
	if (!row.mapping.ok) return h.fail(`Task #${row.id} cannot be changed: ${row.mapping.reason}`);

	if (params.status !== undefined) {
		if (!params.expectedRevision) {
			return h.fail(
				`expectedRevision is required to change a linked task's status. The current revision is "${snap.revision}".`,
			);
		}
		if (params.expectedRevision !== snap.revision) {
			return h.fail(
				`The task file changed since you last read it (your revision ${params.expectedRevision}, current ${snap.revision}). ${REFRESH_HINT}`,
			);
		}
	}

	if (params.status === "completed") {
		const outcome = await rt.writer.complete(sessionId, row.id, params.expectedRevision!, {
			signal,
			isCurrent: gen.isCurrent,
		});
		const reply = renderOutcome(outcome, row, h);
		if (outcome.kind === "completed" && hasActivity && gen.isCurrent())
			applyActivity(rt, sessionId, outcome.snapshot, row.id, params, undefined);
		return h.result(reply.text, reply.error);
	}

	if (row.done)
		return h.fail(`#${row.id} is already completed in tasks.md. Reopen it by editing the file, then refresh.`);

	const applied = applyActivity(
		rt,
		sessionId,
		snap,
		row.id,
		params,
		params.status === "pending" || params.status === "in_progress" ? params.status : undefined,
	);
	if (!applied.ok) return h.fail(applied.message);
	return h.result(`${applied.text} (revision ${snap.revision})`);
}

function applyActivity(
	rt: Runtime,
	sessionId: string,
	snap: Snapshot,
	id: number,
	params: TaskMutationParams,
	status: TaskStatus | undefined,
): { ok: true; text: string } | { ok: false; message: string } {
	const tasks = snap.linked.map(linkedToTask);
	const mutation: TaskMutationParams = { id };
	if (status) mutation.status = status;
	for (const key of ACTIVITY_FIELDS)
		if ((params as Record<string, unknown>)[key] !== undefined)
			(mutation as Record<string, unknown>)[key] = (params as Record<string, unknown>)[key];

	const outcome = applyTaskMutation({ tasks, nextId: snap.linkedNextId }, "update", mutation);
	if (outcome.op.kind === "error") return { ok: false, message: outcome.op.message };
	const updated = outcome.state.tasks.find((t) => t.id === id)!;
	const activity: NonNullable<LinkedRow["activity"]> = {};
	if (updated.status === "in_progress") activity.status = "in_progress";
	if (updated.activeForm) activity.activeForm = updated.activeForm;
	if (updated.owner) activity.owner = updated.owner;
	if (updated.blockedBy?.length) activity.blockedBy = updated.blockedBy;
	if (updated.metadata) activity.metadata = updated.metadata;
	if (updated.waitingReason) activity.waitingReason = updated.waitingReason;
	if (updated.failureReason) activity.failureReason = updated.failureReason;
	if (!snap.revision || !rt.provider.setActivity(sessionId, id, activity, snap.revision)) {
		return {
			ok: false,
			message: `The view changed while this update was running. Nothing was applied. ${REFRESH_HINT}`,
		};
	}
	return { ok: true, text: formatContent(outcome.op, outcome.state) };
}

function renderOutcome(outcome: CompletionOutcome, row: LinkedRow, _h: Helpers): { text: string; error?: string } {
	const warn = "warnings" in outcome && outcome.warnings?.length ? ` ${outcome.warnings.join(" ")}` : "";
	switch (outcome.kind) {
		case "completed": {
			if (!outcome.changed)
				return {
					text: `No change: #${row.id} is already completed in tasks.md (revision ${outcome.revision}).${warn}`,
				};
			const i = outcome.snapshot.implementation;
			const progress = i
				? ` OpenSpec tasks: ${i.complete}/${i.total} checked (recorded progress; it does not show that tests passed).`
				: "";
			return {
				text: `Updated #${row.id} (${linkedStatus(row)} → completed). The checkbox was written and the OpenSpec CLI confirmed this task as done. Revision ${outcome.revision}.${progress}${warn}`,
			};
		}
		case "rejected":
			return { text: `Error: ${outcome.message} ${outcome.action}`, error: outcome.message };
		case "unconfirmed":
			return { text: `Error: ${outcome.message} ${outcome.action}${warn}`, error: outcome.message };
		case "persisted-view-unavailable":
			return { text: `Error: ${outcome.message} ${outcome.action}${warn}`, error: outcome.message };
		case "cancelled":
			return { text: `Error: Cancelled. ${outcome.message}`, error: outcome.message };
	}
}
