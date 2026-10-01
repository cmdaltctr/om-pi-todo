/**
 * File-change plumbing for sync mode.
 *
 * `watchTarget` watches the folder that holds the tracked file, not the file
 * itself: the writer and most editors replace the file by rename, which ends a
 * watch on the old inode. Only events named for the file itself are reported, so
 * other files, the writer's staging files and its lock file are ignored.
 *
 * It also watches the folder's parent. When a change is archived, its whole
 * folder is renamed away. The folder watcher alone does not report that reliably
 * on a busy machine, but the parent reports its child being renamed or removed on
 * every platform. A failing parent watcher is reported and dropped; the folder
 * watcher keeps working.
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
	/** Replaces `fs.watch`. Tests use it to fire events by hand. */
	watchImpl?: typeof watch;
}

export function watchTarget(file: string, onChange: () => void, options: WatchOptions = {}): TargetWatch {
	const open = options.watchImpl ?? watch;
	const dir = dirname(file);
	const parent = dirname(dir);
	const name = basename(file);
	const dirName = basename(dir);
	let folderWatcher: FSWatcher | undefined;
	let parentWatcher: FSWatcher | undefined;
	let closed = false;

	const closeParent = () => {
		parentWatcher?.close();
		parentWatcher = undefined;
	};
	const close = () => {
		if (closed) return;
		closed = true;
		folderWatcher?.close();
		folderWatcher = undefined;
		closeParent();
	};

	try {
		folderWatcher = open(dir, { persistent: false }, (event, changed) => {
			if (closed) return;
			const text = changed === null || changed === undefined ? undefined : String(changed);
			if (text === undefined) return onChange(); // the platform did not say what changed
			if (text === name || (event === "rename" && text === dirName)) onChange();
		});
		folderWatcher.on("error", (error) => {
			options.onError?.(error);
			close();
		});
	} catch (error) {
		closed = true;
		options.onError?.(error);
		return { close };
	}

	// The root of a file system has no parent to watch.
	if (parent !== dir) {
		try {
			parentWatcher = open(parent, { persistent: false }, (event, changed) => {
				if (closed) return;
				const text = changed === null || changed === undefined ? undefined : String(changed);
				if (text === undefined) return onChange();
				if (event === "rename" && text === dirName) onChange(); // the change folder moved or was removed
			});
			parentWatcher.on("error", (error) => {
				options.onError?.(error);
				closeParent();
			});
		} catch (error) {
			options.onError?.(error);
		}
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
			return timer === undefined && !running
				? Promise.resolve()
				: new Promise<void>((resolve) => waiters.push(resolve));
		},
	};
}
