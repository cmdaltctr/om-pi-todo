import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { resetPreferencesCache } from "../src/preferences.js";
import { __resetSessionModes } from "../src/session-mode.js";
import { __resetRunStates } from "../src/state/run-state.js";
import { __resetState } from "../src/state/store.js";

type Handler = (event: any, ctx: any) => unknown;

/** Minimal stand-in for Pi's `ExtensionAPI`: records what the extension registers. */
export function createHost() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	const entries: Array<[string, unknown]> = [];
	const pi = {
		appendEntry: (type: string, data: unknown) => void entries.push([type, data]),
		registerTool: (def: any) => void tools.set(def.name, def),
		registerCommand: (name: string, def: any) => void commands.set(name, def),
		registerShortcut: (key: string, def: any) => void shortcuts.set(key, def),
		on: (event: string, handler: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as any;
	return { pi, tools, commands, shortcuts, handlers, entries };
}

/** Session context: a session id plus the branch entries `replayFromBranch` walks. */
export function createCtx(sessionId: string, branch: unknown[] = [], extra: Record<string, unknown> = {}) {
	return {
		hasUI: false,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
		ui: { notify: () => undefined },
		...extra,
	} as any;
}

/** A branch entry holding one `todo` tool result, in the shape older sessions persisted. */
export function todoResultEntry(details: unknown) {
	return { type: "message", message: { role: "toolResult", toolName: "todo", details } };
}

/** Run `todo` with the given params as session `ctx`; returns text and details. */
export async function callTool(host: ReturnType<typeof createHost>, ctx: any, params: Record<string, unknown>) {
	const result = await host.tools.get("todo").execute("call-1", params, undefined, undefined, ctx);
	return { text: result.content[0].text as string, details: result.details };
}

/** Isolate config reads (HOME and XDG) and module state per test. */
export function useCleanEnvironment() {
	let dir = "";
	const previous: Record<string, string | undefined> = {};
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-todo-test-"));
		for (const key of ["HOME", "XDG_CONFIG_HOME"]) previous[key] = process.env[key];
		process.env.HOME = dir;
		process.env.XDG_CONFIG_HOME = join(dir, "xdg");
		__resetState();
		resetPreferencesCache();
		__resetSessionModes();
		__resetRunStates();
	});
	afterEach(() => {
		for (const key of ["HOME", "XDG_CONFIG_HOME"]) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		rmSync(dir, { recursive: true, force: true });
		__resetState();
		resetPreferencesCache();
		__resetSessionModes();
		__resetRunStates();
	});
}

type Answer = string | boolean | undefined;

/**
 * Scripted `ctx.ui`: each dialog method takes its next answer from its own queue.
 * An exhausted queue throws so a runaway dialog loop fails fast. Every call is recorded.
 */
export function scriptedUi(answers: { select?: Answer[]; confirm?: Answer[]; input?: Answer[] } = {}) {
	const queues = {
		select: [...(answers.select ?? [])],
		confirm: [...(answers.confirm ?? [])],
		input: [...(answers.input ?? [])],
	};
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const notes: Array<{ message: string; type?: string }> = [];
	const next = (method: keyof typeof queues, args: unknown[]) => {
		calls.push({ method, args });
		if (queues[method].length === 0)
			throw new Error(`scriptedUi: no answer left for ${method}(${JSON.stringify(args[0])})`);
		return queues[method].shift();
	};
	const ui = {
		select: async (...args: unknown[]) => next("select", args),
		confirm: async (...args: unknown[]) => next("confirm", args) === true,
		input: async (...args: unknown[]) => next("input", args),
		notify: (message: string, type?: string) => void notes.push({ message, type }),
	};
	return {
		ui,
		calls,
		notes,
		remaining: () => ({ select: queues.select.length, confirm: queues.confirm.length, input: queues.input.length }),
	};
}

/** Session context that records `appendEntry`-style writes made through a host. */
export function sessionEntry(data: unknown, customType = "pi-todo-session") {
	return { type: "custom", customType, data };
}
