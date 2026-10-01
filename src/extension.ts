/**
 * pi-todo — Pi extension. Registers the `todo` tool, `/todos` slash
 * command, and the persistent TodoOverlay widget.
 *
 * Local derivative of `@juicesharp/rpiv-todo` 2.11.0 (MIT, see NOTICE.md).
 * The tool name "todo" and the widget key "rpiv-todos" stay unchanged so
 * existing session history replays correctly.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF } from "./config.js";
import type { ChangeDiscovery } from "./discovery.js";
import { createDiscovery } from "./openspec/discover.js";
import { refreshPreferences, resolveCollapseKey } from "./preferences.js";
import { registerTodoSettingsCommand } from "./settings.js";
import { buildSettleReminder, unresolvedInProgress } from "./reminder.js";
import { evictRunState, getRunState, runStateFromAgentEnd, setRunState } from "./state/run-state.js";
import { createRuntime, type RuntimeDeps } from "./sync/runtime.js";
import type { PanelModel } from "./view/panel-model.js";
import { evictSessionMode, getSessionMode, replaySessionMode, setSessionMode } from "./session-mode.js";
import { replayFromBranch } from "./state/replay.js";
import {
	clearActiveRenderSession,
	evictSession,
	getActiveRenderSession,
	getState,
	getRenderState,
	replaceState,
	setActiveRenderSession,
	sid,
} from "./state/store.js";
import { type PanelControl, registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";
import type { TodoOverlay } from "./todo-overlay.js";

/** Shown once on start when sync is the selected mode and no change is bound. */
export const SELECTION_REQUIRED_MESSAGE = "OpenSpec sync is selected but no change is chosen. Run /todo-settings to choose one.";

/** Delay the overlay graph pre-warm until Pi's startup work has settled. */
export const PREWARM_DELAY_MS = 2000;

type TodoOverlayModule = typeof import("./todo-overlay.js");
type TodoOverlayImporter = () => Promise<TodoOverlayModule>;

/**
 * Marker shared by the loader's poisoned-namespace error and the
 * `isStaleOverlayModuleError` predicate that lets handlers re-throw it while
 * swallowing transient load failures.
 */
const STALE_OVERLAY_MESSAGE = "Todo overlay module cache is stale; restart Pi";

/** True for the loader's latched poisoned-namespace error (see below). */
export function isStaleOverlayModuleError(e: unknown): boolean {
	return String(e).includes(STALE_OVERLAY_MESSAGE);
}

/**
 * Memoize the overlay graph after a successful load, but drop a rejected
 * promise so a failed pre-warm does not permanently replay the same rejection.
 * The export guard turns jiti's poisoned-namespace failure into a useful restart
 * error instead of a bare "TodoOverlay is not a constructor" TypeError.
 */
export function makeTodoOverlayLoader(
	importOverlay: TodoOverlayImporter = () => import("./todo-overlay.js"),
): TodoOverlayImporter {
	let memo: Promise<TodoOverlayModule> | undefined;

	return async (): Promise<TodoOverlayModule> => {
		memo ??= importOverlay();
		const current = memo;
		let mod: TodoOverlayModule;
		try {
			mod = await current;
		} catch (error) {
			// Clear only OUR rejected promise: a late catch from a concurrent
			// awaiter must never clobber a fresh retry another caller installed.
			if (memo === current) memo = undefined;
			throw error;
		}
		if (typeof mod.TodoOverlay !== "function") {
			// Deliberately latched: the memo keeps this resolved-but-poisoned
			// namespace, so every subsequent load re-throws instead of retrying.
			// Re-importing would hand back the same cached jiti namespace — a
			// retry can never heal this; only the restart the error asks for can.
			const keys = JSON.stringify(Object.keys(mod));
			throw new Error(`${STALE_OVERLAY_MESSAGE} (resolved namespace keys: ${keys})`);
		}
		return mod;
	};
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

/**
 * Render a caught `unknown` as a human-readable message.
 */
function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export default async function (
	pi: ExtensionAPI,
	importOverlay: TodoOverlayImporter = () => import("./todo-overlay.js"),
	discoverChanges: ChangeDiscovery = createDiscovery(),
	/** Overrides for the sync runtime. Tests inject a fake CLI and watcher here. */
	runtimeOverrides: Partial<RuntimeDeps> = {},
) {
	// Fill the preference cache once so later reads (render, tool guidance) do no file access.
	await refreshPreferences();
	let todoOverlay: TodoOverlay | undefined;
	const loadTodoOverlay = makeTodoOverlayLoader(importOverlay);
	let uiCtx: ExtensionUIContext | undefined;
	let lifecycleGeneration = 0;

	/** The last panel repaint failure not yet recovered from, and the one already shown to the user. */
	let lastPanelFailure: string | undefined;
	let notifiedFailure: string | undefined;

	/** Tell the user, in Pi's notification channel, or fall back to the console when there is no UI. */
	const tell = (message: string, level: "warning" | "error") => {
		if (uiCtx) uiCtx.notify(message, level);
		else console.warn(`[pi-todo] ${message}`);
	};

	const runtime = createRuntime({
		getOrdinary: (id) => getState(id).tasks,
		onRepaint: () => repaintForeground(),
		// Panel failures were already shown by repaintForeground; everything else is shown here.
		onError: (message, kind) => (kind === "repaint" ? console.warn(`[pi-todo] ${message}`) : tell(message, "warning")),
		...runtimeOverrides,
	});

	/** What the panel shows: the shared OpenSpec snapshot in sync mode, the session list otherwise. */
	const panelSource = (): PanelModel => {
		const id = getActiveRenderSession();
		return getSessionMode(id).mode === "openspec" ? runtime.panelModel(id) : { state: getRenderState() };
	};

	async function updateTodoOverlay(
		resetCompletedDisplayState = false,
		generation = lifecycleGeneration,
	): Promise<void> {
		const hasVisibleTasks = panelSource().state.tasks.some((task) => task.status !== "deleted");
		if (!uiCtx || (!todoOverlay && !hasVisibleTasks)) return;

		const { TodoOverlay } = await loadTodoOverlay();
		if (generation !== lifecycleGeneration || !uiCtx) return;

		todoOverlay ??= new TodoOverlay(panelSource);
		todoOverlay.setUICtx(uiCtx);
		if (resetCompletedDisplayState) todoOverlay.resetCompletedDisplayState();
		todoOverlay.update();
	}

	/**
	 * Repaint the foreground panel. A failure is recorded, shown to the user once until a repaint works
	 * again, and rethrown so the caller can add it to its own result. Task data is never touched.
	 */
	async function repaintForeground(resetCompletedDisplayState = false, generation = lifecycleGeneration): Promise<void> {
		try {
			await updateTodoOverlay(resetCompletedDisplayState, generation);
			lastPanelFailure = undefined;
			notifiedFailure = undefined;
		} catch (error) {
			if (isStaleOverlayModuleError(error)) throw error;
			const message = formatError(error);
			lastPanelFailure = message;
			if (notifiedFailure !== message) {
				notifiedFailure = message;
				tell(`The todo panel could not be repainted: ${message}. Your tasks are safe. Run /todos refresh to retry.`, "error");
			}
			throw error;
		}
	}

	/** For event handlers: a repaint problem has already been reported, so it must not break the host. */
	const repaintQuietly = (resetCompletedDisplayState = false, generation = lifecycleGeneration): Promise<void> =>
		repaintForeground(resetCompletedDisplayState, generation).catch((error) => {
			if (isStaleOverlayModuleError(error)) throw error;
		});

	const panelControl: PanelControl = {
		lastFailure: () => lastPanelFailure,
		async rebuild(ctx) {
			if (sid(ctx) !== getActiveRenderSession()) return "background";
			try {
				const { TodoOverlay } = await loadTodoOverlay();
				uiCtx = ctx.ui;
				todoOverlay ??= new TodoOverlay(panelSource);
				todoOverlay.reregister(ctx.ui);
				lastPanelFailure = undefined;
				notifiedFailure = undefined;
				return "rebuilt";
			} catch (error) {
				lastPanelFailure = formatError(error);
				throw error;
			}
		},
	};

	registerTodoTool(pi, runtime, {
		// Background sessions never repaint the foreground panel.
		onCommitted: (sessionId) => (sessionId === getActiveRenderSession() ? repaintForeground() : undefined),
	});
	registerTodosCommand(pi, runtime, panelControl);
	registerTodoSettingsCommand(pi, discoverChanges, {
		onModeChanged: async (ctx) => {
			runtime.start(sid(ctx), ctx);
			await repaintQuietly(true);
		},
	});

	// Collapse/expand hotkey for the todo overlay. The key is resolved once at
	// factory scope from config (register-once contract: a config change needs
	// `/reload` to re-bind, same as lane-switcher's env hotkey) and the binding is
	// skipped entirely when collapseKey is "off". The handler closes over the
	// closure-local `todoOverlay` by reference and re-reads it at fire time, so an
	// overlay loaded after shortcut registration is picked up. No-op in headless
	// mode, before the overlay has loaded, or when the widget isn't currently
	// registered (auto-hidden on an empty list).
	const collapseKey = resolveCollapseKey();
	if (collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(collapseKey as KeyId, {
			description: "Collapse or expand the todo overlay",
			handler: (ctx) => {
				if (!ctx.hasUI || !todoOverlay?.isRegistered()) return;
				todoOverlay.toggleCollapse();
			},
		});
	}

	// Re-key a session's slot from its branch, then refresh the overlay only when
	// the refreshed session IS the foreground. Shared by session_compact and
	// session_tree (verbatim-identical pre-extraction). A stale ctx (auto-compaction
	// races session disposal: pi-core invalidates the runner while still emitting the
	// event, so `ctx` may be a dead proxy whose getters throw) keeps current state —
	// the replacement session's session_start replays it. Other errors are real replay
	// bugs and must propagate. The render is sid-gated so a child never refreshes the
	// foreground overlay.
	const replayAndRefresh = async (
		ctx: Parameters<typeof sid>[0] & Parameters<typeof replayFromBranch>[0],
	): Promise<void> => {
		let isForeground = false;
		try {
			const id = sid(ctx);
			replaceState(id, replayFromBranch(ctx));
			setSessionMode(id, replaySessionMode(ctx));
			runtime.start(id, ctx);
			isForeground = id === getActiveRenderSession();
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		if (isForeground) await repaintQuietly(true);
	};

	pi.on("session_start", async (_event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
			// Every session replays into its OWN data slot (Phase 1 isolation).
			replaceState(id, replayFromBranch(ctx));
			setSessionMode(id, replaySessionMode(ctx));
			runtime.start(id, ctx);
		} catch (e) {
			// Parity with compact/tree/shutdown: session_start is the fresh-ctx event
			// so the stale risk is low, but a stale/throwing ctx has nothing to bind —
			// swallow the known stale error and bail; let real replay bugs propagate.
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		if (!ctx.hasUI) return;
		const started = getSessionMode(id);
		if (started.mode === "openspec" && !started.binding) ctx.ui.notify(SELECTION_REQUIRED_MESSAGE, "warning");
		// First UI-bearing session_start claims the foreground (the interactive
		// launcher, by spawn-ordering) without eagerly loading the overlay.
		if (getActiveRenderSession() === "") setActiveRenderSession(id);
		// Only the foreground re-binds/refreshes the shared overlay. A child
		// (distinct sid) is skipped — does not rebind to a relay/stale ui.
		if (id !== getActiveRenderSession()) return;
		const generation = ++lifecycleGeneration;
		uiCtx = ctx.ui;
		await repaintQuietly(true, generation);
	});

	pi.on("session_compact", async (_event, ctx) => {
		await replayAndRefresh(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await replayAndRefresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Best-effort sid: disposal can race a stale ctx (like compact). An
		// unknown/stale sid resolves to "" and is treated as foreground — the
		// safe pre-isolation default that disposes as before.
		let s: string;
		try {
			s = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			s = "";
		}
		// The shutting-down session's own data slot is always evicted.
		evictSession(s);
		evictSessionMode(s);
		evictRunState(s);
		runtime.stop(s);
		// Overlay teardown is sid-gated: a child shutdown (distinct sid) must not
		// dispose the foreground's overlay. Only the foreground's own shutdown
		// (or an unknown/stale sid) tears it down and clears the pointer.
		if (s === "" || s === getActiveRenderSession()) {
			// Invalidate pending imports before clearing the foreground binding so a
			// replaced session cannot inherit the stale overlay or UI context.
			lifecycleGeneration++;
			uiCtx = undefined;
			// `dispose()`'s first act is setWidget(KEY, undefined) on a possibly-stale
			// ui proxy, which can throw. evictSession(s) above already deleted this
			// slot, so leaving `activeRenderSession` pointing at it would resolve
			// getRenderState() to a fresh EMPTY_STATE (overlay silently renders empty).
			// try/finally guarantees the pointer-clear + overlay-drop run regardless.
			try {
				todoOverlay?.dispose();
			} finally {
				todoOverlay = undefined;
				clearActiveRenderSession();
			}
		}
	});

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		// The tool itself succeeded, and the tool already scheduled this repaint; this is the safety net.
		// A repaint problem was shown to the user by repaintForeground. The latched stale-namespace
		// error still propagates: it never self-heals, and the user needs its restart guidance.
		await repaintQuietly();
	});

	// Evaluate the lazy graph after startup while Pi's boot-time dependency paths
	// are still stable. This loads no widget and constructs no overlay; those stay
	// deferred until a foreground session has visible tasks. A rejected pre-warm
	// is intentionally swallowed after loadTodoOverlay clears its memo, allowing
	// the first real update to retry. unref avoids holding an embedder open.
	const prewarmTimer = setTimeout(() => void loadTodoOverlay().catch(() => undefined), PREWARM_DELAY_MS);
	prewarmTimer.unref?.();

	/** The session id, or undefined when the host's context has already been replaced. */
	const sessionOf = (ctx: Parameters<typeof sid>[0]): string | undefined => {
		try {
			return sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return undefined;
		}
	};

	/** Record the run state and, for the foreground session, redraw rows that depend on it. */
	const runStateChanged = async (id: string): Promise<void> => {
		if (id === getActiveRenderSession()) await repaintQuietly();
	};

	pi.on("agent_start", async (_event, ctx) => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
		const id = sessionOf(ctx);
		if (id === undefined) return;
		setRunState(id, "running");
		await runStateChanged(id);
	});

	// A run that ended by abort or error leaves its in-progress rows Paused; any other end leaves them Idle.
	pi.on("agent_end", async (event, ctx) => {
		const id = sessionOf(ctx);
		if (id === undefined) return;
		setRunState(id, runStateFromAgentEnd(event.messages));
		await runStateChanged(id);
	});

	// Final and notification-only: nothing returned here can continue the agent. Show one reminder when
	// work is still in progress. It never changes a task or a planning file.
	pi.on("agent_settled", async (_event, ctx) => {
		const id = sessionOf(ctx);
		if (id === undefined) return;
		if (getRunState(id) === "running") setRunState(id, "idle");
		if (ctx.hasUI) {
			const reminder = buildSettleReminder(unresolvedInProgress(id, runtime));
			if (reminder) ctx.ui.notify(reminder, "warning");
		}
		await runStateChanged(id);
	});
}
