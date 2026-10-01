import { readFile } from "node:fs/promises";
import type { ExecOptions, ExecResult } from "../src/openspec/exec.js";
import { listTasks, scanTasks } from "../src/openspec/tasks.js";

type Hook = (args: readonly string[]) => ExecResult | Promise<ExecResult | undefined> | undefined;

/** JSON shapes of the real CLI, computed from the file on disk at call time. */
export function makeFakeCli(o: { root: string; change: string; tasksPath: string; changeRoot: string; schema?: string }) {
	const calls: Array<{ args: readonly string[]; cwd: string; signal?: AbortSignal }> = [];
	const hooks: { status?: Hook; apply?: Hook } = {};
	const ok = (json: unknown): ExecResult => ({ ok: true, json, stderr: "" });

	async function apply() {
		const content = await readFile(o.tasksPath, "utf-8");
		const scanned = scanTasks(content);
		const done = scanned.filter((t) => t.done).length;
		return {
			changeName: o.change,
			schemaName: o.schema ?? "spec-driven",
			state: done === scanned.length && scanned.length > 0 ? "all_done" : "ready",
			progress: { total: scanned.length, complete: done, remaining: scanned.length - done },
			tasks: listTasks(scanned).map((t) => ({ id: t.rowId, description: t.description, done: t.done })),
			instruction: "Work through pending tasks.",
			root: { path: o.root, source: "nearest" },
		};
	}

	const run = async (args: readonly string[], options: ExecOptions): Promise<ExecResult> => {
		calls.push({ args, cwd: options.cwd, signal: options.signal });
		if (options.signal?.aborted) return { ok: false, kind: "cancelled", message: "OpenSpec command cancelled" }; // as the real runner does
		if (args[0] === "status") {
			const overridden = await hooks.status?.(args);
			if (overridden) return overridden;
			return ok({
				changeName: o.change,
				schemaName: o.schema ?? "spec-driven",
				changeRoot: o.changeRoot,
				isPlanningComplete: true,
				artifacts: [{ id: "tasks", status: "done" }],
				artifactPaths: { tasks: { existingOutputPaths: [o.tasksPath] } },
				root: { path: o.root, source: "nearest" },
			});
		}
		if (args[0] === "instructions") {
			const overridden = await hooks.apply?.(args);
			if (overridden) return overridden;
			return ok(await apply());
		}
		return { ok: false, kind: "exit", message: `unexpected ${args[0]}` };
	};
	return { run, hooks, calls, applyJson: apply };
}
