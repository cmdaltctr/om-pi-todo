/**
 * Run the installed OpenSpec CLI and parse its JSON output.
 *
 * Arguments go to the process as an array, never through a shell. The working
 * directory must be absolute. Output size, run time and cancellation are
 * bounded, and a failed or cancelled run resolves only after the child has
 * exited, so no subprocess outlives its caller. Nothing here throws.
 */

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export type ExecFailure = "invalid-cwd" | "spawn" | "exit" | "timeout" | "cancelled" | "output-too-large" | "malformed";

export type ExecResult = { ok: true; json: unknown; stderr: string } | { ok: false; kind: ExecFailure; message: string };

export interface ExecOptions {
	/** Absolute directory the CLI runs in. The CLI resolves its planning root from here. */
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Largest stdout accepted, in bytes. */
	maxBytes?: number;
	/** Wait between the polite stop signal and the forced kill. */
	killGraceMs?: number;
	/** Executable name or path. */
	command?: string;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;
const STDERR_LIMIT = 64 * 1024;

/**
 * The CLI reports some failures as JSON on stdout (`{"status":[{"message":...}]}`)
 * with an empty stderr. Use each message's first line, or the plain text.
 */
function errorFromStdout(text: string): string {
	try {
		const parsed = JSON.parse(text) as { status?: Array<{ message?: unknown }> };
		const lines = (parsed.status ?? []).flatMap((item) => (typeof item.message === "string" ? [item.message.split("\n")[0].trim()] : []));
		if (lines.length > 0) return lines.join("; ");
	} catch {
		// not JSON: fall through to the raw text
	}
	return text.trim().split("\n")[0] ?? "";
}

export function runOpenspecJson(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
	const { cwd, signal, command = "openspec" } = options;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

	if (!isAbsolute(cwd)) return Promise.resolve({ ok: false, kind: "invalid-cwd", message: `Working directory must be absolute: ${cwd}` });
	if (signal?.aborted) return Promise.resolve({ ok: false, kind: "cancelled", message: "Cancelled before the OpenSpec command started" });

	return new Promise<ExecResult>((resolve) => {
		let settled = false;
		let stopReason: { kind: ExecFailure; message: string } | undefined;
		let stdoutBytes = 0;
		const stdout: Buffer[] = [];
		let stderr = "";
		let timeoutTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let backstopTimer: NodeJS.Timeout | undefined;

		const child = spawn(command, [...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

		const finish = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			clearTimeout(killTimer);
			clearTimeout(backstopTimer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		/** Stop the child once, politely first, then by force. Resolves when it exits. */
		const stop = (kind: ExecFailure, message: string) => {
			if (stopReason || settled) return;
			stopReason = { kind, message };
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
			backstopTimer = setTimeout(() => finish({ ok: false, ...stopReason! }), killGraceMs + 1_000);
		};

		const onAbort = () => stop("cancelled", "OpenSpec command cancelled");
		signal?.addEventListener("abort", onAbort, { once: true });
		timeoutTimer = setTimeout(() => stop("timeout", `OpenSpec command timed out after ${timeoutMs} ms`), timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > maxBytes) {
				stop("output-too-large", `OpenSpec output exceeded ${maxBytes} bytes`);
				return;
			}
			if (!stopReason) stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf-8");
		});

		child.on("error", (error) => finish({ ok: false, kind: "spawn", message: `Could not run ${command}: ${error.message}` }));

		child.on("close", (code, killedBy) => {
			if (stopReason) return finish({ ok: false, ...stopReason });
			if (code !== 0) {
				const detail = (stderr.trim() || errorFromStdout(Buffer.concat(stdout).toString("utf-8"))).slice(0, 500);
				const how = code === null ? `signal ${killedBy}` : `code ${code}`;
				return finish({ ok: false, kind: "exit", message: `OpenSpec exited with ${how}${detail ? `: ${detail}` : ""}` });
			}
			try {
				finish({ ok: true, json: JSON.parse(Buffer.concat(stdout).toString("utf-8")), stderr });
			} catch {
				finish({ ok: false, kind: "malformed", message: "OpenSpec output was not valid JSON" });
			}
		});
	});
}
