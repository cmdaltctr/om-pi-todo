/**
 * Global preferences in `<config dir>/pi-todo/config.json`.
 *
 * All file access is asynchronous. Render code and tool guidance read the
 * in-memory cache through `getPreferences()`, `getMaxWidgetLines()` and
 * `resolveCollapseKey()`, which never touch the disk. The cache is filled by
 * `refreshPreferences()` (at extension start) and updated by a successful
 * `savePreferences()`.
 *
 * The old `rpiv-todo` config file is read as a display-preference fallback when
 * the new file is absent. It is never written and never supplies the mode.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	DEFAULT_MAX_WIDGET_LINES,
	type GuidanceFields,
	isValidCollapseKeySpec,
	MIN_WIDGET_LINES,
	validateGuidanceFields,
} from "./config.js";

export type TodoMode = "normal" | "openspec";
const MODES: readonly TodoMode[] = ["normal", "openspec"];

export interface Preferences {
	mode: TodoMode;
	maxWidgetLines: number;
	collapseKey: string;
	guidance?: GuidanceFields;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
	mode: "normal",
	maxWidgetLines: DEFAULT_MAX_WIDGET_LINES,
	collapseKey: DEFAULT_COLLAPSE_KEY,
});

export type PreferencesSource = "default" | "current" | "legacy";

export interface LoadResult {
	preferences: Preferences;
	source: PreferencesSource;
	diagnostics: string[];
}

export type SaveResult = { ok: true } | { ok: false; error: string };

type Raw = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `$XDG_CONFIG_HOME` when it is an absolute path, else `~/.config`. */
function configDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	return xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
}

/** Absolute path of the preferences file. */
export function preferencesPath(): string {
	return join(configDir(), "pi-todo", "config.json");
}

/** Old `rpiv-todo` config locations: the XDG-aware one first, then `~/.config`. */
function legacyPaths(): string[] {
	const paths = [join(configDir(), "rpiv-todo", "config.json"), join(homedir(), ".config", "rpiv-todo", "config.json")];
	return [...new Set(paths)];
}

// ---------------------------------------------------------------------------
// Reading and validating
// ---------------------------------------------------------------------------

type FileRead = { kind: "absent" } | { kind: "ok"; value: Raw } | { kind: "bad"; problem: string; unreadable: boolean };

/** Read one JSON object file without throwing. */
async function readObject(path: string): Promise<FileRead> {
	let text: string;
	try {
		// nosemgrep: AIK_ts_generic_path_traversal -- path is resolved and checked inside the confirmed OpenSpec root (see docs/VERIFICATION.md)
		text = await readFile(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		return { kind: "bad", problem: `${path} could not be read: ${(error as Error).message}`, unreadable: true };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "bad", problem: `${path} is not valid JSON; using defaults`, unreadable: false };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { kind: "bad", problem: `${path} must contain a JSON object; using defaults`, unreadable: false };
	}
	return { kind: "ok", value: parsed as Raw };
}

function validLineBudget(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= MIN_WIDGET_LINES;
}

/** Lower-cased valid key spec, the `off` sentinel, or undefined when invalid. */
export function normaliseCollapseKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim().toLowerCase();
	if (key === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(key) ? key : undefined;
}

/** Turn a raw stored object into valid preferences, noting what was replaced. */
function normalise(raw: Raw, allowMode: boolean): { preferences: Preferences; diagnostics: string[] } {
	const diagnostics: string[] = [];
	const preferences: Preferences = { ...DEFAULT_PREFERENCES };

	if (allowMode && raw.mode !== undefined) {
		if (MODES.includes(raw.mode as TodoMode)) preferences.mode = raw.mode as TodoMode;
		else diagnostics.push(`Ignored invalid mode ${JSON.stringify(raw.mode)}; using "normal"`);
	}
	if (raw.maxWidgetLines !== undefined) {
		if (validLineBudget(raw.maxWidgetLines)) preferences.maxWidgetLines = raw.maxWidgetLines;
		else diagnostics.push(`Ignored invalid maxWidgetLines; using ${DEFAULT_MAX_WIDGET_LINES}`);
	}
	if (raw.collapseKey !== undefined) {
		const key = normaliseCollapseKey(raw.collapseKey);
		if (key !== undefined) preferences.collapseKey = key;
		else diagnostics.push(`Ignored invalid collapseKey; using "${DEFAULT_COLLAPSE_KEY}"`);
	}
	const guidance = validateGuidanceFields(raw.guidance);
	if (Object.keys(guidance).length > 0) preferences.guidance = guidance;
	return { preferences, diagnostics };
}

/** The display fields of an old config that are valid; the mode is never taken. */
function legacyDisplayFields(raw: Raw): Raw {
	const picked: Raw = {};
	if (validLineBudget(raw.maxWidgetLines)) picked.maxWidgetLines = raw.maxWidgetLines;
	const key = normaliseCollapseKey(raw.collapseKey);
	if (key !== undefined) picked.collapseKey = key;
	if (Object.keys(validateGuidanceFields(raw.guidance)).length > 0) picked.guidance = raw.guidance;
	return picked;
}

/** First old config that exists, as display fields plus any problem found. */
async function readLegacy(): Promise<{ fields: Raw; diagnostics: string[] } | undefined> {
	for (const path of legacyPaths()) {
		const file = await readObject(path);
		if (file.kind === "absent") continue;
		if (file.kind === "bad") return { fields: {}, diagnostics: [file.problem] };
		return { fields: legacyDisplayFields(file.value), diagnostics: [] };
	}
	return undefined;
}

/** Load preferences without touching the cache. Never throws. */
export async function loadPreferences(): Promise<LoadResult> {
	const current = await readObject(preferencesPath());
	if (current.kind === "ok") {
		const { preferences, diagnostics } = normalise(current.value, true);
		return { preferences, source: "current", diagnostics };
	}
	if (current.kind === "bad") {
		return {
			preferences: { ...DEFAULT_PREFERENCES },
			source: current.unreadable ? "default" : "current",
			diagnostics: [current.problem],
		};
	}
	const legacy = await readLegacy();
	if (!legacy) return { preferences: { ...DEFAULT_PREFERENCES }, source: "default", diagnostics: [] };
	const { preferences, diagnostics } = normalise(legacy.fields, false);
	return {
		preferences,
		source: legacy.diagnostics.length ? "default" : "legacy",
		diagnostics: [...legacy.diagnostics, ...diagnostics],
	};
}

// ---------------------------------------------------------------------------
// Cache used by render code
// ---------------------------------------------------------------------------

let cache: Preferences = { ...DEFAULT_PREFERENCES };

function copy(preferences: Preferences): Preferences {
	const result: Preferences = { ...preferences };
	if (preferences.guidance) {
		result.guidance = { ...preferences.guidance };
		if (preferences.guidance.promptGuidelines)
			result.guidance.promptGuidelines = [...preferences.guidance.promptGuidelines];
	}
	return result;
}

/** Current cached preferences. Returns a copy and does no file access. */
export function getPreferences(): Preferences {
	return copy(cache);
}

/** Reload the cache from disk. */
export async function refreshPreferences(): Promise<LoadResult> {
	const result = await loadPreferences();
	cache = copy(result.preferences);
	return result;
}

/** Forget cached values. Used by tests. */
export function resetPreferencesCache(): void {
	cache = { ...DEFAULT_PREFERENCES };
}

/** Content-row budget for the overlay, read from the cache on every render. */
export function getMaxWidgetLines(): number {
	return cache.maxWidgetLines;
}

/** Collapse/expand key spec (or `off`), read from the cache. */
export function resolveCollapseKey(): string {
	return cache.collapseKey;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export type PreferencesPatch = Partial<Pick<Preferences, "mode" | "maxWidgetLines" | "collapseKey" | "guidance">>;

function checkPatch(patch: PreferencesPatch): string | undefined {
	if (patch.mode !== undefined && !MODES.includes(patch.mode)) return `Invalid mode ${JSON.stringify(patch.mode)}`;
	if (patch.maxWidgetLines !== undefined && !validLineBudget(patch.maxWidgetLines))
		return `maxWidgetLines must be a number of at least ${MIN_WIDGET_LINES}`;
	if (patch.collapseKey !== undefined && normaliseCollapseKey(patch.collapseKey) === undefined)
		return "Invalid collapseKey";
	return undefined;
}

/** Saves run one at a time so overlapping read-merge-write cycles keep both updates. */
let saveQueue: Promise<unknown> = Promise.resolve();

async function writeAtomically(path: string, data: Raw): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		await chmod(temporary, 0o600).catch(() => undefined);
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function saveNow(patch: PreferencesPatch): Promise<SaveResult> {
	const invalid = checkPatch(patch);
	if (invalid) return { ok: false, error: invalid };

	const path = preferencesPath();
	const current = await readObject(path);
	if (current.kind === "bad") return { ok: false, error: `${current.problem}. Fix or remove the file, then retry.` };

	let base: Raw;
	if (current.kind === "ok") base = current.value;
	else base = (await readLegacy())?.fields ?? {};

	const next: Raw = { ...base };
	for (const [key, value] of Object.entries(patch))
		if (value !== undefined) next[key] = key === "collapseKey" ? normaliseCollapseKey(value) : value;

	try {
		await writeAtomically(path, next);
	} catch (error) {
		return { ok: false, error: `Could not save ${path}: ${(error as Error).message}` };
	}
	cache = copy(normalise(next, true).preferences);
	return { ok: true };
}

/** Merge `patch` into the preferences file and update the cache. Never throws. */
export function savePreferences(patch: PreferencesPatch): Promise<SaveResult> {
	const run = saveQueue.then(() => saveNow(patch));
	saveQueue = run.catch(() => undefined);
	return run;
}
