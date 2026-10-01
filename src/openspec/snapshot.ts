/**
 * The one snapshot provider for a session.
 *
 * `refresh()` reads the bound change through the OpenSpec CLI and the tracked
 * file, reconciles them into linked rows, and commits the result. `getSnapshot()`
 * assembles what the panel, `/todos` and the `todo` tool all show: the committed
 * OpenSpec view plus the session's current mode and ordinary tasks. Planning
 * readiness, implementation progress, ordinary tasks and session activity stay
 * separate fields, so none can stand in for another.
 *
 * A refresh publishes only when the file read before and after the CLI calls is
 * byte-identical. Overlapping refreshes are ordered by start: a result older than
 * the committed one is discarded. A failed refresh never passes for current: the
 * last good rows stay visible as stale and read-only.
 */

import { readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
import type { TodoMode } from "../preferences.js";
import type { Binding, SessionMode } from "../session-mode.js";
import { selectTodoCounts, type TodoCounts } from "../state/selectors.js";
import type { Task } from "../tool/types.js";
import { checkStatus, isInside, trackedTaskFile } from "./discover.js";
import { type ExecOptions, type ExecResult, runOpenspecJson } from "./exec.js";
import { type Activity, type CliTasks, type LinkedRow, reconcile } from "./reconcile.js";
import { revisionOf } from "./tasks.js";

type Run = (args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export type Freshness = "inactive" | "unbound" | "fresh" | "stale" | "unavailable";

export interface Snapshot {
	mode: TodoMode;
	binding?: Binding;
	freshness: Freshness;
	/** True only for a fresh view whose rows can each be mapped to the file. */
	writable: boolean;
	/** A read of the change is running. The rows shown are the last committed ones. */
	refreshing: boolean;
	/** The binding cannot continue; the user must choose a change again. */
	needsReselect: boolean;
	/** Are the planning artefacts written? Says nothing about implementation. */
	planning?: { isComplete: boolean; artifacts: Array<{ id: string; status: string }> };
	/** OpenSpec's own task progress. Says nothing about tests or verification. */
	implementation?: { state: "ready" | "blocked" | "all_done"; total: number; complete: number; remaining: number };
	linked: LinkedRow[];
	/** Next local id the provider will hand out for a linked row. */
	linkedNextId: number;
	ordinary: readonly Task[];
	ordinaryCounts: TodoCounts;
	revision?: string;
	file?: string;
	/** The change's directory, as the CLI reports it. */
	changeRoot?: string;
	schema?: string;
	notes: string[];
	diagnostics: string[];
}

export interface SnapshotDeps {
	run?: Run;
	readFile?: (path: string) => Promise<Buffer>;
	realpath?: (path: string) => Promise<string>;
}

export interface SnapshotSources {
	getMode(sessionId: string): SessionMode;
	getOrdinary(sessionId: string): readonly Task[];
}

interface Committed {
	binding: Binding;
	freshness: "fresh" | "stale" | "unavailable";
	writable: boolean;
	needsReselect: boolean;
	planning?: Snapshot["planning"];
	implementation?: Snapshot["implementation"];
	rows: LinkedRow[];
	revision?: string;
	file?: string;
	changeRoot?: string;
	schema?: string;
	notes: string[];
	diagnostics: string[];
}

interface Slot {
	started: number;
	committedSeq: number;
	/** Reads of the change that are running now. */
	inflight: number;
	committed?: Committed;
	nextId: number;
	/** Set when a completion could not be confirmed; cleared by a later successful refresh. */
	block?: { reason: string; seq: number };
	/** Ids and activity restored from session history, used until the first successful read. */
	seed?: { binding: Binding; rows: LinkedRow[] };
}

/** What is saved with the session so ids and activity survive reload. Never wording or completion. */
export interface PersistedLinked {
	binding: Binding;
	nextId: number;
	rows: Array<{ id: number; fingerprint: string; label?: string; activity?: Activity }>;
}

const MAX_ATTEMPTS = 3;
const NOTE_LIMIT = 2000;
const MAX_NOTES = 10;
const STATES = ["ready", "blocked", "all_done"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const cap = (text: string) => (text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT - 1)}…` : text);
const asText = (value: unknown) => cap(typeof value === "string" ? value : JSON.stringify(value));

class Failure {
	constructor(
		readonly message: string,
		readonly needsReselect = false,
	) {}
}

interface ApplyView {
	cli: CliTasks;
	implementation: NonNullable<Snapshot["implementation"]>;
	notes: string[];
}

function parseApply(json: unknown, bindingRoot: string): ApplyView | Failure {
	const bad = new Failure("Unexpected output from `openspec instructions apply --json`");
	if (!isRecord(json) || !Array.isArray(json.tasks) || !isRecord(json.progress)) return bad;
	const { total, complete, remaining } = json.progress;
	if (typeof total !== "number" || typeof complete !== "number" || typeof remaining !== "number") return bad;
	if (!STATES.includes(json.state as (typeof STATES)[number])) return bad;
	if (isRecord(json.root) && typeof json.root.path === "string" && json.root.path !== bindingRoot) {
		return new Failure(
			`The CLI now resolves a different planning root (${json.root.path}). Sync is suspended. Choose a change with /todo-settings.`,
			true,
		);
	}
	const tasks: CliTasks["tasks"][number][] = [];
	for (const item of json.tasks) {
		if (
			!isRecord(item) ||
			typeof item.id !== "string" ||
			typeof item.description !== "string" ||
			typeof item.done !== "boolean"
		)
			return bad;
		tasks.push({ id: item.id, description: item.description, done: item.done });
	}
	const notes: string[] = [];
	if (typeof json.instruction === "string") notes.push(cap(json.instruction));
	if (json.context !== undefined) notes.push(asText(json.context));
	if (Array.isArray(json.operationGuidance)) for (const entry of json.operationGuidance) notes.push(asText(entry));
	return {
		cli: { tasks, total, complete },
		implementation: { state: json.state as ApplyView["implementation"]["state"], total, complete, remaining },
		notes: notes.slice(0, MAX_NOTES),
	};
}

export function createSnapshotProvider(deps: SnapshotDeps, sources: SnapshotSources) {
	const run: Run = deps.run ?? runOpenspecJson;
	// nosemgrep: AIK_ts_generic_path_traversal -- path is resolved and checked inside the confirmed OpenSpec root
	const readFile = deps.readFile ?? ((path: string) => fsReadFile(path));
	const realpath = deps.realpath ?? ((path: string) => fsRealpath(path));
	const slots = new Map<string, Slot>();

	const slot = (sessionId: string): Slot => {
		let s = slots.get(sessionId);
		if (!s) slots.set(sessionId, (s = { started: 0, committedSeq: 0, inflight: 0, nextId: 1 }));
		return s;
	};

	function assemble(sessionId: string): Snapshot {
		const mode = sources.getMode(sessionId);
		const ordinary = sources.getOrdinary(sessionId);
		const base = {
			mode: mode.mode,
			linkedNextId: slots.get(sessionId)?.nextId ?? 1,
			refreshing: (slots.get(sessionId)?.inflight ?? 0) > 0,
			ordinary,
			ordinaryCounts: selectTodoCounts({ tasks: [...ordinary], nextId: 1 }),
			linked: [] as LinkedRow[],
			notes: [] as string[],
			writable: false,
			needsReselect: false,
		};
		if (mode.mode !== "openspec") return { ...base, freshness: "inactive", diagnostics: [] };
		if (!mode.binding)
			return {
				...base,
				freshness: "unbound",
				needsReselect: true,
				diagnostics: ["OpenSpec sync is selected but no change is chosen. Run /todo-settings to choose one."],
			};

		const committed = slots.get(sessionId)?.committed;
		const block = slots.get(sessionId)?.block;
		const sameBinding =
			committed && committed.binding.root === mode.binding.root && committed.binding.change === mode.binding.change;
		if (!committed || !sameBinding)
			return {
				...base,
				binding: mode.binding,
				freshness: "unavailable",
				diagnostics: ["The OpenSpec view has not been read yet."],
			};
		return {
			...base,
			binding: mode.binding,
			freshness: committed.freshness,
			writable: committed.writable && !block,
			needsReselect: committed.needsReselect,
			planning: committed.planning,
			implementation: committed.implementation,
			linked: committed.rows,
			revision: committed.revision,
			file: committed.file,
			changeRoot: committed.changeRoot,
			schema: committed.schema,
			notes: committed.notes,
			diagnostics:
				block && !committed.diagnostics.includes(block.reason)
					? [...committed.diagnostics, block.reason]
					: committed.diagnostics,
		};
	}

	/** One read of status, file, apply, and file again. */
	async function attempt(binding: Binding, s: Slot, signal?: AbortSignal): Promise<Committed | Failure | "changed"> {
		const options = { cwd: binding.root, signal };
		const status = await run(["status", "--change", binding.change, "--json"], options);
		if (!status.ok) {
			const gone = status.kind === "exit" && /not found/i.test(status.message);
			return new Failure(
				gone
					? "The bound change no longer exists (moved or archived). Choose another with /todo-settings."
					: status.message,
				gone,
			);
		}
		const sj = status.json;
		if (isRecord(sj) && isRecord(sj.root) && typeof sj.root.path === "string" && sj.root.path !== binding.root) {
			return new Failure(
				`The CLI now resolves a different planning root (${sj.root.path}). Sync is suspended. Choose a change with /todo-settings.`,
				true,
			);
		}
		const verdict = checkStatus(sj, { path: binding.root });
		if (!verdict.supported) return new Failure(`The bound change is not supported: ${verdict.reason}`, true);
		const file = trackedTaskFile(sj)!;
		const record = sj as Record<string, unknown>;

		// Resolve links first: a task file or change directory that leads outside the planning root is never read.
		try {
			const [realFile, realDir, realRoot] = await Promise.all([
				realpath(file),
				realpath(String((sj as Record<string, unknown>).changeRoot)),
				realpath(binding.root),
			]);
			if (!isInside(realRoot, realDir) || !isInside(realDir, realFile)) {
				return new Failure(
					"The task file resolves outside the confirmed change directory, so it is not read. Fix the link or choose another change with /todo-settings.",
					true,
				);
			}
		} catch (error) {
			return new Failure(`The task file path could not be resolved: ${(error as Error).message}`);
		}

		let before: Buffer;
		try {
			// nosemgrep: AIK_ts_generic_path_traversal -- path is resolved and checked inside the confirmed OpenSpec root
			before = await readFile(file);
		} catch (error) {
			return new Failure(`The task file could not be read: ${(error as Error).message}`);
		}
		const apply = await run(["instructions", "apply", "--change", binding.change, "--json"], options);
		if (!apply.ok) return new Failure(apply.message);
		const view = parseApply(apply.json, binding.root);
		if (view instanceof Failure) return view;
		let after: Buffer;
		try {
			// nosemgrep: AIK_ts_generic_path_traversal -- path is resolved and checked inside the confirmed OpenSpec root
			after = await readFile(file);
		} catch (error) {
			return new Failure(`The task file could not be read: ${(error as Error).message}`);
		}
		if (revisionOf(before) !== revisionOf(after)) return "changed";

		const same = (b: Binding) => b.change === binding.change && b.root === binding.root;
		const previous =
			s.committed && same(s.committed.binding) ? s.committed.rows : s.seed && same(s.seed.binding) ? s.seed.rows : [];
		const result = reconcile({ previous, nextId: s.nextId, cli: view.cli, file: { path: file, content: before } });
		s.nextId = result.nextId;
		const artifacts = Array.isArray(record.artifacts)
			? record.artifacts.filter(isRecord).map((a) => ({ id: String(a.id), status: String(a.status) }))
			: [];
		const planning =
			typeof (record.isPlanningComplete ?? record.isComplete) === "boolean"
				? { isComplete: (record.isPlanningComplete ?? record.isComplete) as boolean, artifacts }
				: undefined;
		return {
			binding,
			freshness: "fresh",
			writable: result.writable,
			needsReselect: false,
			planning,
			implementation: view.implementation,
			rows: result.rows,
			revision: result.revision,
			file,
			changeRoot: String(record.changeRoot),
			schema: String(record.schemaName),
			notes: view.notes,
			diagnostics: result.diagnostics,
		};
	}

	return {
		/** Read the bound change and commit the result. Never throws. */
		async refresh(
			sessionId: string,
			options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
		): Promise<Snapshot> {
			const mode = sources.getMode(sessionId);
			if (mode.mode !== "openspec" || !mode.binding) return assemble(sessionId);
			const s = slot(sessionId);
			const seq = ++s.started;
			s.inflight++;
			const binding = mode.binding;

			let outcome: Committed | Failure = new Failure("The task file changed during refresh. Retry when it settles.");
			try {
				for (let i = 0; i < MAX_ATTEMPTS; i++) {
					const result = await attempt(binding, s, options.signal);
					if (result === "changed") continue;
					outcome = result;
					break;
				}
			} catch (error) {
				outcome = new Failure(`Refresh failed: ${(error as Error).message}`);
			}
			s.inflight--;

			// An obsolete owner (the session rebound, branched or shut down) must not publish.
			if (options.isCurrent && !options.isCurrent()) return assemble(sessionId);
			if (seq > s.committedSeq) {
				s.committedSeq = seq;
				if (outcome instanceof Failure) {
					const last =
						s.committed && s.committed.binding.root === binding.root && s.committed.binding.change === binding.change
							? s.committed
							: undefined;
					const good = last && last.freshness !== "unavailable" ? last : undefined;
					s.committed = good
						? {
								...good,
								freshness: "stale",
								writable: false,
								needsReselect: outcome.needsReselect,
								diagnostics: [outcome.message],
							}
						: {
								binding,
								freshness: "unavailable",
								writable: false,
								needsReselect: outcome.needsReselect,
								rows: [],
								notes: [],
								diagnostics: [outcome.message],
							};
				} else {
					s.committed = outcome;
					s.seed = undefined;
					if (s.block && seq > s.block.seq) s.block = undefined;
				}
			}
			return assemble(sessionId);
		},

		/** Disable writes until a refresh that starts after this call succeeds. */
		blockWrites(sessionId: string, reason: string): void {
			const s = slot(sessionId);
			s.block = { reason, seq: s.started };
		},

		/** Restore ids and activity saved in session history. Does not make the view readable. */
		seed(sessionId: string, binding: Binding, rows: PersistedLinked["rows"], nextId: number): void {
			const current = sources.getMode(sessionId).binding;
			if (!current || current.root !== binding.root || current.change !== binding.change) return; // saved for another change
			const s = slot(sessionId);
			s.seed = {
				binding: { ...binding },
				rows: rows.map((r) => ({
					id: r.id,
					rowId: "",
					description: "",
					fingerprint: r.fingerprint,
					...(r.label ? { label: r.label } : {}),
					done: false,
					mapping: { ok: false, reason: "not yet read" },
					...(r.activity ? { activity: structuredClone(r.activity) } : {}),
				})),
			};
			s.nextId = Math.max(s.nextId, nextId, ...rows.map((r) => r.id + 1));
		},

		/** Replace one row's session activity. Refused unless the view is fresh and the revision matches. */
		setActivity(sessionId: string, id: number, activity: Activity | undefined, revision: string): boolean {
			const c = slots.get(sessionId)?.committed;
			if (!c || c.freshness !== "fresh" || c.revision !== revision) return false;
			const row = c.rows.find((r) => r.id === id);
			if (!row || !row.mapping.ok) return false;
			const { activity: _old, ...rest } = row;
			const next: LinkedRow =
				activity && Object.keys(activity).length ? { ...rest, activity: structuredClone(activity) } : rest;
			c.rows = c.rows.map((r) => (r.id === id ? next : r));
			return true;
		},

		/** The data to save with the session, or undefined when nothing is bound. */
		persistable(sessionId: string): PersistedLinked | undefined {
			const s = slots.get(sessionId);
			const mode = sources.getMode(sessionId);
			if (!s || mode.mode !== "openspec" || !mode.binding) return undefined;
			const same = (b: Binding) => b.change === mode.binding!.change && b.root === mode.binding!.root;
			const rows =
				s.committed && same(s.committed.binding)
					? s.committed.rows
					: s.seed && same(s.seed.binding)
						? s.seed.rows
						: undefined;
			if (!rows) return undefined;
			return {
				binding: { ...mode.binding },
				nextId: s.nextId,
				rows: rows.map((r) => ({
					id: r.id,
					fingerprint: r.fingerprint,
					...(r.label ? { label: r.label } : {}),
					...(r.activity ? { activity: structuredClone(r.activity) } : {}),
				})),
			};
		},

		/** What every view shows right now. Reads no files and starts no process. */
		getSnapshot: assemble,

		forget(sessionId: string): void {
			slots.delete(sessionId);
		},
	};
}
