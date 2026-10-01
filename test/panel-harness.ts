import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { vi } from "vitest";
import extension from "../src/extension.js";
import type { RuntimeDeps } from "../src/sync/runtime.js";
import { makeFakeCli } from "./fake-cli.js";
import { callTool, createCtx, createHost, sessionEntry } from "./helpers.js";

/** A theme whose styling calls return the plain text. */
export const plainTheme: any = new Proxy({}, { get: (_t, key) => (key === "fg" || key === "bg" ? (_c: string, text: string) => text : (text: string) => text) });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BootOptions {
	paths?: { root: string; changeRoot: string; tasksPath: string };
	content?: string;
	runtime?: Partial<RuntimeDeps>;
}

/**
 * The real extension on a fake host. The widget host records registrations and render
 * requests, and can be told to fail, so panel scheduling and recovery are observable.
 */
export async function bootPanel(options: BootOptions = {}) {
	const { paths, content } = options;
	const cli = paths ? makeFakeCli({ root: paths.root, change: "a", tasksPath: paths.tasksPath, changeRoot: paths.changeRoot }) : undefined;
	if (paths && content !== undefined) writeFileSync(paths.tasksPath, content);
	const watches: Array<{ closed: boolean; fire: () => void }> = [];
	const renames = vi.fn();
	const host = createHost();
	const sent = { sendUserMessage: vi.fn(), sendMessage: vi.fn() };
	Object.assign(host.pi, sent);
	await extension(
		host.pi,
		undefined,
		async () => ({ ok: true, root: paths?.root ?? "/none", rootSource: "nearest", changes: [{ name: "a", supported: true }] }),
		{
			...(cli ? { run: cli.run as any } : {}),
			watchDelayMs: 20,
			lock: { waitMs: 200, pollMs: 10 },
			watch: (_f, onChange) => {
				const w = { closed: false, fire: onChange };
				watches.push(w);
				return { close: () => void (w.closed = true) };
			},
			fs: { rename: async (a: string, b: string) => { renames(); renameSync(a, b); } },
			...options.runtime,
		},
	);

	const widget = { failWith: undefined as Error | undefined, registrations: 0, unregistrations: 0, factory: undefined as any, rendered: undefined as any, tui: { requestRender: vi.fn() } };
	const notes: Array<{ message: string; type?: string }> = [];
	const ui = {
		setWidget: (_key: string, factory: unknown) => {
			if (widget.failWith && factory !== undefined) throw widget.failWith;
			if (factory === undefined) {
				widget.unregistrations++;
				widget.factory = undefined;
				widget.rendered = undefined;
			} else {
				widget.registrations++;
				widget.factory = factory;
				widget.rendered = (factory as (tui: unknown, theme: unknown) => unknown)(widget.tui, plainTheme);
			}
		},
		notify: (message: string, type?: string) => void notes.push({ message, type }),
		theme: plainTheme,
	};
	const bound = paths ? [sessionEntry({ mode: "openspec", binding: { root: paths.root, change: "a" } })] : [];
	const session = (id = "s1", branch: unknown[] = bound, extra: Record<string, unknown> = {}) => createCtx(id, branch, { hasUI: true, cwd: paths?.root ?? "/none", ui, ...extra });
	const fire = (event: string, ctx: unknown, payload: unknown = {}) => Promise.all((host.handlers.get(event) ?? []).map((h) => h(payload, ctx)));
	const render = (): string[] | undefined => (widget.rendered ? (widget.rendered.render(120) as string[]).filter((l) => l !== "") : undefined);
	const call = (ctx: unknown, params: Record<string, unknown>) => callTool(host, ctx, params);
	const command = (name: string, ctx: unknown, args = "") => host.commands.get(name).handler(args, ctx);
	const settle = async () => {
		await sleep(40);
		await sleep(40);
	};
	const disk = () => (paths ? readFileSync(paths.tasksPath) : Buffer.alloc(0));
	const renders = () => widget.tui.requestRender.mock.calls.length;
	return { host, cli, widget, notes, ui, session, fire, render, call, command, settle, disk, renders, renames, watches, sent };
}
