/**
 * Change discovery through the installed OpenSpec CLI.
 *
 * `context` gives the planning root the CLI resolved from the session
 * directory (nearest, declared, default or store). `list` gives the active
 * changes. `status` gives each change's schema and tracked task file. A change
 * is supported only when it is spec-driven, has exactly one tracked task file,
 * and every path stays inside the confirmed root. Nothing is guessed: any other
 * case is reported with a reason.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { ChangeDiscovery, DiscoveredChange, Discovery } from "../discovery.js";
import { type ExecOptions, type ExecResult, runOpenspecJson } from "./exec.js";

type Run = (args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

const SUPPORTED_SCHEMA = "spec-driven";
const STATUS_CONCURRENCY = 4;
/** Change names become CLI arguments, so accept only plain slug-like names. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** True when `child` is strictly inside `parent` after normalising both. */
export function isInside(parent: string, child: string): boolean {
	if (!isAbsolute(parent) || !isAbsolute(child)) return false;
	const rel = relative(resolve(parent), resolve(child));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

interface Root {
	path: string;
	source: string;
}

/** The single tracked task file in a `status --json` result that passed `checkStatus`. */
export function trackedTaskFile(json: unknown): string | undefined {
	const tasks = isRecord(json) && isRecord(json.artifactPaths) && isRecord(json.artifactPaths.tasks) ? json.artifactPaths.tasks.existingOutputPaths : undefined;
	return Array.isArray(tasks) && typeof tasks[0] === "string" ? tasks[0] : undefined;
}

function parseContext(json: unknown): Root | undefined {
	if (!isRecord(json) || !isRecord(json.root)) return undefined;
	const { path, source } = json.root;
	if (typeof path !== "string" || !isAbsolute(path) || typeof source !== "string" || source === "") return undefined;
	return { path, source };
}

function parseList(json: unknown): string[] | undefined {
	if (!isRecord(json) || !Array.isArray(json.changes)) return undefined;
	const names: string[] = [];
	for (const item of json.changes) {
		if (!isRecord(item) || typeof item.name !== "string") return undefined;
		names.push(item.name);
	}
	return names;
}

/** Decide whether one change can be bound, from its `status --json` output. */
export function checkStatus(json: unknown, root: { path: string }): { supported: true } | { supported: false; reason: string } {
	const unsupported = (reason: string) => ({ supported: false as const, reason });
	if (!isRecord(json) || typeof json.schemaName !== "string" || typeof json.changeRoot !== "string") return unsupported("unexpected status output");
	const tasks = isRecord(json.artifactPaths) && isRecord(json.artifactPaths.tasks) ? json.artifactPaths.tasks.existingOutputPaths : undefined;
	if (!Array.isArray(tasks) || !tasks.every((t) => typeof t === "string") || !isRecord(json.root) || typeof json.root.path !== "string") {
		return unsupported("unexpected status output");
	}
	if (json.root.path !== root.path) return unsupported(`planning root mismatch (status used ${json.root.path})`);
	if (!isInside(root.path, json.changeRoot)) return unsupported("change directory is outside the planning root");
	if (json.schemaName !== SUPPORTED_SCHEMA) return unsupported(`schema '${json.schemaName}' is not supported (${SUPPORTED_SCHEMA} only)`);
	if (tasks.length === 0) return unsupported("no tracked task file yet (create tasks.md first)");
	if (tasks.length > 1) return unsupported("more than one tracked task file");
	if (!isInside(json.changeRoot, tasks[0])) return unsupported("task file is outside the change directory");
	return { supported: true };
}

export function createDiscovery(run: Run = runOpenspecJson): ChangeDiscovery {
	return async (cwd, signal): Promise<Discovery> => {
		const context = await run(["context", "--json"], { cwd, signal });
		if (!context.ok) return { ok: false, error: context.message };
		const root = parseContext(context.json);
		if (!root) return { ok: false, error: "Unexpected output from `openspec context --json`" };

		const listed = await run(["list", "--json"], { cwd, signal });
		if (!listed.ok) return { ok: false, error: listed.message };
		const names = parseList(listed.json);
		if (!names) return { ok: false, error: "Unexpected output from `openspec list --json`" };

		const changes: DiscoveredChange[] = names.map((name) => ({ name, supported: false, reason: "unsafe change name" }));
		const queue = changes.map((_, index) => index).filter((index) => SAFE_NAME.test(names[index]));
		let cancelled: string | undefined;

		const worker = async () => {
			for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
				if (signal?.aborted || cancelled) return;
				const name = names[index];
				const result = await run(["status", "--change", name, "--json"], { cwd, signal });
				if (!result.ok && result.kind === "cancelled") {
					cancelled = result.message;
					return;
				}
				const verdict = result.ok ? checkStatus(result.json, root) : { supported: false as const, reason: `status failed: ${result.message}` };
				changes[index] = verdict.supported ? { name, supported: true } : { name, supported: false, reason: verdict.reason };
			}
		};
		await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, queue.length) }, worker));

		if (cancelled) return { ok: false, error: cancelled };
		if (signal?.aborted) return { ok: false, error: "Cancelled" };
		return { ok: true, root: root.path, rootSource: root.source, changes };
	};
}
