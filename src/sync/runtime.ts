/**
 * Sync-mode runtime for all sessions in this process.
 *
 * Owns the snapshot provider and the guarded writer, the per-session binding
 * generation, and the tracked-file watchers. Every asynchronous step captures the
 * generation when it starts and checks it again before it publishes or writes,
 * so work that belongs to an earlier binding, branch or session lifetime can
 * neither write a checkbox nor replace what the panel shows.
 *
 * Every launched promise is observed: failures go to `onError`, and `idle()`
 * lets callers and tests wait for all background work.
 */

import { createSnapshotProvider, type Snapshot } from "../openspec/snapshot.js";
import type { ExecOptions, ExecResult } from "../openspec/exec.js";
import { createCoalescer, type Coalescer, type TargetWatch, watchTarget } from "../openspec/watch.js";
import { createWriter, type WriterFs } from "../openspec/writer.js";
import type { LockOptions } from "../openspec/lock.js";
import { getSessionMode, type Binding } from "../session-mode.js";
import type { TaskState } from "../state/state.js";
import type { Task } from "../tool/types.js";
import { replayLinked } from "./persist.js";
import type { PanelModel } from "../view/panel-model.js";
import { projectPanelModel, projectPanelState } from "./text.js";

export interface RuntimeDeps {
	run?: (args: readonly string[], options: ExecOptions) => Promise<ExecResult>;
	readFile?: (path: string) => Promise<Buffer>;
	fs?: Partial<WriterFs>;
	lock?: Pick<LockOptions, "waitMs" | "pollMs">;
	/** Quiet period before a burst of file events becomes one refresh. */
	watchDelayMs?: number;
	watch?: typeof watchTarget;
	getOrdinary(sessionId: string): readonly Task[];
	/** Repaint the panel from committed state. May throw or reject; the runtime reports it. */
	onRepaint?: () => void | Promise<void>;
	/** `kind` is "repaint" for panel repaint failures, which the owner of the panel has already reported. */
	onError?: (message: string, kind?: "repaint") => void;
}

export interface Generation {
	isCurrent(): boolean;
}

interface Watched {
	file: string;
	binding: Binding;
	coalescer: Coalescer;
	target: TargetWatch;
}

const DEFAULT_WATCH_DELAY_MS = 200;

export function createRuntime(deps: RuntimeDeps) {
	const generations = new Map<string, number>();
	const watched = new Map<string, Watched>();
	const background = new Set<Promise<unknown>>();
	const report = (message: string, kind?: "repaint") => deps.onError?.(message, kind);
	const watch = deps.watch ?? watchTarget;

	const provider = createSnapshotProvider({ run: deps.run, readFile: deps.readFile }, { getMode: getSessionMode, getOrdinary: deps.getOrdinary });

	const generationOf = (sessionId: string) => generations.get(sessionId) ?? 0;
	const capture = (sessionId: string): Generation => {
		const at = generationOf(sessionId);
		return { isCurrent: () => generationOf(sessionId) === at };
	};

	/** Launch background work with its failure observed. */
	function track<T>(work: Promise<T>, what: string): void {
		const observed = work.then(
			() => undefined,
			(error) => report(`${what} failed: ${(error as Error).message}`),
		);
		background.add(observed);
		void observed.finally(() => background.delete(observed));
	}

	async function repaint(): Promise<void> {
		try {
			await deps.onRepaint?.();
		} catch (error) {
			report(`The todo panel could not be repainted: ${(error as Error).message}. Run /todos refresh.`, "repaint");
		}
	}

	function teardownWatch(sessionId: string): void {
		const w = watched.get(sessionId);
		if (!w) return;
		watched.delete(sessionId);
		w.coalescer.cancel();
		w.target.close();
	}

	/** Watch the tracked file of the current binding, replacing a watch that points elsewhere. */
	function ensureWatch(sessionId: string, snapshot: Snapshot): void {
		const mode = getSessionMode(sessionId);
		const binding = mode.mode === "openspec" ? mode.binding : undefined;
		if (!binding || !snapshot.file || snapshot.needsReselect || snapshot.freshness === "unbound" || snapshot.freshness === "inactive") return teardownWatch(sessionId);
		const existing = watched.get(sessionId);
		if (existing && existing.file === snapshot.file && existing.binding.root === binding.root && existing.binding.change === binding.change) return;
		teardownWatch(sessionId);
		const coalescer = createCoalescer(
			async () => {
				await refresh(sessionId);
			},
			{ delayMs: deps.watchDelayMs ?? DEFAULT_WATCH_DELAY_MS, onError: (error) => report(`Refreshing the OpenSpec view failed: ${(error as Error).message}`) },
		);
		const target = watch(snapshot.file, () => coalescer.trigger(), { onError: (error) => report(`Watching ${snapshot.file} failed: ${(error as Error).message}. Run /todos refresh to update.`) });
		watched.set(sessionId, { file: snapshot.file, binding: { ...binding }, coalescer, target });
	}

	/** Read the bound change, publish it if this caller is still current, then repaint. */
	async function refresh(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<Snapshot> {
		const gen = capture(sessionId);
		const snapshot = await provider.refresh(sessionId, { signal: options.signal, isCurrent: gen.isCurrent });
		if (gen.isCurrent()) {
			ensureWatch(sessionId, snapshot);
			await repaint();
		}
		return snapshot;
	}

	const writer = createWriter({
		provider,
		fs: deps.fs,
		lock: deps.lock,
		onCommitted: async () => {
			await deps.onRepaint?.();
		},
	});

	return {
		provider,
		writer,
		capture,
		refresh,

		/** A new binding generation: earlier work for this session may no longer publish or write. */
		bump(sessionId: string): void {
			generations.set(sessionId, generationOf(sessionId) + 1);
		},

		/**
		 * Begin (or restart) sync for a session after its mode was replayed. Seeds ids and
		 * activity from history, then refreshes in the background.
		 */
		start(sessionId: string, ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): void {
			generations.set(sessionId, generationOf(sessionId) + 1);
			teardownWatch(sessionId);
			provider.forget(sessionId);
			const mode = getSessionMode(sessionId);
			if (mode.mode !== "openspec" || !mode.binding) return;
			const saved = replayLinked(ctx, mode.binding);
			if (saved) provider.seed(sessionId, mode.binding, saved.rows, saved.nextId);
			track(refresh(sessionId), "Reading the OpenSpec change");
		},

		/** Stop everything for a session: obsolete its work, close its watcher, forget its view. */
		stop(sessionId: string): void {
			generations.set(sessionId, generationOf(sessionId) + 1);
			teardownWatch(sessionId);
			provider.forget(sessionId);
		},

		/** Stop everything for every session. */
		stopAll(): void {
			for (const id of [...new Set([...generations.keys(), ...watched.keys()])]) {
				generations.set(id, generationOf(id) + 1);
				teardownWatch(id);
				provider.forget(id);
			}
		},

		/** Sessions that currently hold a watcher. */
		watchedSessions(): string[] {
			return [...watched.keys()];
		},

		panelState(sessionId: string): TaskState {
			return projectPanelState(provider.getSnapshot(sessionId));
		},

		panelModel(sessionId: string): PanelModel {
			return projectPanelModel(provider.getSnapshot(sessionId));
		},

		/** Resolves when background work has finished, including coalesced refreshes. */
		async idle(): Promise<void> {
			for (let round = 0; round < 10; round++) {
				await Promise.all([...background]);
				await Promise.all([...watched.values()].map((w) => w.coalescer.idle()));
				if (background.size === 0) return;
			}
		},
	};
}

export type Runtime = ReturnType<typeof createRuntime>;
