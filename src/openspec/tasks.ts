/**
 * Task checkbox scanner that mirrors the installed OpenSpec parser.
 *
 * OpenSpec (1.13.1) treats every line that matches TASK_LINE_PATTERN as a task,
 * inside code fences and comments too. A box is done only when its marker is
 * `x` or `X`. Its apply list skips boxes with no text and numbers the rest from
 * 1 in document order, so those row numbers change whenever a row is added,
 * removed or moved. This scanner reproduces those rules and also records where
 * each box sits, which the CLI does not report. Parity with the CLI is tested
 * against the real executable.
 */

import { createHash } from "node:crypto";

// Keep in step with OpenSpec's utils/task-progress.js.
const TASK_LINE_PATTERN = /^\s*(?:[-*+]|\d{1,9}[.)])\s*\[(?:\s*([^\]\s]?)\s*\](?![([])|\s+\])\s*(.*)/;
const LIST_PREFIX_PATTERN = /^\s*(?:[-*+]|\d{1,9}[.)])\s*/;
const LABEL_PATTERN = /^(\d+(?:\.\d+)*)(?=\s|$)/;

export interface ScannedTask {
	/** Zero-based line number. */
	line: number;
	/** Offset of `[` in the whole file. */
	boxStart: number;
	/** Offset of `]` in the whole file. */
	boxEnd: number;
	/** The single non-space marker character, or "" for an empty box. */
	marker: string;
	done: boolean;
	/** Trimmed text after the box; may be empty. */
	description: string;
}

export interface ListedTask extends ScannedTask {
	/** The CLI's row number for this task: "1", "2", ... among tasks with text. */
	rowId: string;
	/** Leading dotted number such as `3.4`, when present. */
	label?: string;
	/** Hash of the whitespace-normalised description. */
	fingerprint: string;
}

/** Every checkbox line in document order, including boxes with no text. */
export function scanTasks(content: string): ScannedTask[] {
	const tasks: ScannedTask[] = [];
	let offset = 0;
	const lines = content.split("\n");
	for (let line = 0; line < lines.length; line++) {
		const text = lines[line];
		const match = text.match(TASK_LINE_PATTERN);
		if (match) {
			const open = text.match(LIST_PREFIX_PATTERN)![0].length;
			tasks.push({
				line,
				boxStart: offset + open,
				boxEnd: offset + text.indexOf("]", open),
				marker: match[1] ?? "",
				done: (match[1] ?? "").toLowerCase() === "x",
				description: match[2].trim(),
			});
		}
		offset += text.length + 1;
	}
	return tasks;
}

export function normaliseDescription(description: string): string {
	return description.replace(/\s+/g, " ").trim();
}

export function fingerprint(description: string): string {
	return createHash("sha256").update(normaliseDescription(description)).digest("hex").slice(0, 16);
}

/** Leading dotted number such as `3.4` in a task description, when present. */
export function labelOf(description: string): string | undefined {
	return description.match(LABEL_PATTERN)?.[1];
}

/** The tasks OpenSpec lists for apply: those with text, numbered from 1. */
export function listTasks(scanned: readonly ScannedTask[]): ListedTask[] {
	const listed: ListedTask[] = [];
	for (const task of scanned) {
		if (task.description === "") continue;
		const label = labelOf(task.description);
		listed.push({
			...task,
			rowId: String(listed.length + 1),
			...(label ? { label } : {}),
			fingerprint: fingerprint(task.description),
		});
	}
	return listed;
}

/** Content hash that identifies one exact version of a task file. */
export function revisionOf(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}
