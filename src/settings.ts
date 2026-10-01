/**
 * `/todo-settings`: session mode, default mode, and display preferences.
 *
 * Every step is a dialog the user can cancel. A cancelled or declined step
 * leaves the session's mode, binding, tasks, and planning files as they were.
 * Enabling OpenSpec sync needs a chosen change and a confirmed planning root.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MIN_WIDGET_LINES } from "./config.js";
import type { ChangeDiscovery } from "./discovery.js";
import { getPreferences, normaliseCollapseKey, savePreferences, type TodoMode } from "./preferences.js";
import { describeSessionMode, getSessionMode, persistSessionMode } from "./session-mode.js";
import { sid } from "./state/store.js";

export const SETTINGS_COMMAND = "todo-settings";

const MODE_LABELS: Record<TodoMode, string> = { normal: "Normal", openspec: "OpenSpec sync" };
const MODE_OPTIONS = [MODE_LABELS.normal, MODE_LABELS.openspec];
const DONE = "Done";

type Ctx = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

/** Ask which mode; undefined when cancelled. */
async function pickMode(ctx: Ctx, title: string): Promise<TodoMode | undefined> {
	const choice = await ctx.ui.select(title, MODE_OPTIONS);
	if (choice === MODE_LABELS.normal) return "normal";
	if (choice === MODE_LABELS.openspec) return "openspec";
	return undefined;
}

/** Tell the user a save failed, or that it worked. */
async function saveAndReport(ctx: Ctx, patch: Parameters<typeof savePreferences>[0], success: string): Promise<void> {
	const result = await savePreferences(patch);
	if (result.ok) ctx.ui.notify(success, "info");
	else ctx.ui.notify(result.error, "error");
}

/** Called after a session's mode or binding changed, so sync can restart for it. */
export interface SettingsHooks {
	onModeChanged?(ctx: Ctx): void | Promise<void>;
}

async function chooseSessionMode(
	pi: ExtensionAPI,
	ctx: Ctx,
	discover: ChangeDiscovery,
	hooks: SettingsHooks,
): Promise<void> {
	const id = sid(ctx);
	const mode = await pickMode(ctx, "Session mode");
	if (mode === undefined) return;
	if (mode === "normal") {
		persistSessionMode(pi, id, { mode: "normal" });
		await hooks.onModeChanged?.(ctx);
		ctx.ui.notify("Normal mode. The OpenSpec task file was not changed.", "info");
		return;
	}

	const found = await discover(ctx.cwd);
	if (!found.ok) {
		ctx.ui.notify(`OpenSpec sync unavailable: ${found.error}`, "error");
		return;
	}
	if (found.changes.length === 0) {
		ctx.ui.notify(`No OpenSpec changes found in ${found.root}. Create one first, then retry.`, "warning");
		return;
	}

	const labels = new Map(
		found.changes.map((c) => [c.supported ? c.name : `${c.name} (unsupported: ${c.reason ?? "unknown reason"})`, c]),
	);
	const label = await ctx.ui.select(`Choose an OpenSpec change (root: ${found.root})`, [...labels.keys()]);
	const change = label === undefined ? undefined : labels.get(label);
	if (!change) return;
	if (!change.supported) {
		ctx.ui.notify(
			`Cannot bind ${change.name}: ${change.reason ?? "unsupported"}. Choose a supported spec-driven change.`,
			"warning",
		);
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Bind this session to an OpenSpec change?",
		`Change: ${change.name}\nPlanning root: ${found.root}${found.rootSource ? ` (${found.rootSource})` : ""}`,
	);
	if (!confirmed) return;
	persistSessionMode(pi, id, { mode: "openspec", binding: { root: found.root, change: change.name } });
	await hooks.onModeChanged?.(ctx);
	ctx.ui.notify(`OpenSpec sync enabled for ${change.name} (${found.root}).`, "info");
}

async function chooseDefaultMode(ctx: Ctx): Promise<void> {
	const mode = await pickMode(ctx, "Default mode for new sessions");
	if (mode === undefined) return;
	const extra = mode === "openspec" ? " New sessions start unbound until you choose a change with /todo-settings." : "";
	await saveAndReport(ctx, { mode }, `Default mode saved.${extra}`);
}

async function chooseLineBudget(ctx: Ctx): Promise<void> {
	const answer = await ctx.ui.input(
		`Panel line budget (minimum ${MIN_WIDGET_LINES})`,
		String(getPreferences().maxWidgetLines),
	);
	if (answer === undefined) return;
	const text = answer.trim();
	const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!Number.isSafeInteger(value) || value < MIN_WIDGET_LINES) {
		ctx.ui.notify(`Panel line budget must be a whole number of at least ${MIN_WIDGET_LINES}`, "error");
		return;
	}
	await saveAndReport(ctx, { maxWidgetLines: value }, "Panel line budget saved.");
}

async function chooseCollapseKey(ctx: Ctx): Promise<void> {
	const answer = await ctx.ui.input("Collapse key (for example ctrl+shift+t, or off)", getPreferences().collapseKey);
	if (answer === undefined) return;
	const key = normaliseCollapseKey(answer);
	if (key === undefined) {
		ctx.ui.notify("Invalid collapse key. Use modifier+key such as ctrl+shift+t, or off.", "error");
		return;
	}
	await saveAndReport(ctx, { collapseKey: key }, "Collapse key saved. Run /reload to apply it.");
}

export function registerTodoSettingsCommand(
	pi: ExtensionAPI,
	discover: ChangeDiscovery,
	hooks: SettingsHooks = {},
): void {
	pi.registerCommand(SETTINGS_COMMAND, {
		description: "Choose the todo mode for this session and set todo defaults",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todo-settings requires interactive mode", "error");
				return;
			}
			for (;;) {
				const prefs = getPreferences();
				const items = [
					`Session mode: ${describeSessionMode(getSessionMode(sid(ctx)))}`,
					`Default mode for new sessions: ${MODE_LABELS[prefs.mode]}`,
					`Panel line budget: ${prefs.maxWidgetLines}`,
					`Collapse key: ${prefs.collapseKey}`,
					DONE,
				];
				const choice = await ctx.ui.select("Todo settings", items);
				if (choice === undefined || choice === DONE) return;
				switch (items.indexOf(choice)) {
					case 0:
						await chooseSessionMode(pi, ctx, discover, hooks);
						break;
					case 1:
						await chooseDefaultMode(ctx);
						break;
					case 2:
						await chooseLineBudget(ctx);
						break;
					case 3:
						await chooseCollapseKey(ctx);
						break;
				}
			}
		},
	});
}
