/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface and keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the package-root import surface so that
 * `index.ts`, `todo-overlay.ts`, and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPreferences } from "./preferences.js";
import { getSessionMode } from "./session-mode.js";
import { formatStatusLabel, t } from "./state/labels.js";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import type { TaskState } from "./state/state.js";
import { commitState, getActiveRenderSession, getRenderState, getState, sid } from "./state/store.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.js";
import type { Runtime } from "./sync/runtime.js";
import type { ToolReturn } from "./sync/tool.js";
import { executeSyncTodo } from "./sync/tool.js";
import { describeSnapshot, linkedToTask } from "./sync/text.js";
import { formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./view/format.js";

// English fallbacks for localized /todos section headers — the box-drawing
// decoration is part of the localized string so translators can adjust spacing.
const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";

// ---------------------------------------------------------------------------
// Public re-exports — existing consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export { __resetState, getNextId, getTodos, setActiveRenderSession, sid } from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
	"Update a task the moment its state changes. Set waitingReason as soon as you wait for someone, such as an approval or a review, and failureReason as soon as work failed or hit an error. Clear each with an empty string once it is resolved. Never leave a task in_progress without saying what it waits for.",
	"In OpenSpec sync mode, list shows the tasks imported from tasks.md. Do the plan's work under those ids, and never paraphrase a plan task into a new one. To change a linked task's status pass expectedRevision, the revision shown by the latest list, get or result. Complete a linked task the moment its acceptance criteria are met; completing a linked task checks its box in tasks.md.",
	'In OpenSpec sync mode, use scope "incidental" with a reason only for a temporary step outside the plan. Incidental tasks never count as OpenSpec progress. Linked wording cannot be changed or deleted here; revise the OpenSpec plan instead.',
	"A checked box records progress; it is not proof that tests passed or that the work was verified. Report what you ran and what it showed, and do not claim more than that.",
];

/**
 * The list a call label looks ids up in. A linked id in a sync session names a task
 * from tasks.md; everything else names one of the session's own tasks.
 */
function callLookupState(runtime: Runtime | undefined, scope: string | undefined): TaskState {
	const id = getActiveRenderSession();
	if (runtime && scope !== "incidental" && getSessionMode(id).mode === "openspec") {
		const snapshot = runtime.provider.getSnapshot(id);
		return { tasks: snapshot.linked.map(linkedToTask), nextId: snapshot.linkedNextId };
	}
	return getRenderState();
}

/** Called after a task update has been committed, so the panel can repaint before the tool returns. */
export interface ToolHooks {
	onCommitted?(sessionId: string): void | Promise<void>;
}

const MUTATIONS: ReadonlySet<string> = new Set(["create", "update", "delete", "clear"]);

/** Run the commit hook. A failure is a warning for the caller to append: the update itself stands. */
async function afterCommit(hooks: ToolHooks | undefined, sessionId: string): Promise<string | undefined> {
	try {
		await hooks?.onCommitted?.(sessionId);
		return undefined;
	} catch (error) {
		return `The todo panel could not be repainted: ${error instanceof Error ? error.message : String(error)}. Run /todos refresh.`;
	}
}

function withWarning(result: ToolReturn, warning: string | undefined): ToolReturn {
	if (!warning) return result;
	return { ...result, content: [{ type: "text", text: `${result.content[0].text} ${warning}` }] };
}

/** Register the `todo` tool. Without a runtime the tool only ever runs in normal mode. */
export function registerTodoTool(pi: ExtensionAPI, runtime?: Runtime, hooks?: ToolHooks): void {
	const guidance = getPreferences().guidance ?? {};
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation. In OpenSpec sync mode the list holds tasks imported from tasks.md; pass scope \"incidental\" to address your own temporary tasks instead.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (runtime && getSessionMode(sid(ctx)).mode === "openspec") {
				const reply = await executeSyncTodo(runtime, sid(ctx), params.action, params as TaskMutationParams, signal);
				// A linked completion repaints inside the writer, which reports its own repaint problems.
				const writerRepaints = params.action === "update" && params.status === "completed" && params.scope !== "incidental";
				if (!MUTATIONS.has(params.action) || reply.details.error || writerRepaints) return reply;
				return withWarning(reply, await afterCommit(hooks, sid(ctx)));
			}
			const result = applyTaskMutation(getState(sid(ctx)), params.action, params as TaskMutationParams);
			commitState(sid(ctx), result.state);
			const built = buildToolResult(params.action, params as TaskMutationParams, result.state, result.op);
			if (!MUTATIONS.has(params.action) || result.op.kind === "error") return built;
			return withWarning(built, await afterCommit(hooks, sid(ctx)));
		},

		// renderCall reflects the FOREGROUND slot, not the calling session's. Pi's
		// `ToolRenderContext` carries no session identity (no sessionManager/sessionId),
		// so this ctx-less hook cannot re-key by caller. For the foreground session's
		// own transcript that is exactly right. A detached/child call rendered in the
		// lane-transcript viewer whose task lives only in the child's slot misses the
		// foreground lookup and falls back to `#<id>` (see renderTodoCall). That is the
		// safe outcome: per-session ids restart at 1, so searching sibling slots could
		// surface the WRONG subject — the `#<id>` fallback is intentional, not a gap.
		renderCall(args, theme, _context) {
			return renderTodoCall(args as never, theme, callLookupState(runtime, args.scope));
		},

		renderResult(result, _opts, theme, _context) {
			return renderTodoResult(result, theme);
		},
	});
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

/** What `/todos refresh` needs from the extension to recover the panel. */
export interface PanelControl {
	/** The message of the last repaint failure that has not been recovered from. */
	lastFailure(): string | undefined;
	/** Register the panel again on this session's live UI and draw committed state. Throws on failure. */
	rebuild(ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]): Promise<"rebuilt" | "background">;
}

/** `/todos refresh`: read-only. Re-reads OpenSpec when synced, then redraws what is committed. Never writes. */
async function refreshPanel(ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1], runtime: Runtime | undefined, panel: PanelControl | undefined): Promise<void> {
	const earlier = panel?.lastFailure();
	if (panel) {
		try {
			if ((await panel.rebuild(ctx)) === "background") {
				ctx.ui.notify("This session is not showing the todo panel, so nothing was redrawn.", "info");
				return;
			}
		} catch (error) {
			ctx.ui.notify(`Todo panel refresh failed: ${error instanceof Error ? error.message : String(error)}. Your tasks are unchanged. Run /todos refresh to retry.`, "error");
			return;
		}
	}
	// The data read comes after the redraw, so what is drawn last is the freshest committed view.
	if (runtime && getSessionMode(sid(ctx)).mode === "openspec") await runtime.refresh(sid(ctx));
	ctx.ui.notify(earlier ? `Todo panel recovered. The earlier problem was: ${earlier}` : "Todo panel refreshed.", "info");
}

export function registerTodosCommand(pi: ExtensionAPI, runtime?: Runtime, panel?: PanelControl): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos on the current branch, grouped by status. `/todos refresh` redraws the panel.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
				return;
			}
			if (String(args ?? "").trim() === "refresh") return refreshPanel(ctx, runtime, panel);
			if (runtime && getSessionMode(sid(ctx)).mode === "openspec") {
				const snapshot = await runtime.refresh(sid(ctx));
				ctx.ui.notify(describeSnapshot(snapshot).join("\n"), "info");
				return;
			}
			const state = getState(sid(ctx));
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
				return;
			}
			const groups = selectTasksByStatus(state);
			const counts = selectTodoCounts(state);

			const header: string[] = [];
			if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
			if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

			const lines: string[] = [header.join(" · ")];
			if (groups.pending.length > 0) {
				lines.push(t("command.section.pending", SECTION_PENDING));
				for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
			}
			if (groups.inProgress.length > 0) {
				lines.push(t("command.section.in_progress", SECTION_IN_PROGRESS));
				for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
			}
			if (groups.completed.length > 0) {
				lines.push(t("command.section.completed", SECTION_COMPLETED));
				for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
