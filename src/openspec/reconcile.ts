/**
 * Reconcile the CLI's task list with the session's linked rows.
 *
 * The tracked Markdown file is authoritative for wording and completion, read
 * through `openspec instructions apply --json`. Local todo ids belong to this
 * session. CLI row numbers are positions, so they are never stored as identity:
 * a row keeps its local id only while its normalised wording is unchanged, and
 * ids are never reused. A write needs a unique mapping, and every doubt
 * (duplicate wording, duplicate labels, file and CLI disagreeing) leaves the
 * affected rows unmappable with a reason rather than guessing a target.
 */

import { fingerprint, labelOf, listTasks, revisionOf, scanTasks } from "./tasks.js";

/** Session-local data for a linked row. Never written to the planning file. */
export interface Activity {
	status?: "in_progress";
	activeForm?: string;
	owner?: string;
	blockedBy?: number[];
	metadata?: Record<string, unknown>;
	waitingReason?: string;
	failureReason?: string;
}

export type Mapping =
	| { ok: true; file: string; fingerprint: string; label?: string; revision: string }
	| { ok: false; reason: string };

export interface LinkedRow {
	/** Local todo id, unique within the session and never reused. */
	id: number;
	/** The CLI's row number at this revision. A position, not an identity. */
	rowId: string;
	description: string;
	label?: string;
	fingerprint: string;
	/** Completion as the file states it. */
	done: boolean;
	mapping: Mapping;
	activity?: Activity;
}

export interface CliTasks {
	tasks: ReadonlyArray<{ id: string; description: string; done: boolean }>;
	total: number;
	complete: number;
}

export interface ReconcileInput {
	previous: readonly LinkedRow[];
	nextId: number;
	cli: CliTasks;
	file: { path: string; content: string | Buffer };
}

export interface ReconcileResult {
	rows: LinkedRow[];
	nextId: number;
	revision: string;
	/** Local ids of previous rows that no longer exist. */
	removed: number[];
	diagnostics: string[];
	/** False when the file and the CLI view disagree; no row can be written to. */
	writable: boolean;
}

function group<T>(items: readonly T[], key: (item: T) => string | undefined): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		if (k !== undefined) groups.set(k, [...(groups.get(k) ?? []), item]);
	}
	return groups;
}

/** Does the file, read separately, say exactly what the CLI reported? */
function viewsAgree(content: string, cli: CliTasks): boolean {
	const scanned = scanTasks(content);
	const listed = listTasks(scanned);
	return (
		scanned.length === cli.total &&
		scanned.filter((t) => t.done).length === cli.complete &&
		listed.length === cli.tasks.length &&
		listed.every((t, i) => t.description === cli.tasks[i].description && t.done === cli.tasks[i].done)
	);
}

function carryActivity(previous: Activity | undefined, done: boolean): Activity | undefined {
	if (!previous) return undefined;
	const { status: _status, activeForm: _activeForm, ...rest } = previous;
	const kept: Activity = done ? rest : { ...previous };
	return Object.keys(kept).length ? structuredClone(kept) : undefined;
}

export function reconcile(input: ReconcileInput): ReconcileResult {
	const { previous, cli, file } = input;
	const text = typeof file.content === "string" ? file.content : file.content.toString("utf-8");
	const revision = revisionOf(file.content);
	const agree = viewsAgree(text, cli);

	const diagnostics: string[] = [];
	if (!agree) diagnostics.push("The task file does not match the CLI's view (it may have changed between reads). Refresh before writing.");
	const textless = cli.total - cli.tasks.length;
	if (textless > 0) {
		const plural = textless === 1;
		diagnostics.push(`${textless} ${plural ? "checkbox without text is" : "checkboxes without text are"} counted by OpenSpec but cannot be tracked. Add wording in tasks.md.`);
	}

	const drafts = cli.tasks.map((task) => ({ task, fingerprint: fingerprint(task.description), label: labelOf(task.description) }));
	const byWording = group(drafts, (d) => d.fingerprint);
	const byLabel = group(drafts, (d) => d.label);
	const previousByWording = group(previous, (r) => r.fingerprint);

	const used = new Set<number>();
	const seen = new Map<string, number>();
	let nextId = input.nextId;

	const rows = drafts.map((draft): LinkedRow => {
		const occurrence = seen.get(draft.fingerprint) ?? 0;
		seen.set(draft.fingerprint, occurrence + 1);
		const earlier = previousByWording.get(draft.fingerprint)?.[occurrence];
		const reuse = earlier && !used.has(earlier.id) ? earlier : undefined;
		const id = reuse ? reuse.id : nextId++;
		used.add(id);

		const wordingCount = byWording.get(draft.fingerprint)!.length;
		// Activity moves only between rows whose wording was and is unique.
		const unique = wordingCount === 1 && (previousByWording.get(draft.fingerprint)?.length ?? 0) <= 1;
		const labelCount = draft.label ? byLabel.get(draft.label)!.length : 1;

		let mapping: Mapping;
		if (!agree) mapping = { ok: false, reason: "The task file and the CLI disagree. Refresh and retry." };
		else if (wordingCount > 1) mapping = { ok: false, reason: `duplicate task wording (${wordingCount} identical rows). Make each task unique in tasks.md.` };
		else if (labelCount > 1) mapping = { ok: false, reason: `duplicate task label ${draft.label} (${labelCount} rows). Make each label unique in tasks.md.` };
		else mapping = { ok: true, file: file.path, fingerprint: draft.fingerprint, ...(draft.label ? { label: draft.label } : {}), revision };

		const activity = unique && mapping.ok ? carryActivity(reuse?.activity, draft.task.done) : undefined;
		return {
			id,
			rowId: draft.task.id,
			description: draft.task.description,
			...(draft.label ? { label: draft.label } : {}),
			fingerprint: draft.fingerprint,
			done: draft.task.done,
			mapping,
			...(activity ? { activity } : {}),
		};
	});

	const removed = previous.filter((r) => !used.has(r.id)).map((r) => r.id).toSorted((a, b) => a - b);
	return { rows, nextId, revision, removed, diagnostics, writable: agree };
}
