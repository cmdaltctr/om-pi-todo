import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSessionMode, setSessionMode } from "../src/session-mode.js";
import { fingerprint } from "../src/openspec/tasks.js";
import { buildSync, md, useSyncRoot } from "./sync-harness.js";
import { callTool, useCleanEnvironment } from "./helpers.js";

useCleanEnvironment();
const paths = useSyncRoot();
const make = (content: string, over = {}, ids = ["s1"]) => buildSync(paths, content, over, ids);
const branch = (...details: unknown[]) => ({
	sessionManager: {
		getBranch: () =>
			details.map((d) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: d } })),
	},
});
const applyCalls = (t: ReturnType<typeof make>) => t.cli.calls.filter((c) => c.args[0] === "instructions").length;
const openWatches = (t: ReturnType<typeof make>) => t.watches.filter((w) => !w.closed);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("starting sync for a session", () => {
	it("reads the change in the background, publishes it, repaints, and watches the tracked file", async () => {
		const t = make(md("- [ ] A", "- [x] B"));
		t.runtime.start("s1", branch());
		expect(t.runtime.provider.getSnapshot("s1").freshness).toBe("unavailable"); // not read yet
		await t.runtime.idle();
		expect(t.runtime.provider.getSnapshot("s1")).toMatchObject({ freshness: "fresh", writable: true });
		expect(t.repaints.length).toBe(1);
		expect(t.watches.map((w) => w.file)).toEqual([paths.tasksPath]);
		expect(t.runtime.watchedSessions()).toEqual(["s1"]);
	});

	it("does nothing for a normal-mode or unbound session", async () => {
		const t = make(md("- [ ] A"), {}, ["s1", "s2"]);
		setSessionMode("s1", { mode: "normal" });
		setSessionMode("s2", { mode: "openspec" });
		t.runtime.start("s1", branch());
		t.runtime.start("s2", branch());
		await t.runtime.idle();
		expect(t.cli.calls).toEqual([]);
		expect(t.watches).toEqual([]);
	});

	it("restores ids and activity saved for this binding, and ignores a block saved for another change", async () => {
		const t = make(md("- [ ] A", "- [ ] B"));
		const binding = { root: paths.root, change: "a" };
		const saved = {
			binding,
			nextId: 20,
			rows: [{ id: 5, fingerprint: fingerprint("B"), activity: { status: "in_progress", activeForm: "b" } }],
		};
		const other = {
			binding: { root: paths.root, change: "other" },
			nextId: 99,
			rows: [{ id: 50, fingerprint: fingerprint("A") }],
		};
		t.runtime.start("s1", branch({ tasks: [], nextId: 1, linked: saved }, { tasks: [], nextId: 1, linked: other }));
		await t.runtime.idle();
		const snap = t.runtime.provider.getSnapshot("s1");
		expect(snap.linked.map((r) => r.id)).toEqual([20, 5]);
		expect(snap.linked[1].activity).toEqual({ status: "in_progress", activeForm: "b" });
	});

	it("uses the last saved block when several are on the branch", async () => {
		const t = make(md("- [ ] A"));
		const binding = { root: paths.root, change: "a" };
		const older = { binding, nextId: 5, rows: [{ id: 3, fingerprint: fingerprint("A") }] };
		const newer = { binding, nextId: 9, rows: [{ id: 8, fingerprint: fingerprint("A") }] };
		t.runtime.start("s1", branch({ tasks: [], nextId: 1, linked: older }, { tasks: [], nextId: 1, linked: newer }));
		await t.runtime.idle();
		expect(t.runtime.provider.getSnapshot("s1").linked.map((r) => r.id)).toEqual([8]);
	});

	it("rejects a saved id of zero, which could never have been handed out", async () => {
		const t = make(md("- [ ] A"));
		const binding = { root: paths.root, change: "a" };
		t.runtime.start(
			"s1",
			branch({
				tasks: [],
				nextId: 1,
				linked: { binding, nextId: 1, rows: [{ id: 0, fingerprint: fingerprint("A") }] },
			}),
		);
		await t.runtime.idle();
		expect(t.runtime.provider.getSnapshot("s1").linked.map((r) => r.id)).toEqual([1]);
	});

	it("ignores malformed saved data", async () => {
		const t = make(md("- [ ] A"));
		const binding = { root: paths.root, change: "a" };
		for (const bad of [
			null,
			"x",
			{ binding },
			{ binding, nextId: 1, rows: "no" },
			{ binding, nextId: 1, rows: [{ id: 0, fingerprint: "x" }] },
			{ binding, nextId: 1, rows: [{ id: 1 }] },
			{ binding: { root: 1, change: "a" }, nextId: 1, rows: [] },
		]) {
			t.runtime.start("s1", branch({ tasks: [], nextId: 1, linked: bad }));
			await t.runtime.idle();
			expect(t.runtime.provider.getSnapshot("s1").linked.map((r) => r.id)).toEqual([1]);
		}
	});
});

describe("external edits", () => {
	it("an external check shows as done after the next coalesced refresh, and repaints", async () => {
		const t = make(md("- [ ] A", "- [ ] B"));
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		const repaintsBefore = t.repaints.length;
		writeFileSync(paths.tasksPath, md("- [x] A", "- [ ] B"));
		t.watches[0].fire();
		await sleep(80);
		await t.runtime.idle();
		expect(t.runtime.provider.getSnapshot("s1").linked.map((r) => r.done)).toEqual([true, false]);
		expect(t.repaints.length).toBeGreaterThan(repaintsBefore);
	});

	it("an external uncheck reopens the task", async () => {
		const t = make(md("- [x] A"));
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		writeFileSync(paths.tasksPath, md("- [ ] A"));
		t.watches[0].fire();
		await sleep(80);
		await t.runtime.idle();
		expect(t.runtime.provider.getSnapshot("s1").linked[0].done).toBe(false);
	});

	it("a burst of file events causes one refresh", async () => {
		const t = make(md("- [ ] A"));
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		const before = applyCalls(t);
		for (let i = 0; i < 25; i++) t.watches[0].fire();
		await sleep(100);
		await t.runtime.idle();
		expect(applyCalls(t) - before).toBe(1);
	});

	it("an event during a refresh causes exactly one more, never two at once", async () => {
		const t = make(md("- [ ] A"));
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		const before = applyCalls(t);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let inside = 0;
		let peak = 0;
		let first = true;
		t.cli.hooks.apply = async () => {
			peak = Math.max(peak, ++inside);
			if (first) {
				first = false;
				await gate;
			}
			inside--;
			return undefined;
		};
		t.watches[0].fire();
		await sleep(60); // the first refresh is now held open
		t.watches[0].fire();
		t.watches[0].fire();
		release();
		await sleep(150);
		await t.runtime.idle();
		expect(applyCalls(t) - before).toBe(2);
		expect(peak).toBe(1);
	});

	it("an archived change becomes stale with a reselect request, and its watcher is closed", async () => {
		const t = make(md("- [ ] A"));
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		t.cli.hooks.status = () => ({
			ok: false,
			kind: "exit",
			message: "OpenSpec exited with code 1: Change 'a' not found",
		});
		t.watches[0].fire();
		await sleep(80);
		await t.runtime.idle();
		expect(t.runtime.provider.getSnapshot("s1")).toMatchObject({
			freshness: "stale",
			needsReselect: true,
			writable: false,
		});
		expect(openWatches(t)).toEqual([]);
		expect(t.runtime.watchedSessions()).toEqual([]);
	});

	it("reports a watcher that fails and leaves refresh-on-demand working", async () => {
		const t = make(md("- [ ] A"), {
			watch: (file: string, _on: () => void, o?: { onError?: (e: unknown) => void }) => {
				o?.onError?.(new Error("EMFILE"));
				return { close() {} };
			},
		});
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		expect(t.errors.join(" ")).toContain("Watching");
		expect(t.errors.join(" ")).toContain("Run /todos refresh");
		expect((await t.call({ action: "list" })).text).toContain("[pending] #1 A");
	});

	it("reports a repaint failure without breaking the refresh", async () => {
		const t = make(md("- [ ] A"), {
			onRepaint: () => {
				throw new Error("no widget");
			},
		});
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		expect(t.errors.join(" ")).toContain("could not be repainted: no widget");
		expect(t.runtime.provider.getSnapshot("s1").freshness).toBe("fresh");
	});
});

describe("watch follows the tracked file", () => {
	/** After the first read, make status report a different tracked file in the same change. */
	async function moveTrackedFile(t: ReturnType<typeof make>) {
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		const moved = join(paths.changeRoot, "moved-tasks.md");
		writeFileSync(moved, md("- [ ] A"));
		t.cli.hooks.status = () => ({
			ok: true,
			stderr: "",
			json: {
				changeName: "a",
				schemaName: "spec-driven",
				changeRoot: paths.changeRoot,
				isPlanningComplete: true,
				artifacts: [],
				artifactPaths: { tasks: { existingOutputPaths: [moved] } },
				root: { path: paths.root, source: "nearest" },
			},
		});
		return moved;
	}

	it("closes the old watcher and opens one on the new file", async () => {
		const t = make(md("- [ ] A"));
		const moved = await moveTrackedFile(t);
		t.watches[0].fire();
		await sleep(80);
		await t.runtime.idle();
		expect(t.watches[0].closed).toBe(true);
		expect(openWatches(t).map((w) => w.file)).toEqual([moved]);
	});

	it("reports a failure to re-arm as a refresh problem, with the committed view intact", async () => {
		let calls = 0;
		let fire!: () => void;
		const t = make(md("- [ ] A"), {
			watch: (_file: string, onChange: () => void) => {
				if (++calls === 1) {
					fire = onChange;
					return { close() {} };
				}
				throw new Error("watch limit reached");
			},
		});
		await moveTrackedFile(t);
		fire();
		await sleep(80);
		await t.runtime.idle();
		expect(t.errors.join(" ")).toContain("Refreshing the OpenSpec view failed: watch limit reached");
		expect(t.runtime.provider.getSnapshot("s1").freshness).toBe("fresh");
	});
});

describe("rebinding and teardown", () => {
	it("rebinding closes the old watcher and opens one for the new binding", async () => {
		const t = make(md("- [ ] A"));
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		const other = join(paths.root, "openspec", "changes", "b");
		mkdirSync(other, { recursive: true });
		const first = t.watches[0];
		t.runtime.start("s1", branch()); // same binding again: restart
		await t.runtime.idle();
		expect(first.closed).toBe(true);
		expect(openWatches(t)).toHaveLength(1);
	});

	it("switching to normal mode and restarting closes the watcher and forgets the view", async () => {
		const t = make(md("- [ ] A"));
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		setSessionMode("s1", { mode: "normal" });
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		expect(openWatches(t)).toEqual([]);
		expect(t.runtime.provider.getSnapshot("s1").linked).toEqual([]);
	});

	it("stop closes the watcher, cancels a pending refresh and forgets the session", async () => {
		const t = make(md("- [ ] A"));
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		const before = applyCalls(t);
		t.watches[0].fire();
		t.runtime.stop("s1");
		await sleep(120);
		expect(applyCalls(t)).toBe(before);
		expect(openWatches(t)).toEqual([]);
		expect(t.runtime.provider.getSnapshot("s1").linked).toEqual([]);
		t.watches[0].fire(); // a late event after stop does nothing
		await sleep(80);
		expect(applyCalls(t)).toBe(before);
	});

	it("stopAll leaves no watcher, timer or pending work for any session", async () => {
		const t = make(md("- [ ] A"), {}, ["s1", "s2"]);
		t.runtime.start("s1", branch());
		t.runtime.start("s2", branch());
		await t.runtime.idle();
		expect(openWatches(t)).toHaveLength(2);
		for (const w of t.watches) w.fire();
		t.runtime.stopAll();
		await t.runtime.idle();
		expect(openWatches(t)).toEqual([]);
		expect(t.runtime.watchedSessions()).toEqual([]);
	});

	it("stopping one session leaves another watched and refreshing", async () => {
		const t = make(md("- [ ] A"), {}, ["s1", "s2"]);
		t.runtime.start("s1", branch());
		t.runtime.start("s2", branch());
		await t.runtime.idle();
		t.runtime.stop("s1");
		expect(t.runtime.watchedSessions()).toEqual(["s2"]);
		writeFileSync(paths.tasksPath, md("- [x] A"));
		t.watches.find((w) => !w.closed)!.fire();
		await sleep(80);
		await t.runtime.idle();
		expect(t.runtime.provider.getSnapshot("s2").linked[0].done).toBe(true);
	});

	it("does not watch when the read never succeeded", async () => {
		const t = make(md("- [ ] A"));
		t.cli.hooks.status = () => ({ ok: false, kind: "spawn", message: "no openspec" });
		t.runtime.start("s1", branch());
		await t.runtime.idle();
		expect(t.watches).toEqual([]);
		expect(t.runtime.provider.getSnapshot("s1").freshness).toBe("unavailable");
	});
});

describe("binding generations", () => {
	it("a refresh that started before a rebind can neither publish nor repaint", async () => {
		const t = make(md("- [ ] A"));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		t.cli.hooks.apply = async () => {
			await gate;
			return undefined;
		};
		const pending = t.runtime.refresh("s1");
		await sleep(30);
		t.runtime.bump("s1"); // the session branches or rebinds
		const repaintsBefore = t.repaints.length;
		release();
		await pending;
		expect(t.runtime.provider.getSnapshot("s1").freshness).toBe("unavailable"); // nothing published
		expect(t.repaints.length).toBe(repaintsBefore);
		expect(t.watches).toEqual([]);
	});

	it("start while an earlier refresh is in flight: only the newer result is shown", async () => {
		const t = make(md("- [ ] Old"));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let first = true;
		t.cli.hooks.apply = async () => {
			if (first) {
				first = false;
				await gate;
			}
			return undefined;
		};
		t.runtime.start("s1", branch()); // held open
		await sleep(30);
		writeFileSync(paths.tasksPath, md("- [ ] New"));
		t.runtime.start("s1", branch()); // newer generation
		await sleep(60);
		const repaintsBeforeRelease = t.repaints.length;
		release();
		await t.runtime.idle();
		expect(t.runtime.provider.getSnapshot("s1").linked.map((r) => r.description)).toEqual(["New"]);
		expect(t.repaints.length).toBe(repaintsBeforeRelease); // the obsolete refresh did not repaint
	});

	it("a completion in flight when the session rebinds writes nothing", async () => {
		const t = make(md("- [ ] A"));
		const rev = await t.revision();
		let n = 0;
		t.cli.hooks.apply = () => {
			if (++n === 2) t.runtime.bump("s1"); // during the writer's own refresh (1 is the tool's)
			return undefined;
		};
		const r = await callTool(t.host, t.ctx(), { action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(r.text).toMatch(/^Error: Cancelled\./);
		expect(t.disk().toString()).toBe(md("- [ ] A"));
	});

	it("a completion that landed before the rebind is reported, not published or replayed", async () => {
		let t!: ReturnType<typeof make>;
		let repaintsAtRebind = -1;
		t = make(md("- [ ] A"), {
			fs: {
				rename: async (a: string, b: string) => {
					renameSync(a, b);
					repaintsAtRebind = t.repaints.length;
					t.runtime.bump("s1");
				},
			},
		});
		const rev = await t.revision();
		const r = await callTool(t.host, t.ctx(), { action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(r.text).toMatch(/^Error: The checkbox for task #1 was written to .*binding changed/);
		expect(t.disk().toString()).toBe(md("- [x] A"));
		expect(repaintsAtRebind).toBeGreaterThan(-1);
		expect(t.repaints.length).toBe(repaintsAtRebind); // nothing was published or repainted after the rebind
	});

	it("bumping one session leaves another session's work current", async () => {
		const t = make(md("- [ ] A"), {}, ["s1", "s2"]);
		const g2 = t.runtime.capture("s2");
		t.runtime.bump("s1");
		expect(g2.isCurrent()).toBe(true);
		expect(t.runtime.capture("s1").isCurrent()).toBe(true);
	});

	it("a captured generation turns obsolete after a bump or a stop", async () => {
		const t = make(md("- [ ] A"));
		const a = t.runtime.capture("s1");
		t.runtime.bump("s1");
		expect(a.isCurrent()).toBe(false);
		const b = t.runtime.capture("s1");
		t.runtime.stop("s1");
		expect(b.isCurrent()).toBe(false);
	});

	it("keeps the session mode untouched by any of this", async () => {
		const t = make(md("- [ ] A"));
		t.runtime.start("s1", branch());
		t.runtime.stop("s1");
		expect(getSessionMode("s1").mode).toBe("openspec");
	});
});
