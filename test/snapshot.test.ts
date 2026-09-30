import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecResult } from "../src/openspec/exec.js";
import { createSnapshotProvider } from "../src/openspec/snapshot.js";
import { listTasks, scanTasks } from "../src/openspec/tasks.js";
import type { SessionMode } from "../src/session-mode.js";
import type { Task } from "../src/tool/types.js";

let root = "";
let tasksPath = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-todo-snap-"));
	mkdirSync(join(root, "openspec", "changes", "a"), { recursive: true });
	tasksPath = join(root, "openspec", "changes", "a", "tasks.md");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const md = (...lines: string[]) => `${lines.join("\n")}\n`;
const ok = (json: unknown): ExecResult => ({ ok: true, json, stderr: "" });
const fail = (kind: any, message: string): ExecResult => ({ ok: false, kind, message });
const bound = (): SessionMode => ({ mode: "openspec", binding: { root, change: "a" } });

function statusJson(over: Record<string, unknown> = {}) {
	return {
		changeName: "a",
		schemaName: "spec-driven",
		changeRoot: join(root, "openspec", "changes", "a"),
		isPlanningComplete: true,
		artifacts: [{ id: "proposal", status: "done" }, { id: "tasks", status: "done" }],
		artifactPaths: { tasks: { existingOutputPaths: [tasksPath] } },
		root: { path: root, source: "nearest" },
		...over,
	};
}

/** What `instructions apply --json` reports for the file as it is on disk right now. */
async function applyJson(over: Record<string, unknown> = {}) {
	const content = await readFile(tasksPath, "utf-8");
	const scanned = scanTasks(content);
	const done = scanned.filter((t) => t.done).length;
	return {
		changeName: "a",
		schemaName: "spec-driven",
		state: done === scanned.length && scanned.length > 0 ? "all_done" : "ready",
		progress: { total: scanned.length, complete: done, remaining: scanned.length - done },
		tasks: listTasks(scanned).map((t) => ({ id: t.rowId, description: t.description, done: t.done })),
		instruction: "Read context files, work through pending tasks, mark complete as you go.",
		root: { path: root, source: "nearest" },
		...over,
	};
}

interface Harness {
	calls: Array<{ args: readonly string[]; cwd: string; signal?: AbortSignal }>;
	status: (args: readonly string[]) => ExecResult | Promise<ExecResult>;
	apply: (args: readonly string[]) => ExecResult | Promise<ExecResult>;
}

function setup(ordinary: Task[] = [], mode: (sessionId: string) => SessionMode = bound, readFileImpl = readFile as any) {
	const h: Harness = {
		calls: [],
		status: () => ok(statusJson()),
		apply: async () => ok(await applyJson()),
	};
	const run = async (args: readonly string[], options: { cwd: string; signal?: AbortSignal }) => {
		h.calls.push({ args, cwd: options.cwd, signal: options.signal });
		return args[0] === "status" ? h.status(args) : args[0] === "instructions" ? h.apply(args) : fail("exit", `unexpected ${args[0]}`);
	};
	const provider = createSnapshotProvider({ run: run as any, readFile: readFileImpl }, { getMode: (id) => mode(id), getOrdinary: () => ordinary });
	return { h, provider, ordinary };
}

const task = (id: number, status: Task["status"], subject = `T${id}`): Task => ({ id, subject, status });

describe("a fresh snapshot", () => {
	it("reads status then apply from the bound root with argument arrays", async () => {
		writeFileSync(tasksPath, md("- [x] 1.1 Done", "- [ ] 1.2 Open"));
		const { h, provider } = setup();
		const controller = new AbortController();
		await provider.refresh("s1", { signal: controller.signal });
		expect(h.calls.map((c) => c.args)).toEqual([["status", "--change", "a", "--json"], ["instructions", "apply", "--change", "a", "--json"]]);
		expect(h.calls.every((c) => c.cwd === root && c.signal === controller.signal)).toBe(true);
	});

	it("combines mode, binding, linked rows, revision, and freshness", async () => {
		writeFileSync(tasksPath, md("- [x] 1.1 Done", "- [ ] 1.2 Open"));
		const { provider } = setup();
		const snap = await provider.refresh("s1");
		expect(snap).toMatchObject({ mode: "openspec", binding: { root, change: "a" }, freshness: "fresh", writable: true, needsReselect: false, file: tasksPath, schema: "spec-driven", diagnostics: [] });
		expect(snap.linked.map((r) => [r.id, r.description, r.done])).toEqual([[1, "1.1 Done", true], [2, "1.2 Open", false]]);
		expect(snap.revision).toMatch(/^[0-9a-f]{16}$/);
		expect(provider.getSnapshot("s1")).toEqual(snap);
	});

	it("keeps planning readiness, implementation progress, ordinary tasks, and activity as separate values", async () => {
		writeFileSync(tasksPath, md("- [x] A", "- [ ] B", "- [ ] C"));
		const ordinary = [task(1, "completed"), task(2, "in_progress"), task(3, "pending"), task(4, "pending")];
		const { provider } = setup(ordinary);
		const first = await provider.refresh("s1");
		expect(first.planning).toEqual({ isComplete: true, artifacts: [{ id: "proposal", status: "done" }, { id: "tasks", status: "done" }] });
		expect(first.implementation).toMatchObject({ state: "ready", total: 3, complete: 1, remaining: 2 });
		expect(first.ordinaryCounts).toEqual({ total: 4, pending: 2, inProgress: 1, completed: 1 });
		expect(first.ordinary).toEqual(ordinary);

		// Ordinary tasks and session activity change nothing about OpenSpec's numbers.
		const more = setup([...ordinary, task(5, "completed"), task(6, "completed")]);
		const second = await more.provider.refresh("s1");
		expect(second.implementation).toEqual(first.implementation);
		expect(second.planning).toEqual(first.planning);
		expect(second.ordinaryCounts.completed).toBe(3);
	});

	it("does not let planning completeness stand in for implementation progress", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { provider } = setup();
		const snap = await provider.refresh("s1");
		expect(snap.planning!.isComplete).toBe(true);
		expect(snap.implementation!.remaining).toBe(1);
		expect(snap.implementation!.state).not.toBe("all_done");
	});

	it("accepts the older isComplete name for planning readiness", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		const { isPlanningComplete: _drop, ...older } = statusJson({ isComplete: false });
		h.status = () => ok(older);
		expect((await provider.refresh("s1")).planning!.isComplete).toBe(false);
	});

	it("reads ordinary tasks at call time so the view never lags the session list", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { provider, ordinary } = setup();
		await provider.refresh("s1");
		ordinary.push(task(1, "pending"));
		expect(provider.getSnapshot("s1").ordinaryCounts.total).toBe(1);
	});

	it("surfaces CLI instruction, context and guidance as bounded notes", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		h.apply = async () => ok(await applyJson({ context: "Use British English.", operationGuidance: ["Run tests first"], instruction: "x".repeat(10_000) }));
		const snap = await provider.refresh("s1");
		expect(snap.notes.join("\n")).toContain("Use British English.");
		expect(snap.notes.join("\n")).toContain("Run tests first");
		expect(snap.notes.every((n) => n.length <= 2000)).toBe(true);
		expect(snap.implementation).toMatchObject({ total: 1, remaining: 1 });
	});
});

describe("modes without a binding", () => {
	it("does no OpenSpec work in normal mode", async () => {
		const { h, provider } = setup([task(1, "pending")], () => ({ mode: "normal" }));
		const snap = await provider.refresh("s1");
		expect(h.calls).toEqual([]);
		expect(snap).toMatchObject({ mode: "normal", freshness: "inactive", linked: [], writable: false });
		expect(snap.ordinaryCounts.total).toBe(1);
	});

	it("does no OpenSpec work and asks for a change when sync has no binding", async () => {
		const { h, provider } = setup([], () => ({ mode: "openspec" }));
		const snap = await provider.refresh("s1");
		expect(h.calls).toEqual([]);
		expect(snap).toMatchObject({ freshness: "unbound", writable: false, needsReselect: true });
		expect(snap.diagnostics.join(" ")).toMatch(/no change is chosen/);
	});

	it("reports an unread session as unavailable rather than empty and fresh", () => {
		const { provider } = setup();
		expect(provider.getSnapshot("never-read")).toMatchObject({ freshness: "unavailable", writable: false, linked: [] });
	});
});

describe("failures keep the last good view visibly stale", () => {
	it("marks the last good rows stale and read-only after a failed refresh, then recovers", async () => {
		writeFileSync(tasksPath, md("- [ ] A", "- [ ] B"));
		const { h, provider } = setup();
		const good = await provider.refresh("s1");
		h.apply = () => fail("timeout", "OpenSpec command timed out after 15000 ms");
		const stale = await provider.refresh("s1");
		expect(stale).toMatchObject({ freshness: "stale", writable: false, revision: good.revision });
		expect(stale.linked.map((r) => r.id)).toEqual([1, 2]);
		expect(stale.diagnostics.join(" ")).toContain("timed out");
		h.apply = async () => ok(await applyJson());
		expect(await provider.refresh("s1")).toMatchObject({ freshness: "fresh", writable: true, diagnostics: [] });
	});

	it("reports unavailable with no rows when nothing has ever been read", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		h.status = () => fail("spawn", "Could not run openspec: ENOENT");
		expect(await provider.refresh("s1")).toMatchObject({ freshness: "unavailable", writable: false, linked: [] });
	});

	it("treats malformed CLI output as a failure", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		for (const [which, bad] of [["status", null], ["status", { schemaName: 5 }], ["apply", null], ["apply", { tasks: "x" }], ["apply", { state: "ready", progress: { total: 1, complete: 0, remaining: 1 }, tasks: [{ id: "1", description: "x", done: "yes" }] }], ["apply", { state: "ready", progress: { total: 1, complete: 0, remaining: 1 }, tasks: [{}] }], ["apply", { state: "ready", progress: { total: 1, complete: 0, remaining: 1 }, tasks: [5] }], ["apply", { state: "ready", progress: { total: "1", complete: 0, remaining: 1 }, tasks: [] }], ["apply", { state: "weird", progress: { total: 0, complete: 0, remaining: 0 }, tasks: [] }]] as const) {
			const { h, provider } = setup();
			h[which] = async () => ok(bad);
			expect((await provider.refresh("s1")).freshness).toBe("unavailable");
		}
	});

	it("never throws, even when the runner does", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		h.status = () => {
			throw new Error("runner exploded");
		};
		const snap = await provider.refresh("s1");
		expect(snap.freshness).toBe("unavailable");
		expect(snap.diagnostics.join(" ")).toContain("runner exploded");
	});

	it("reports a missing task file", async () => {
		const { provider } = setup();
		const snap = await provider.refresh("s1");
		expect(snap.freshness).toBe("unavailable");
		expect(snap.diagnostics.join(" ")).toMatch(/task file/i);
	});

	it("reports a cancelled refresh without committing anything", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		const good = await provider.refresh("s1");
		h.apply = () => fail("cancelled", "OpenSpec command cancelled");
		const snap = await provider.refresh("s1");
		expect(snap).toMatchObject({ freshness: "stale", revision: good.revision });
		expect(snap.diagnostics.join(" ")).toContain("cancelled");
	});
});

describe("a binding that no longer holds", () => {
	it("asks for a new selection when the change is gone", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		await provider.refresh("s1");
		h.status = () => fail("exit", "OpenSpec exited with code 1: Change 'a' not found");
		const snap = await provider.refresh("s1");
		expect(snap).toMatchObject({ freshness: "stale", writable: false, needsReselect: true });
		expect(snap.diagnostics.join(" ")).toMatch(/moved or archived/);
	});

	it("suspends instead of following a different planning root", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		h.status = () => ok(statusJson({ root: { path: "/somewhere/else", source: "declared" } }));
		const snap = await provider.refresh("s1");
		expect(snap).toMatchObject({ freshness: "unavailable", writable: false, needsReselect: true });
		expect(snap.diagnostics.join(" ")).toContain("different planning root (/somewhere/else)");
	});

	it("suspends when the apply call reports a different planning root", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		h.apply = async () => ok(await applyJson({ root: { path: "/other/place", source: "store" } }));
		const snap = await provider.refresh("s1");
		expect(snap).toMatchObject({ freshness: "unavailable", writable: false, needsReselect: true });
		expect(snap.diagnostics.join(" ")).toContain("different planning root (/other/place)");
	});

	it("does not show the old binding's rows after the session rebinds", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		let current: SessionMode = bound();
		const { provider } = setup([], () => current);
		await provider.refresh("s1");
		expect(provider.getSnapshot("s1").linked).toHaveLength(1);
		current = { mode: "openspec", binding: { root, change: "other-change" } };
		expect(provider.getSnapshot("s1")).toMatchObject({ freshness: "unavailable", linked: [], writable: false });
		current = { mode: "openspec", binding: { root: "/another/root", change: "a" } };
		expect(provider.getSnapshot("s1")).toMatchObject({ freshness: "unavailable", linked: [] });
	});

	it("asks for a new selection when the change stops being supported", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		h.status = () => ok(statusJson({ schemaName: "custom" }));
		expect(await provider.refresh("s1")).toMatchObject({ freshness: "unavailable", needsReselect: true });
	});
});

describe("stable reads", () => {
	it("retries when the file changes while it is being read, then publishes the stable view", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		let reads = 0;
		const flaky = async (path: string) => {
			const bytes = await readFile(path);
			if (++reads === 1) writeFileSync(path, md("- [ ] A", "- [ ] B")); // an edit lands after the first read
			return bytes;
		};
		const { provider } = setup([], bound, flaky);
		const snap = await provider.refresh("s1");
		expect(snap.freshness).toBe("fresh");
		expect(snap.linked.map((r) => r.description)).toEqual(["A", "B"]);
	});

	it("publishes nothing when the file never settles", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		let n = 0;
		const churning = async (path: string) => {
			const bytes = await readFile(path);
			writeFileSync(path, md(`- [ ] change ${++n}`));
			return bytes;
		};
		const { provider } = setup([], bound, churning);
		const snap = await provider.refresh("s1");
		expect(snap.freshness).toBe("unavailable");
		expect(snap.diagnostics.join(" ")).toMatch(/changed during refresh/);
	});

	it("disables writes when the CLI and the file disagree", async () => {
		writeFileSync(tasksPath, md("- [ ] A", "- [ ] B"));
		const { h, provider } = setup();
		h.apply = async () => ok(await applyJson({ tasks: [{ id: "1", description: "A", done: false }], progress: { total: 1, complete: 0, remaining: 1 } }));
		const snap = await provider.refresh("s1");
		expect(snap.writable).toBe(false);
		expect(snap.diagnostics.join(" ")).toMatch(/does not match the CLI/);
	});
});

describe("ids and activity across refreshes", () => {
	it("keeps ids when rows are reordered and never reuses a removed id", async () => {
		writeFileSync(tasksPath, md("- [ ] A", "- [ ] B", "- [ ] C"));
		const { provider } = setup();
		await provider.refresh("s1");
		writeFileSync(tasksPath, md("- [ ] C", "- [ ] A", "- [ ] B"));
		expect((await provider.refresh("s1")).linked.map((r) => r.id)).toEqual([3, 1, 2]);
		writeFileSync(tasksPath, md("- [ ] A", "- [ ] C"));
		await provider.refresh("s1");
		writeFileSync(tasksPath, md("- [ ] A", "- [ ] B", "- [ ] C"));
		expect((await provider.refresh("s1")).linked.map((r) => r.id)).toEqual([1, 4, 3]);
	});

	it("shows an external check as done", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { provider } = setup();
		await provider.refresh("s1");
		writeFileSync(tasksPath, md("- [x] A"));
		const snap = await provider.refresh("s1");
		expect(snap.linked[0].done).toBe(true);
		expect(snap.implementation).toMatchObject({ complete: 1, remaining: 0, state: "all_done" });
	});
});

describe("overlapping refreshes", () => {
	it("keeps the newest result when an older refresh finishes last", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { h, provider } = setup();
		const release: Array<() => void> = [];
		let first = true;
		h.apply = async () => {
			const mine = first;
			first = false;
			const body = await applyJson();
			if (mine) await new Promise<void>((r) => release.push(r)); // hold the older refresh open
			return ok(mine ? { ...body, tasks: [{ id: "1", description: "A", done: true }], progress: { total: 1, complete: 1, remaining: 0 } } : body);
		};
		const older = provider.refresh("s1");
		await new Promise((r) => setTimeout(r, 20));
		const newer = await provider.refresh("s1");
		release[0]();
		await older;
		expect(newer.linked[0].done).toBe(false);
		expect(provider.getSnapshot("s1").linked[0].done).toBe(false);
	});

	it("lets a newer refresh finish first and an older one finish without overwriting it", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { provider } = setup();
		const [a, b] = await Promise.all([provider.refresh("s1"), provider.refresh("s1")]);
		expect(a.freshness).toBe("fresh");
		expect(b.freshness).toBe("fresh");
		expect(provider.getSnapshot("s1").linked).toHaveLength(1);
	});
});

describe("session isolation", () => {
	it("keeps separate bindings and rows per session", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { provider } = setup([], (id) => (id === "one" ? bound() : { mode: "normal" }));
		await provider.refresh("one");
		await provider.refresh("two");
		expect(provider.getSnapshot("one").linked).toHaveLength(1);
		expect(provider.getSnapshot("two")).toMatchObject({ freshness: "inactive", linked: [] });
	});

	it("forgets a session", async () => {
		writeFileSync(tasksPath, md("- [ ] A"));
		const { provider } = setup();
		await provider.refresh("s1");
		provider.forget("s1");
		expect(provider.getSnapshot("s1").linked).toEqual([]);
	});
});
