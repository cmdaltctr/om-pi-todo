import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PREFERENCES,
	getMaxWidgetLines,
	getPreferences,
	loadPreferences,
	preferencesPath,
	refreshPreferences,
	resolveCollapseKey,
	resetPreferencesCache,
	savePreferences,
} from "../src/preferences.js";

let home = "";
let xdg = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-todo-home-"));
	xdg = join(home, "xdg");
	for (const key of ["HOME", "XDG_CONFIG_HOME"]) saved[key] = process.env[key];
	process.env.HOME = home;
	process.env.XDG_CONFIG_HOME = xdg;
	resetPreferencesCache();
});

afterEach(() => {
	for (const key of ["HOME", "XDG_CONFIG_HOME"]) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(home, { recursive: true, force: true });
	resetPreferencesCache();
});

function write(path: string, content: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

const legacyXdg = () => join(xdg, "rpiv-todo", "config.json");
const legacyHome = () => join(home, ".config", "rpiv-todo", "config.json");

describe("defaults", () => {
	it("starts in normal mode with no files and no package present", async () => {
		const result = await loadPreferences();
		expect(result.source).toBe("default");
		expect(result.diagnostics).toEqual([]);
		expect(result.preferences).toEqual({ ...DEFAULT_PREFERENCES });
		expect(result.preferences.mode).toBe("normal");
		expect(result.preferences.maxWidgetLines).toBe(12);
		expect(result.preferences.collapseKey).toBe("ctrl+shift+t");
	});

	it("puts the preferences file under XDG_CONFIG_HOME, else ~/.config", () => {
		expect(preferencesPath()).toBe(join(xdg, "pi-todo", "config.json"));
		process.env.XDG_CONFIG_HOME = "relative/path";
		expect(preferencesPath()).toBe(join(home, ".config", "pi-todo", "config.json"));
		delete process.env.XDG_CONFIG_HOME;
		expect(preferencesPath()).toBe(join(home, ".config", "pi-todo", "config.json"));
	});

	it("reads the current file", async () => {
		write(preferencesPath(), JSON.stringify({ mode: "openspec", maxWidgetLines: 20, collapseKey: "alt+o" }));
		const result = await loadPreferences();
		expect(result.source).toBe("current");
		expect(result.preferences).toMatchObject({ mode: "openspec", maxWidgetLines: 20, collapseKey: "alt+o" });
	});
});

describe("legacy file migration", () => {
	const legacy = JSON.stringify({
		maxWidgetLines: 25,
		collapseKey: "alt+o",
		guidance: { promptSnippet: "Legacy snippet", promptGuidelines: ["one"] },
		mode: "openspec",
	});

	it("reads display preferences from the old XDG-path file when the new file is absent", async () => {
		write(legacyXdg(), legacy);
		const result = await loadPreferences();
		expect(result.source).toBe("legacy");
		expect(result.preferences.maxWidgetLines).toBe(25);
		expect(result.preferences.collapseKey).toBe("alt+o");
		expect(result.preferences.guidance).toEqual({ promptSnippet: "Legacy snippet", promptGuidelines: ["one"] });
	});

	it("never takes the mode from the old file", async () => {
		write(legacyXdg(), legacy);
		expect((await loadPreferences()).preferences.mode).toBe("normal");
	});

	it("falls back to ~/.config/rpiv-todo when XDG points elsewhere", async () => {
		write(legacyHome(), legacy);
		expect((await loadPreferences()).preferences.maxWidgetLines).toBe(25);
	});

	it("prefers the new file over the old one", async () => {
		write(legacyXdg(), legacy);
		write(preferencesPath(), JSON.stringify({ maxWidgetLines: 7 }));
		const result = await loadPreferences();
		expect(result.source).toBe("current");
		expect(result.preferences.maxWidgetLines).toBe(7);
		expect(result.preferences.collapseKey).toBe("ctrl+shift+t");
	});

	it("does not mask a malformed new file by reading the old one", async () => {
		write(legacyXdg(), legacy);
		write(preferencesPath(), "{ not json");
		const result = await loadPreferences();
		expect(result.preferences.maxWidgetLines).toBe(12);
		expect(result.diagnostics.join("\n")).toMatch(/not valid JSON/);
	});

	it("leaves the old file byte-for-byte unchanged by load and save", async () => {
		write(legacyXdg(), legacy);
		const before = readFileSync(legacyXdg());
		await loadPreferences();
		expect((await savePreferences({ mode: "openspec" })).ok).toBe(true);
		expect(readFileSync(legacyXdg()).equals(before)).toBe(true);
	});

	it("does not write the old file's mode into the new file on save", async () => {
		write(legacyXdg(), legacy);
		await savePreferences({ maxWidgetLines: 30 });
		const stored = JSON.parse(readFileSync(preferencesPath(), "utf-8"));
		expect(stored.mode).toBeUndefined();
		expect(getPreferences().mode).toBe("normal");
	});

	it("carries migrated display preferences into the new file on first save", async () => {
		write(legacyXdg(), legacy);
		await refreshPreferences();
		await savePreferences({ mode: "openspec" });
		const stored = JSON.parse(readFileSync(preferencesPath(), "utf-8"));
		expect(stored).toMatchObject({ mode: "openspec", maxWidgetLines: 25, collapseKey: "alt+o" });
	});
});

describe("invalid preferences", () => {
	it("rejects an unknown mode with a diagnostic", async () => {
		write(preferencesPath(), JSON.stringify({ mode: "sync-everything" }));
		const result = await loadPreferences();
		expect(result.preferences.mode).toBe("normal");
		expect(result.diagnostics.join("\n")).toMatch(/mode/);
	});

	it("falls back for bad line budgets", async () => {
		for (const bad of [2, -1, "20", null, Number.POSITIVE_INFINITY, Number.NaN]) {
			write(preferencesPath(), JSON.stringify({ maxWidgetLines: bad }));
			expect((await loadPreferences()).preferences.maxWidgetLines).toBe(12);
		}
	});

	it("accepts the smallest valid budget, 3", async () => {
		write(preferencesPath(), JSON.stringify({ maxWidgetLines: 3 }));
		expect((await loadPreferences()).preferences.maxWidgetLines).toBe(3);
	});

	it("falls back for bad collapse keys, keeps the off sentinel, and lowercases valid keys", async () => {
		const cases: Array<[unknown, string]> = [
			["ctr+]", "ctrl+shift+t"],
			["", "ctrl+shift+t"],
			["   ", "ctrl+shift+t"],
			[5, "ctrl+shift+t"],
			["off", "off"],
			[" OFF ", "off"],
			["Alt+O", "alt+o"],
		];
		for (const [input, expected] of cases) {
			write(preferencesPath(), JSON.stringify({ collapseKey: input }));
			expect((await loadPreferences()).preferences.collapseKey).toBe(expected);
		}
	});

	it("drops malformed guidance fields and keeps valid ones", async () => {
		write(preferencesPath(), JSON.stringify({ guidance: { promptSnippet: "", promptGuidelines: ["ok", ""], description: "Desc" } }));
		expect((await loadPreferences()).preferences.guidance).toEqual({ description: "Desc" });
	});

	it("treats non-object JSON as defaults with a diagnostic", async () => {
		for (const text of ["[]", "null", '"text"', "42", ""]) {
			write(preferencesPath(), text);
			const result = await loadPreferences();
			expect(result.preferences).toEqual({ ...DEFAULT_PREFERENCES });
			expect(result.diagnostics.length).toBeGreaterThan(0);
		}
	});

	it("reports an unreadable file and still returns defaults", async () => {
		mkdirSync(preferencesPath(), { recursive: true }); // a directory where the file should be
		const result = await loadPreferences();
		expect(result.preferences).toEqual({ ...DEFAULT_PREFERENCES });
		expect(result.diagnostics.join("\n")).toMatch(/could not be read/);
	});
});

describe("saving", () => {
	it("creates the directory and writes owner-only JSON", async () => {
		expect(await savePreferences({ mode: "openspec" })).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(preferencesPath(), "utf-8"))).toMatchObject({ mode: "openspec" });
		expect(statSync(preferencesPath()).mode & 0o777).toBe(0o600);
	});

	it("merges into the stored file, keeping unrelated and unknown keys", async () => {
		write(preferencesPath(), JSON.stringify({ maxWidgetLines: 9, futureKey: { a: 1 } }));
		await savePreferences({ mode: "openspec" });
		expect(JSON.parse(readFileSync(preferencesPath(), "utf-8"))).toEqual({ maxWidgetLines: 9, futureKey: { a: 1 }, mode: "openspec" });
	});

	it("rejects an invalid patch without writing", async () => {
		const result = await savePreferences({ mode: "bogus" as never });
		expect(result.ok).toBe(false);
		expect(existsSync(preferencesPath())).toBe(false);
	});

	it("leaves no temporary file behind", async () => {
		await savePreferences({ mode: "openspec" });
		expect(readdirSync(join(xdg, "pi-todo"))).toEqual(["config.json"]);
	});

	it("keeps both updates when two saves overlap", async () => {
		await Promise.all([savePreferences({ mode: "openspec" }), savePreferences({ maxWidgetLines: 30 })]);
		expect(JSON.parse(readFileSync(preferencesPath(), "utf-8"))).toMatchObject({ mode: "openspec", maxWidgetLines: 30 });
	});
});

describe("failed saves", () => {
	it("refuses to overwrite a malformed file and leaves it untouched", async () => {
		write(preferencesPath(), "{ broken");
		const result = await savePreferences({ mode: "openspec" });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toMatch(/not valid JSON/);
		expect(readFileSync(preferencesPath(), "utf-8")).toBe("{ broken");
	});

	it.skipIf(process.getuid?.() === 0)("reports a failed write, keeps the cache unchanged, and leaves no file", async () => {
		mkdirSync(join(xdg, "pi-todo"), { recursive: true });
		chmodSync(join(xdg, "pi-todo"), 0o500); // directory exists, file absent, writing denied
		try {
			const result = await savePreferences({ mode: "openspec" });
			expect(result.ok).toBe(false);
			expect(result.ok === false && result.error).toMatch(/Could not save/);
			expect(getPreferences().mode).toBe("normal");
		} finally {
			chmodSync(join(xdg, "pi-todo"), 0o700);
		}
		expect(readdirSync(join(xdg, "pi-todo"))).toEqual([]);
	});

	it("reports a path blocked by a file, does not throw, and does not change the cache", async () => {
		write(join(xdg, "pi-todo"), "a file where the directory should be");
		await refreshPreferences();
		const result = await savePreferences({ mode: "openspec" });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toMatch(/\S/);
		expect(getPreferences().mode).toBe("normal");
	});

	it("refuses to save over a path that is a directory and leaves it alone", async () => {
		mkdirSync(preferencesPath(), { recursive: true });
		const result = await savePreferences({ mode: "openspec" });
		expect(result.ok).toBe(false);
		expect(readdirSync(join(xdg, "pi-todo"))).toEqual(["config.json"]);
		expect(statSync(preferencesPath()).isDirectory()).toBe(true);
	});

	it.skipIf(process.getuid?.() === 0)("reports a read-only directory and keeps the previous file intact", async () => {
		write(preferencesPath(), JSON.stringify({ maxWidgetLines: 9 }));
		const before = readFileSync(preferencesPath());
		chmodSync(join(xdg, "pi-todo"), 0o500);
		try {
			expect((await savePreferences({ mode: "openspec" })).ok).toBe(false);
		} finally {
			chmodSync(join(xdg, "pi-todo"), 0o700);
		}
		expect(readFileSync(preferencesPath()).equals(before)).toBe(true);
	});

	it("does not poison later saves after a failure", async () => {
		write(join(xdg, "pi-todo"), "blocker");
		expect((await savePreferences({ mode: "openspec" })).ok).toBe(false);
		rmSync(join(xdg, "pi-todo"));
		expect((await savePreferences({ mode: "openspec" })).ok).toBe(true);
	});
});

describe("cached reads used while rendering", () => {
	it("serves defaults before the first load, then the loaded values", async () => {
		write(preferencesPath(), JSON.stringify({ maxWidgetLines: 20, collapseKey: "alt+o" }));
		expect(getMaxWidgetLines()).toBe(12);
		expect(resolveCollapseKey()).toBe("ctrl+shift+t");
		await refreshPreferences();
		expect(getMaxWidgetLines()).toBe(20);
		expect(resolveCollapseKey()).toBe("alt+o");
	});

	it("does no file access when reading the cache", async () => {
		write(preferencesPath(), JSON.stringify({ maxWidgetLines: 20 }));
		await refreshPreferences();
		rmSync(preferencesPath());
		expect(getMaxWidgetLines()).toBe(20);
	});

	it("updates the cache only after a successful save", async () => {
		await savePreferences({ maxWidgetLines: 30 });
		expect(getMaxWidgetLines()).toBe(30);
	});

	it("returns a copy so callers cannot change the cache", async () => {
		await refreshPreferences();
		(getPreferences() as { mode: string }).mode = "openspec";
		expect(getPreferences().mode).toBe("normal");
	});
});
