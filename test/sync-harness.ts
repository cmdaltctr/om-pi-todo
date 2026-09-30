import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { createRuntime, type RuntimeDeps } from "../src/sync/runtime.js";
import { setSessionMode } from "../src/session-mode.js";
import { getState } from "../src/state/store.js";
import { registerTodosCommand, registerTodoTool } from "../src/todo.js";
import { makeFakeCli } from "./fake-cli.js";
import { callTool, createCtx, createHost } from "./helpers.js";

export const md = (...lines: string[]) => `${lines.join("\n")}\n`;

/** One disposable OpenSpec root per test, with a runtime wired to a CLI-shaped fake. */
export function useSyncRoot() {
	const state = { root: "", changeRoot: "", tasksPath: "" };
	beforeEach(() => {
		state.root = mkdtempSync(join(tmpdir(), "pi-todo-sync-"));
		state.changeRoot = join(state.root, "openspec", "changes", "a");
		mkdirSync(state.changeRoot, { recursive: true });
		state.tasksPath = join(state.changeRoot, "tasks.md");
	});
	afterEach(() => rmSync(state.root, { recursive: true, force: true }));
	return state;
}

export function buildSync(paths: { root: string; changeRoot: string; tasksPath: string }, content: string, over: Partial<RuntimeDeps> = {}, sessionIds = ["s1"]) {
	writeFileSync(paths.tasksPath, content);
	const cli = makeFakeCli({ root: paths.root, change: "a", tasksPath: paths.tasksPath, changeRoot: paths.changeRoot });
	const repaints: number[] = [];
	const errors: string[] = [];
	const watches: Array<{ file: string; closed: boolean; fire: () => void }> = [];
	const runtime = createRuntime({
		run: cli.run as any,
		getOrdinary: (id) => getState(id).tasks,
		onRepaint: () => void repaints.push(Date.now()),
		onError: (m) => void errors.push(m),
		lock: { waitMs: 200, pollMs: 10 },
		watchDelayMs: 20,
		watch: (file, onChange) => {
			const w = { file, closed: false, fire: onChange };
			watches.push(w);
			return { close: () => void (w.closed = true) };
		},
		...over,
	});
	const host = createHost();
	registerTodoTool(host.pi, runtime);
	registerTodosCommand(host.pi, runtime);
	for (const id of sessionIds) setSessionMode(id, { mode: "openspec", binding: { root: paths.root, change: "a" } });
	const ctx = (id = "s1", extra: Record<string, unknown> = {}) => createCtx(id, [], extra);
	const call = (params: Record<string, unknown>, id = "s1") => callTool(host, ctx(id), params);
	const disk = () => readFileSync(paths.tasksPath);
	/** Read the view as the agent does and return its revision. */
	const revision = async (id = "s1") => (await runtime.refresh(id)).revision!;
	return { cli, runtime, host, ctx, call, disk, revision, repaints, errors, watches };
}
