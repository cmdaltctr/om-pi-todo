import { describe, expect, it } from "vitest";
import extension from "../src/extension.js";
import { savePreferences } from "../src/preferences.js";
import {
	describeSessionMode,
	getSessionMode,
	replaySessionMode,
	SESSION_ENTRY_TYPE,
	setSessionMode,
} from "../src/session-mode.js";
import { getState } from "../src/state/store.js";
import { callTool, createCtx, createHost, sessionEntry, todoResultEntry, useCleanEnvironment } from "./helpers.js";

useCleanEnvironment();

const binding = { root: "/work/project", change: "add-thing" };

describe("replaying the session mode", () => {
	it("defaults to normal mode with no binding", () => {
		expect(replaySessionMode(createCtx("s1", []))).toEqual({ mode: "normal" });
	});

	it("takes the saved default mode for a session with no entry, still unbound", async () => {
		await savePreferences({ mode: "openspec" });
		expect(replaySessionMode(createCtx("s1", []))).toEqual({ mode: "openspec" });
	});

	it("restores the last valid entry on the branch", () => {
		const branch = [sessionEntry({ mode: "openspec", binding }), sessionEntry({ mode: "normal" })];
		expect(replaySessionMode(createCtx("s1", branch))).toEqual({ mode: "normal" });
		expect(replaySessionMode(createCtx("s1", branch.slice(0, 1)))).toEqual({ mode: "openspec", binding });
	});

	it("ignores entries of other types and malformed data", () => {
		const branch = [
			sessionEntry({ mode: "openspec", binding }),
			sessionEntry({ mode: "normal" }, "someone-else"),
			sessionEntry({ mode: "bogus" }),
			sessionEntry({ mode: "openspec", binding: { root: "", change: "x" } }),
			sessionEntry({ mode: "openspec", binding: { root: "/r" } }),
			sessionEntry(null),
			sessionEntry("text"),
			{ type: "message", message: { role: "user" } },
		];
		expect(replaySessionMode(createCtx("s1", branch))).toEqual({ mode: "openspec", binding });
	});

	it("does not keep a binding for normal mode", () => {
		expect(replaySessionMode(createCtx("s1", [sessionEntry({ mode: "normal", binding })]))).toEqual({ mode: "normal" });
	});

	it("returns a copy, so edits cannot change the stored slot", () => {
		setSessionMode("s1", { mode: "openspec", binding });
		getSessionMode("s1").binding!.change = "changed";
		expect(getSessionMode("s1").binding!.change).toBe("add-thing");
	});
});

describe("describing the mode", () => {
	it("names each state", () => {
		expect(describeSessionMode({ mode: "normal" })).toBe("Normal");
		expect(describeSessionMode({ mode: "openspec" })).toBe("OpenSpec sync: change selection required");
		expect(describeSessionMode({ mode: "openspec", binding })).toBe("OpenSpec sync: add-thing (/work/project)");
	});
});

describe("session lifecycle", () => {
	async function start(host: ReturnType<typeof createHost>, ctx: any, event = "session_start") {
		await Promise.all((host.handlers.get(event) ?? []).map((h) => h({}, ctx)));
	}

	it("restores mode and binding on start, compaction, and branch navigation", async () => {
		const host = createHost();
		await extension(host.pi);
		const branch: unknown[] = [sessionEntry({ mode: "openspec", binding })];
		const ctx = createCtx("s1", branch);
		await start(host, ctx);
		expect(getSessionMode("s1")).toEqual({ mode: "openspec", binding });

		branch.length = 0;
		branch.push(sessionEntry({ mode: "normal" }));
		await start(host, ctx, "session_compact");
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });

		branch.length = 0;
		branch.push(sessionEntry({ mode: "openspec", binding }));
		await start(host, ctx, "session_tree");
		expect(getSessionMode("s1")).toEqual({ mode: "openspec", binding });
	});

	it("keeps simultaneous sessions independent", async () => {
		const host = createHost();
		await extension(host.pi);
		await start(host, createCtx("a", [sessionEntry({ mode: "openspec", binding })]));
		await start(host, createCtx("b", []));
		await start(host, createCtx("c", [sessionEntry({ mode: "openspec", binding: { root: "/other", change: "other-change" } })]));
		expect(getSessionMode("a").binding?.change).toBe("add-thing");
		expect(getSessionMode("b")).toEqual({ mode: "normal" });
		expect(getSessionMode("c").binding?.change).toBe("other-change");
		setSessionMode("b", { mode: "openspec", binding });
		expect(getSessionMode("a").binding?.change).toBe("add-thing");
		expect(getSessionMode("c").binding?.root).toBe("/other");
	});

	it("does not change a running session when the default changes", async () => {
		const host = createHost();
		await extension(host.pi);
		const ctx = createCtx("s1", []);
		await start(host, ctx);
		await savePreferences({ mode: "openspec" });
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
		await start(host, createCtx("s2", []));
		expect(getSessionMode("s2")).toEqual({ mode: "openspec" });
	});

	it("drops a session's mode on shutdown", async () => {
		const host = createHost();
		await extension(host.pi);
		const ctx = createCtx("s1", [sessionEntry({ mode: "openspec", binding })]);
		await start(host, ctx);
		await start(host, ctx, "session_shutdown");
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
	});

	it("warns once on start when sync is the default and no change is chosen", async () => {
		await savePreferences({ mode: "openspec" });
		const host = createHost();
		await extension(host.pi);
		const notes: Array<[string, string]> = [];
		const ctx = createCtx("s1", [], { hasUI: true, ui: { notify: (m: string, t: string) => notes.push([m, t]), setWidget: () => undefined } });
		await start(host, ctx);
		expect(notes).toEqual([["OpenSpec sync is selected but no change is chosen. Run /todo-settings to choose one.", "warning"]]);
	});

	it("does not warn for a bound or normal session", async () => {
		const host = createHost();
		await extension(host.pi);
		const notes: unknown[] = [];
		const ui = { notify: (...a: unknown[]) => notes.push(a), setWidget: () => undefined };
		await start(host, createCtx("a", [], { hasUI: true, ui }));
		await start(host, createCtx("b", [sessionEntry({ mode: "openspec", binding })], { hasUI: true, ui }));
		expect(notes).toEqual([]);
	});

	it("leaves the ordinary task list untouched across mode switches", async () => {
		const host = createHost();
		await extension(host.pi);
		const ctx = createCtx("s1", []);
		await start(host, ctx);
		await callTool(host, ctx, { action: "create", subject: "Ordinary task" });
		const before = getState("s1");
		setSessionMode("s1", { mode: "openspec", binding });
		setSessionMode("s1", { mode: "normal" });
		expect(getState("s1")).toEqual(before);
		expect((await callTool(host, ctx, { action: "list" })).text).toBe("[pending] #1 Ordinary task");
	});

	it("exports the entry type used for persistence", () => {
		expect(SESSION_ENTRY_TYPE).toBe("pi-todo-session");
	});
});

describe("legacy sessions", () => {
	it("starts normal for sessions that only hold todo snapshots", () => {
		const branch = [todoResultEntry({ tasks: [{ id: 1, subject: "A", status: "pending" }], nextId: 2 })];
		expect(replaySessionMode(createCtx("s1", branch))).toEqual({ mode: "normal" });
	});
});
