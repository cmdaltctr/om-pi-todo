/**
 * File-change plumbing for sync mode.
 *
 * `watchTarget` watches the directory that holds the tracked file, not the file
 * itself: the writer and most editors replace the file by rename, which ends a
 * watch on the old inode. Only events named for the file itself are reported, so
 * other files, the writer's staging files and its lock file are ignored. A move of the directory itself, as when a
 * change is archived, is reported too.
 *
 * `createCoalescer` turns a burst of events into one run after a quiet period.
 * A trigger that arrives while a run is in progress schedules exactly one more
 * run after it, so no change is lost and runs never overlap. `cancel` drops all
 * pending work and ignores later triggers.
 */

import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";

export interface TargetWatch {
	close(): void;
}

export interface WatchOptions {
	onError?: (error: unknown) => void;
}

export function watchTarget(file: string, onChange: () => void, options: WatchOptions = {}): TargetWatch {
	const dir = dirname(file);
	const name = basename(file);
	const dirName = basename(dir);
	let watcher: FSWatcher | undefined;
	let closed = false;

	const close = () => {
		if (closed) return;
		closed = true;
		watcher?.close();
		watcher = undefined;
	};

	try {
		watcher = watch(dir, { persistent: false }, (event, changed) => {
			if (closed) return;
			const text = changed === null || changed === undefined ? undefined : String(changed);
			if (text === undefined) return onChange(); // the platform did not say what changed
			if (text === name || (event === "rename" && text === dirName)) onChange();
		});
		watcher.on("error", (error) => {
			options.onError?.(error);
			close();
		});
	} catch (error) {
		closed = true;
		options.onError?.(error);
	}
	return { close };
}

export interface Coalescer {
	trigger(): void;
	cancel(): void;
	/** Resolves when nothing is pending and nothing is running. */
	idle(): Promise<void>;
}

export interface CoalescerOptions {
	delayMs: number;
	onError?: (error: unknown) => void;
}

export function createCoalescer(run: () => Promise<void> | void, options: CoalescerOptions): Coalescer {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> | undefined;
	let again = false;
	let cancelled = false;
	const waiters: Array<() => void> = [];

	const settleIdle = () => {
		if (timer === undefined && !running) for (const w of waiters.splice(0)) w();
	};

	const start = () => {
		timer = undefined;
		if (cancelled) return settleIdle();
		running = (async () => {
			try {
				await run();
			} catch (error) {
				options.onError?.(error);
			}
		})().finally(() => {
			running = undefined;
			if (again && !cancelled) {
				again = false;
				schedule();
			}
			settleIdle();
		});
	};

	const schedule = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(start, options.delayMs);
	};

	return {
		trigger() {
			if (cancelled) return;
			if (running) again = true;
			else schedule();
		},
		cancel() {
			cancelled = true;
			again = false;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			settleIdle();
		},
		idle() {
			return timer === undefined && !running ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));
		},
	};
}
