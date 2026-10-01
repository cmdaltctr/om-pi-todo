import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChangeDiscovery } from "../src/discovery.js";
import { getPreferences, preferencesPath, refreshPreferences, savePreferences } from "../src/preferences.js";
import { getSessionMode, SESSION_ENTRY_TYPE, setSessionMode } from "../src/session-mode.js";
import { registerTodoSettingsCommand } from "../src/settings.js";
import { createCtx, createHost, scriptedUi, useCleanEnvironment } from "./helpers.js";

useCleanEnvironment();

const ROOT = "/work/project";
const found: ChangeDiscovery = async () => ({
	ok: true,
	root: ROOT,
	changes: [
		{ name: "add-thing", supported: true },
		{ name: "custom-flow", supported: false, reason: "schema 'custom' is not supported" },
	],
});

function setup(discover: ChangeDiscovery = found) {
	const host = createHost();
	const entries: Array<[string, unknown]> = [];
	(host.pi as any).appendEntry = (type: string, data: unknown) => entries.push([type, data]);
	registerTodoSettingsCommand(host.pi, discover);
	return { host, entries };
}

async function run(answers: Parameters<typeof scriptedUi>[0], discover?: ChangeDiscovery, sessionId = "s1") {
	await refreshPreferences();
	const { host, entries } = setup(discover);
	const script = scriptedUi(answers);
	await host.commands
		.get("todo-settings")
		.handler("", createCtx(sessionId, [], { hasUI: true, cwd: "/work/cwd", ui: script.ui }));
	return { ...script, entries };
}

const MENU = "Todo settings";

describe("/todo-settings menu", () => {
	it("registers the command", () => {
		expect([...setup().host.commands.keys()]).toEqual(["todo-settings"]);
	});

	it("refuses to run without a UI", async () => {
		const { host } = setup();
		const script = scriptedUi();
		await host.commands.get("todo-settings").handler("", createCtx("s1", [], { hasUI: false, ui: script.ui }));
		expect(script.notes).toEqual([{ message: "/todo-settings requires interactive mode", type: "error" }]);
		expect(script.calls).toEqual([]);
	});

	it("shows the current values and closes on Done", async () => {
		const result = await run({ select: ["Done"] });
		expect(result.calls[0]).toMatchObject({
			method: "select",
			args: [
				MENU,
				[
					"Session mode: Normal",
					"Default mode for new sessions: Normal",
					"Panel line budget: 12",
					"Collapse key: ctrl+shift+t",
					"Done",
				],
			],
		});
		expect(result.entries).toEqual([]);
	});

	it("closes when the menu is cancelled", async () => {
		const result = await run({ select: [undefined] });
		expect(result.calls).toHaveLength(1);
		expect(result.entries).toEqual([]);
	});
});

describe("choosing OpenSpec sync for this session", () => {
	it("binds only after the user picks a change and confirms the root", async () => {
		const result = await run({
			select: ["Session mode: Normal", "OpenSpec sync", "add-thing", "Done"],
			confirm: [true],
		});
		expect(getSessionMode("s1")).toEqual({ mode: "openspec", binding: { root: ROOT, change: "add-thing" } });
		expect(result.entries).toEqual([
			[SESSION_ENTRY_TYPE, { mode: "openspec", binding: { root: ROOT, change: "add-thing" } }],
		]);
		const picker = result.calls.find((c) => String(c.args[0]).startsWith("Choose an OpenSpec change"));
		expect(picker?.args[0]).toContain(ROOT);
		const confirm = result.calls.find((c) => c.method === "confirm");
		expect(confirm?.args[1]).toContain(ROOT);
		expect(confirm?.args[1]).toContain("add-thing");
	});

	it("passes the session directory to discovery", async () => {
		let seen = "";
		await run({ select: ["Session mode: Normal", "OpenSpec sync", undefined, "Done"] }, async (cwd) => {
			seen = cwd;
			return found(cwd);
		});
		expect(seen).toBe("/work/cwd");
	});

	it("leaves mode, binding, and entries alone when the mode picker is cancelled", async () => {
		const result = await run({ select: ["Session mode: Normal", undefined, "Done"] });
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
		expect(result.entries).toEqual([]);
	});

	it("leaves everything alone when the change picker is cancelled", async () => {
		const result = await run({ select: ["Session mode: Normal", "OpenSpec sync", undefined, "Done"] });
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
		expect(result.entries).toEqual([]);
	});

	it("leaves everything alone when the root confirmation is declined", async () => {
		const result = await run({
			select: ["Session mode: Normal", "OpenSpec sync", "add-thing", "Done"],
			confirm: [false],
		});
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
		expect(result.entries).toEqual([]);
	});

	it("keeps an existing binding when a later rebind is cancelled", async () => {
		setSessionMode("s1", { mode: "openspec", binding: { root: ROOT, change: "add-thing" } });
		const result = await run({
			select: ["Session mode: OpenSpec sync: add-thing (/work/project)", "OpenSpec sync", undefined, "Done"],
		});
		expect(getSessionMode("s1").binding).toEqual({ root: ROOT, change: "add-thing" });
		expect(result.entries).toEqual([]);
	});

	it("explains an unsupported change and does not bind it", async () => {
		const result = await run({
			select: [
				"Session mode: Normal",
				"OpenSpec sync",
				"custom-flow (unsupported: schema 'custom' is not supported)",
				"Done",
			],
		});
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
		expect(result.notes.map((n) => n.message).join("\n")).toContain("schema 'custom' is not supported");
		expect(result.calls.some((c) => c.method === "confirm")).toBe(false);
	});

	it("reports a discovery failure and stays in the current mode", async () => {
		const result = await run({ select: ["Session mode: Normal", "OpenSpec sync", "Done"] }, async () => ({
			ok: false,
			error: "openspec not found",
		}));
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
		expect(result.notes).toEqual([{ message: "OpenSpec sync unavailable: openspec not found", type: "error" }]);
	});

	it("reports when no change can be selected", async () => {
		const none: ChangeDiscovery = async () => ({ ok: true, root: ROOT, changes: [] });
		const result = await run({ select: ["Session mode: Normal", "OpenSpec sync", "Done"] }, none);
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
		expect(result.notes[0].message).toContain(`No OpenSpec changes found in ${ROOT}`);
	});
});

describe("returning to normal mode", () => {
	it("switches back, clears the binding, and persists it", async () => {
		setSessionMode("s1", { mode: "openspec", binding: { root: ROOT, change: "add-thing" } });
		const result = await run({ select: ["Session mode: OpenSpec sync: add-thing (/work/project)", "Normal", "Done"] });
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
		expect(result.entries).toEqual([[SESSION_ENTRY_TYPE, { mode: "normal" }]]);
	});
});

describe("default mode for new sessions", () => {
	it("saves the default without changing the running session", async () => {
		setSessionMode("s1", { mode: "normal" }); // a started session holds its own slot
		const result = await run({ select: ["Default mode for new sessions: Normal", "OpenSpec sync", "Done"] });
		expect(JSON.parse(readFileSync(preferencesPath(), "utf-8")).mode).toBe("openspec");
		expect(getPreferences().mode).toBe("openspec");
		expect(getSessionMode("s1")).toEqual({ mode: "normal" });
		expect(result.entries).toEqual([]);
		expect(result.notes.map((n) => n.message).join("\n")).toContain("New sessions start unbound");
	});

	it("saves normal as the default too", async () => {
		await savePreferences({ mode: "openspec" });
		await run({ select: ["Default mode for new sessions: OpenSpec sync", "Normal", "Done"] });
		expect(getPreferences().mode).toBe("normal");
	});

	it("leaves the default alone when the picker is cancelled", async () => {
		await run({ select: ["Default mode for new sessions: Normal", undefined, "Done"] });
		expect(getPreferences().mode).toBe("normal");
	});
});

describe("display preferences", () => {
	it("saves a new line budget", async () => {
		await run({ select: ["Panel line budget: 12", "Done"], input: ["20"] });
		expect(getPreferences().maxWidgetLines).toBe(20);
	});

	it("rejects a bad line budget and keeps the old one", async () => {
		for (const bad of ["2", "abc", "", "1e999", "12.5x"]) {
			const result = await run({ select: ["Panel line budget: 12", "Done"], input: [bad] });
			expect(getPreferences().maxWidgetLines).toBe(12);
			expect(result.notes[0]).toEqual({
				message: "Panel line budget must be a whole number of at least 3",
				type: "error",
			});
		}
	});

	it("leaves the budget alone when the input is cancelled", async () => {
		const result = await run({ select: ["Panel line budget: 12", "Done"], input: [undefined] });
		expect(getPreferences().maxWidgetLines).toBe(12);
		expect(result.notes).toEqual([]);
	});

	it("saves a valid collapse key and says it needs a reload", async () => {
		const result = await run({ select: ["Collapse key: ctrl+shift+t", "Done"], input: ["Alt+O"] });
		expect(getPreferences().collapseKey).toBe("alt+o");
		expect(result.notes[0].message).toContain("/reload");
	});

	it("accepts off and rejects an invalid key", async () => {
		await run({ select: ["Collapse key: ctrl+shift+t", "Done"], input: ["off"] });
		expect(getPreferences().collapseKey).toBe("off");
		const result = await run({ select: ["Collapse key: off", "Done"], input: ["ctr+]"] });
		expect(getPreferences().collapseKey).toBe("off");
		expect(result.notes[0]).toEqual({
			message: "Invalid collapse key. Use modifier+key such as ctrl+shift+t, or off.",
			type: "error",
		});
	});

	it("reports a failed save and keeps the cache", async () => {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { dirname } = await import("node:path");
		mkdirSync(dirname(preferencesPath()), { recursive: true });
		writeFileSync(preferencesPath(), "{ broken");
		const result = await run({ select: ["Panel line budget: 12", "Done"], input: ["20"] });
		expect(getPreferences().maxWidgetLines).toBe(12);
		expect(result.notes[0].type).toBe("error");
		expect(result.notes[0].message).toMatch(/not valid JSON/);
	});
});

describe("mode change hook", () => {
	async function withHook(answers: Parameters<typeof scriptedUi>[0]) {
		await refreshPreferences();
		const host = createHost();
		(host.pi as any).appendEntry = () => undefined;
		const seen: Array<{ mode: string }> = [];
		registerTodoSettingsCommand(host.pi, found, {
			onModeChanged: async (ctx) => {
				seen.push({ mode: getSessionMode("s1").mode });
				void ctx;
			},
		});
		const script = scriptedUi(answers);
		await host.commands
			.get("todo-settings")
			.handler("", createCtx("s1", [], { hasUI: true, cwd: "/work/cwd", ui: script.ui }));
		return seen;
	}

	it("runs after a session is bound, seeing the new mode already in place", async () => {
		expect(
			await withHook({ select: ["Session mode: Normal", "OpenSpec sync", "add-thing", "Done"], confirm: [true] }),
		).toEqual([{ mode: "openspec" }]);
	});

	it("runs after a return to normal mode", async () => {
		setSessionMode("s1", { mode: "openspec", binding: { root: ROOT, change: "add-thing" } });
		expect(
			await withHook({ select: ["Session mode: OpenSpec sync: add-thing (/work/project)", "Normal", "Done"] }),
		).toEqual([{ mode: "normal" }]);
	});

	it("does not run when the user cancels, declines, or picks an unsupported change", async () => {
		expect(await withHook({ select: ["Session mode: Normal", undefined, "Done"] })).toEqual([]);
		expect(await withHook({ select: ["Session mode: Normal", "OpenSpec sync", undefined, "Done"] })).toEqual([]);
		expect(
			await withHook({ select: ["Session mode: Normal", "OpenSpec sync", "add-thing", "Done"], confirm: [false] }),
		).toEqual([]);
		expect(
			await withHook({
				select: [
					"Session mode: Normal",
					"OpenSpec sync",
					"custom-flow (unsupported: schema 'custom' is not supported)",
					"Done",
				],
			}),
		).toEqual([]);
	});

	it("does not run for default-mode or display changes", async () => {
		expect(await withHook({ select: ["Default mode for new sessions: Normal", "OpenSpec sync", "Done"] })).toEqual([]);
	});
});

describe("isolation between sessions", () => {
	it("changes only the session that ran the command", async () => {
		setSessionMode("other", { mode: "openspec", binding: { root: "/elsewhere", change: "x" } });
		await run({ select: ["Session mode: Normal", "OpenSpec sync", "add-thing", "Done"], confirm: [true] }, found, "s1");
		expect(getSessionMode("other")).toEqual({ mode: "openspec", binding: { root: "/elsewhere", change: "x" } });
		expect(getSessionMode("s1").binding?.change).toBe("add-thing");
	});
});
