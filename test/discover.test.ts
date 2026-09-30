import { describe, expect, it } from "vitest";
import { createDiscovery } from "../src/openspec/discover.js";
import type { ExecResult } from "../src/openspec/exec.js";

const ROOT = "/work/project";
const CWD = "/work/project/sub";

const ok = (json: unknown): ExecResult => ({ ok: true, json, stderr: "" });
const fail = (kind: any, message: string): ExecResult => ({ ok: false, kind, message });

const context = (path = ROOT, source = "nearest") => ok({ root: { path, source, role: "openspec_root" }, members: [], status: [] });
const list = (...names: string[]) => ok({ changes: names.map((name) => ({ name, completedTasks: 0, totalTasks: 3, status: "in-progress" })) });
const status = (name: string, over: Record<string, unknown> = {}, tasks?: string[], rootPath = ROOT) =>
	ok({
		changeName: name,
		schemaName: "spec-driven",
		changeRoot: `${ROOT}/openspec/changes/${name}`,
		artifactPaths: { tasks: { existingOutputPaths: tasks ?? [`${ROOT}/openspec/changes/${name}/tasks.md`] } },
		root: { path: rootPath, source: "nearest" },
		...over,
	});

type Handler = (args: readonly string[]) => ExecResult | Promise<ExecResult>;

/** Canned runner: records every call and answers by the first argument. */
function runner(handlers: { context?: Handler; list?: Handler; status?: Handler }) {
	const calls: Array<{ args: readonly string[]; cwd: string; signal?: AbortSignal }> = [];
	let active = 0;
	let peak = 0;
	const run = async (args: readonly string[], options: { cwd: string; signal?: AbortSignal }) => {
		calls.push({ args, cwd: options.cwd, signal: options.signal });
		const handler = handlers[args[0] as keyof typeof handlers];
		if (!handler) return fail("exit", `unexpected command ${args[0]}`);
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 5));
		try {
			return await handler(args);
		} finally {
			active--;
		}
	};
	return { run, calls, peak: () => peak };
}

describe("root and change discovery", () => {
	it("returns the CLI root, its source, and each change with its support state", async () => {
		const r = runner({
			context: () => context(ROOT, "declared"),
			list: () => list("add-thing", "custom-flow"),
			status: (args) => (args[2] === "custom-flow" ? status("custom-flow", { schemaName: "custom" }) : status("add-thing")),
		});
		const result = await createDiscovery(r.run as any)(CWD);
		expect(result).toEqual({
			ok: true,
			root: ROOT,
			rootSource: "declared",
			changes: [
				{ name: "add-thing", supported: true },
				{ name: "custom-flow", supported: false, reason: "schema 'custom' is not supported (spec-driven only)" },
			],
		});
	});

	it("runs each command with argument arrays in the session directory", async () => {
		const r = runner({ context: () => context(), list: () => list("a"), status: () => status("a") });
		const controller = new AbortController();
		await createDiscovery(r.run as any)(CWD, controller.signal);
		expect(r.calls.map((c) => c.args)).toEqual([["context", "--json"], ["list", "--json"], ["status", "--change", "a", "--json"]]);
		expect(r.calls.every((c) => c.cwd === CWD && c.signal === controller.signal)).toBe(true);
	});

	it("preserves a store root exactly as the CLI reports it", async () => {
		const r = runner({ context: () => context("/stores/team", "store"), list: () => list("a"), status: () => status("a", { changeRoot: "/stores/team/openspec/changes/a", root: { path: "/stores/team", source: "store" } }, ["/stores/team/openspec/changes/a/tasks.md"], "/stores/team") });
		const result = await createDiscovery(r.run as any)(CWD);
		expect(result).toMatchObject({ ok: true, root: "/stores/team", rootSource: "store", changes: [{ name: "a", supported: true }] });
	});

	it("reports no changes as an empty list", async () => {
		const r = runner({ context: () => context(), list: () => list() });
		expect(await createDiscovery(r.run as any)(CWD)).toMatchObject({ ok: true, changes: [] });
		expect(r.calls).toHaveLength(2);
	});
});

describe("failures before any change is listed", () => {
	it("reports a failed context call", async () => {
		const r = runner({ context: () => fail("spawn", "Could not run openspec: ENOENT") });
		const result = await createDiscovery(r.run as any)(CWD);
		expect(result).toEqual({ ok: false, error: "Could not run openspec: ENOENT" });
		expect(r.calls).toHaveLength(1);
	});

	it("rejects malformed context output", async () => {
		for (const bad of [null, [], {}, { root: null }, { root: { path: 5 } }, { root: { path: "relative/dir", source: "nearest" } }, { root: { path: ROOT } }, { root: { path: ROOT, source: "" } }]) {
			const r = runner({ context: () => ok(bad) });
			const result = await createDiscovery(r.run as any)(CWD);
			expect(result.ok).toBe(false);
			expect(!result.ok && result.error).toMatch(/context/i);
			expect(r.calls).toHaveLength(1);
		}
	});

	it("rejects malformed list output", async () => {
		for (const bad of [null, {}, { changes: "x" }, { changes: [{}] }, { changes: [{ name: 5 }] }]) {
			const r = runner({ context: () => context(), list: () => ok(bad) });
			const result = await createDiscovery(r.run as any)(CWD);
			expect(result.ok).toBe(false);
			expect(!result.ok && result.error).toMatch(/list/i);
		}
	});

	it("reports a failed list call", async () => {
		const r = runner({ context: () => context(), list: () => fail("timeout", "OpenSpec command timed out after 15000 ms") });
		expect(await createDiscovery(r.run as any)(CWD)).toEqual({ ok: false, error: "OpenSpec command timed out after 15000 ms" });
	});
});

describe("supported-change checks", () => {
	async function one(statusResult: ExecResult, rootOfContext = ROOT) {
		const r = runner({ context: () => context(rootOfContext), list: () => list("a"), status: () => statusResult });
		const result = await createDiscovery(r.run as any)(CWD);
		return result.ok ? result.changes[0] : undefined;
	}

	it("accepts a spec-driven change with one tracked task file", async () => {
		expect(await one(status("a"))).toEqual({ name: "a", supported: true });
	});

	it("rejects other schemas", async () => {
		expect(await one(status("a", { schemaName: "custom" }))).toMatchObject({ supported: false, reason: expect.stringContaining("'custom'") });
	});

	it("rejects a change with no tracked task file yet", async () => {
		expect(await one(status("a", {}, []))).toMatchObject({ supported: false, reason: expect.stringMatching(/no tracked task file/) });
	});

	it("rejects more than one tracked task file", async () => {
		const two = [`${ROOT}/openspec/changes/a/tasks.md`, `${ROOT}/openspec/changes/a/more/tasks.md`];
		expect(await one(status("a", {}, two))).toMatchObject({ supported: false, reason: expect.stringMatching(/more than one/) });
	});

	it("rejects a task file outside the change directory", async () => {
		expect(await one(status("a", {}, ["/etc/tasks.md"]))).toMatchObject({ supported: false, reason: expect.stringMatching(/outside/) });
		expect(await one(status("a", {}, [`${ROOT}/openspec/changes/a/../b/tasks.md`]))).toMatchObject({ supported: false });
	});

	it("rejects a task path or change directory that equals its parent", async () => {
		expect(await one(status("a", {}, [`${ROOT}/openspec/changes/a`]))).toMatchObject({ supported: false, reason: expect.stringMatching(/outside the change directory/) });
		expect(await one(status("a", { changeRoot: ROOT }, [`${ROOT}/tasks.md`]))).toMatchObject({ supported: false, reason: expect.stringMatching(/outside the planning root/) });
	});

	it("rejects a relative task path", async () => {
		expect(await one(status("a", {}, ["tasks.md"]))).toMatchObject({ supported: false });
	});

	it("rejects a change whose directory is outside the planning root", async () => {
		const moved = status("a", { changeRoot: "/elsewhere/changes/a" }, ["/elsewhere/changes/a/tasks.md"]);
		expect(await one(moved)).toMatchObject({ supported: false, reason: expect.stringMatching(/outside the planning root/) });
	});

	it("rejects a change resolved against a different root than the context call", async () => {
		expect(await one(status("a", {}, undefined, "/other/root"))).toMatchObject({ supported: false, reason: expect.stringMatching(/root mismatch/) });
	});

	it("marks one failed status call unsupported without hiding the others", async () => {
		const r = runner({
			context: () => context(),
			list: () => list("good", "bad"),
			status: (args) => (args[2] === "bad" ? fail("exit", "OpenSpec exited with code 1: nope") : status("good")),
		});
		const result = await createDiscovery(r.run as any)(CWD);
		expect(result).toMatchObject({ ok: true, changes: [{ name: "good", supported: true }, { name: "bad", supported: false, reason: "status failed: OpenSpec exited with code 1: nope" }] });
	});

	it("rejects malformed status output", async () => {
		for (const bad of [null, {}, { schemaName: "spec-driven" }, { schemaName: "spec-driven", changeRoot: 5 }, { schemaName: "spec-driven", changeRoot: `${ROOT}/openspec/changes/a`, artifactPaths: {} }]) {
			expect(await one(ok(bad))).toMatchObject({ supported: false });
		}
	});
});

describe("argument safety", () => {
	it("never passes an unsafe change name to the CLI", async () => {
		const names = ["--store", "-x", "../escape", "a/b", "a b", "", ".hidden", "ok-name"];
		const r = runner({ context: () => context(), list: () => list(...names), status: (args) => status(args[2]) });
		const result = await createDiscovery(r.run as any)(CWD);
		const asked = r.calls.filter((c) => c.args[0] === "status").map((c) => c.args[2]);
		expect(asked).toEqual(["ok-name"]);
		expect(result.ok && result.changes.filter((c) => !c.supported).map((c) => c.reason)).toEqual(Array(7).fill("unsafe change name"));
		expect(result.ok && result.changes.map((c) => c.name)).toEqual(names);
	});
});

describe("cancellation and concurrency", () => {
	it("stops when the signal aborts and reports cancellation", async () => {
		const controller = new AbortController();
		const r = runner({ context: () => context(), list: () => list("a", "b", "c", "d", "e", "f", "g", "h"), status: (args) => { if (args[2] === "a") controller.abort(); return status(args[2]); } });
		const result = await createDiscovery(r.run as any)(CWD, controller.signal);
		expect(result).toEqual({ ok: false, error: "Cancelled" });
		expect(r.calls.filter((c) => c.args[0] === "status").length).toBeLessThan(8);
	});

	it("reports a status call that was cancelled as a cancelled discovery", async () => {
		const r = runner({ context: () => context(), list: () => list("a", "b"), status: () => fail("cancelled", "OpenSpec command cancelled") });
		expect(await createDiscovery(r.run as any)(CWD)).toEqual({ ok: false, error: "OpenSpec command cancelled" });
	});

	it("passes through a cancelled run", async () => {
		const r = runner({ context: () => fail("cancelled", "OpenSpec command cancelled") });
		expect(await createDiscovery(r.run as any)(CWD)).toEqual({ ok: false, error: "OpenSpec command cancelled" });
	});

	it("checks at most four changes at a time and keeps list order", async () => {
		const names = Array.from({ length: 10 }, (_, i) => `change-${i}`);
		const r = runner({ context: () => context(), list: () => list(...names), status: (args) => status(args[2]) });
		const result = await createDiscovery(r.run as any)(CWD);
		expect(r.peak()).toBeLessThanOrEqual(4);
		expect(result.ok && result.changes.map((c) => c.name)).toEqual(names);
	});
});
