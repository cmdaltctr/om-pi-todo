/**
 * todo-overlay.ts — Persistent widget showing the todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form registration
 * in widgetContainerAbove, register-once + requestRender() refresh, configurable
 * collapse-not-scroll (default 12 content rows via getMaxWidgetLines(), plus a
 * trailing spacer row), Pi tool-output expansion awareness, and auto-hide when
 * the list is empty.
 *
 * Counts are taken over every non-deleted task before any row is hidden, so
 * hiding a completed row never lowers the completed total. Hidden completed rows
 * are reported, and a list whose tasks are all completed keeps a compact summary
 * until the list is cleared or replaced. Each row separates a task's status from
 * what is happening to it (see view/presentation.ts).
 *
 * Reads committed state through `source()` at render time. It never reads branch
 * history, files or processes while rendering.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF } from "./config.js";
import { getMaxWidgetLines, resolveCollapseKey } from "./preferences.js";
import { t } from "./state/labels.js";
import { getRunState, type RunState } from "./state/run-state.js";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors.js";
import { getActiveRenderSession, getRenderState } from "./state/store.js";
import type { Task } from "./tool/types.js";
import { formatOverlayTaskLine } from "./view/format.js";
import type { PanelModel, PanelSections } from "./view/panel-model.js";
import { presentTask } from "./view/presentation.js";

const WIDGET_KEY = "rpiv-todos";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

interface Snapshot {
	tasks: Task[];
	nextId: number;
	sections?: PanelSections;
}

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	private collapsed = false;

	/**
	 * `source` supplies what to show; the default is the foreground session's ordinary list.
	 * `runState` says whether the agent is working; the default reads the foreground session.
	 */
	constructor(
		private readonly source: () => PanelModel = () => ({ state: getRenderState() }),
		private readonly runState: () => RunState = () => getRunState(getActiveRenderSession()),
	) {}

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();

		// An all-completed list keeps its summary after its rows are hidden; only an empty list removes the panel.
		if (snapshot.tasks.every((task) => task.status === "deleted")) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	/**
	 * Register the panel again on `ctx`, as after a failed repaint or a reload. Throws when the host
	 * cannot register it, leaving the panel unregistered so the next update retries.
	 */
	reregister(ctx: ExtensionUIContext): void {
		this.uiCtx = ctx;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.update();
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh paths in update()/hideCompletedTasksFromPreviousTurn().
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private getSnapshot(): Snapshot {
		const model = this.source();
		const state = model.state;
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completedTaskIds = new Set(state.tasks.filter((task) => task.status === "completed").map((task) => task.id));
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: [...state.tasks], nextId: state.nextId, sections: model.sections };
	}

	private isHiddenCompleted(task: Task): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	/** Heading text with its counts, taken before any row is hidden. */
	private headingText(all: { tasks: Task[]; nextId: number }, sections: PanelSections | undefined): string {
		const base = t("overlay.heading", OVERLAY_HEADING);
		if (!sections) {
			const counts = selectTodoCounts(all);
			return `${base} (${counts.completed}/${counts.total})`;
		}
		const { openspec, incidental } = sections;
		const flag = openspec.freshness === "stale" || openspec.freshness === "unavailable" ? ` ⚠ ${openspec.freshness}` : "";
		let text = `${base} · OpenSpec ${openspec.complete}/${openspec.total}${flag}${openspec.refreshing ? " ↻" : ""}`;
		if (incidental.total > 0) text += ` · incidental ${incidental.complete}/${incidental.total}`;
		return text;
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const all = snapshot.tasks.filter((task) => task.status !== "deleted");
		if (all.length === 0) return [];

		// Everything below the heading works on the rows left after hiding; the heading and totals do not.
		const hiddenByTurn = all.filter((task) => this.isHiddenCompleted(task)).length;
		const overlayTasks = all.filter((task) => !this.isHiddenCompleted(task));
		const allState = { tasks: all, nextId: snapshot.nextId };

		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const hasActive = selectHasActive(allState);
		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, this.headingText(allState, snapshot.sections))}`);

		// Collapsed view: just the heading + a dim "└─" expand hint, then the trailing spacer. Short-circuit
		// before the budget math and the completed-display tracking — nothing is shown to track, and skipping
		// the tracking when nothing is rendered is correctness, not optimisation. The hint splices the
		// resolved key into the {key} placeholder; the "off" sentinel renders a static label instead.
		if (this.collapsed) {
			const key = resolveCollapseKey();
			const hint =
				key === COLLAPSE_KEY_OFF
					? t("overlay.collapsed", OVERLAY_COLLAPSED)
					: t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
			return this.withTrailingSpacer([heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`)]);
		}

		// Every row is hidden because every task is completed: keep a compact summary.
		if (overlayTasks.length === 0) {
			const noun = hiddenByTurn === 1 ? "row" : "rows";
			return this.withTrailingSpacer([heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `all completed (${hiddenByTurn} ${noun} hidden)`)}`)]);
		}

		const lines: string[] = [heading];
		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
		const showIds = selectShowTaskIds(allState);
		const byId = new Map(all.map((task) => [task.id, task]));
		const run = this.runState();
		// Pi's global tool-output expansion mode is read on every render so its expand/collapse shortcut also
		// expands this live widget. Optional chaining preserves compatibility with hosts predating it.
		const bodyBudget = this.uiCtx?.getToolsExpanded?.() === true ? overlayTasks.length : getMaxWidgetLines() - 1;
		const layout = selectOverlayLayout(overlayState, bodyBudget);
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds, presentTask(task, byId, run))}`));
		}

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter((task) => task.status === "completed" && !this.completedTaskIdsPendingHide.has(task.id) && !this.hiddenCompletedTaskIds.has(task.id))
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		const hiddenCompleted = layout.hiddenCompleted + hiddenByTurn;
		if (hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return this.withTrailingSpacer(lines);
		}

		const totalHidden = hiddenCompleted + layout.truncatedTail;
		const parts: string[] = [];
		if (hiddenCompleted > 0) parts.push(`${hiddenCompleted} completed hidden`);
		if (layout.truncatedTail > 0) parts.push(`${layout.truncatedTail} pending`);
		const more = t("overlay.more", OVERLAY_MORE);
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${totalHidden} ${more} (${parts.join(", ")})`)}`));
		return this.withTrailingSpacer(lines);
	}

	/**
	 * Append a trailing blank line so the overlay isn't flush against the editor box. Pi's host adds a
	 * leading spacer above the widget but none below.
	 */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.collapsed = false;
		this.resetCompletedDisplayState();
	}
}
