import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createDiscovery } from "../src/openspec/discover.js";
import { createSnapshotProvider } from "../src/openspec/snapshot.js";
import { createWriter } from "../src/openspec/writer.js";
import type { SessionMode } from "../src/session-mode.js";
import { createOpenspecRoot } from "./fixtures.js";

const HAS_CLI = spawnSync("openspec", ["--version"], { encoding: "utf-8" }).status === 0;
const fixture = createOpenspecRoot();
afterAll(() => fixture.cleanup());

/** The CLI resolves symlinks such as macOS /var to /private/var, so compare real paths. */
const root = () => realpathSync(fixture.root);

describe.skipIf(!HAS_CLI)("discovery and snapshot against the installed OpenSpec CLI", () => {
	it("discovers the root and classifies changes", async () => {
		fixture.addChange("good", "- [x] 1.1 Done\n- [ ] 1.2 Open\n");
		fixture.addChange("other-schema", "- [ ] X\n", "custom");
		const result = await createDiscovery()(fixture.root);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.root).toBe(root());
		expect(result.rootSource).toBe("nearest");
		const byName = Object.fromEntries(result.changes.map((c) => [c.name, c]));
		expect(byName.good).toEqual({ name: "good", supported: true });
		expect(byName["other-schema"].supported).toBe(false);
	});

	it("reads a bound change, then follows an external edit", async () => {
		const { tasksPath } = fixture.addChange("live", "- [x] 1.1 Done\n- [ ] 1.2 Open\n- [ ]\n");
		const mode: SessionMode = { mode: "openspec", binding: { root: root(), change: "live" } };
		const provider = createSnapshotProvider({}, { getMode: () => mode, getOrdinary: () => [] });

		const first = await provider.refresh("s1");
		expect(first).toMatchObject({ freshness: "fresh", writable: true, schema: "spec-driven" });
		expect(first.implementation).toMatchObject({ total: 3, complete: 1, remaining: 2 });
		expect(first.linked.map((r) => [r.id, r.description, r.done])).toEqual([[1, "1.1 Done", true], [2, "1.2 Open", false]]);
		expect(first.planning?.isComplete).toBe(true);
		expect(first.diagnostics.join(" ")).toMatch(/1 checkbox without text/);

		writeFileSync(tasksPath, "- [ ] 1.2 Open\n- [x] 1.1 Done\n- [x] 1.3 New\n");
		const second = await provider.refresh("s1");
		expect(second.linked.map((r) => [r.id, r.description, r.done])).toEqual([[2, "1.2 Open", false], [1, "1.1 Done", true], [3, "1.3 New", true]]);
		expect(second.implementation).toMatchObject({ state: "all_done" === second.implementation?.state ? "all_done" : "ready", total: 3, complete: 2 });
	});

	it("reports a change that disappears", async () => {
		fixture.addChange("vanishing", "- [ ] A\n");
		const mode: SessionMode = { mode: "openspec", binding: { root: root(), change: "vanishing" } };
		const provider = createSnapshotProvider({}, { getMode: () => mode, getOrdinary: () => [] });
		expect((await provider.refresh("s1")).freshness).toBe("fresh");
		const { rmSync } = await import("node:fs");
		const { join } = await import("node:path");
		rmSync(join(fixture.root, "openspec", "changes", "vanishing"), { recursive: true });
		const gone = await provider.refresh("s1");
		expect(gone).toMatchObject({ freshness: "stale", writable: false, needsReselect: true });
	});

	it("completes a task through the writer and the CLI independently agrees", async () => {
		const original = "# Tasks\r\n- [x] 1.1 Done\r\n- [ ] 1.2 Target\r\n- [~] 1.3 Started\r\n- [ ]\r\n";
		const { tasksPath } = fixture.addChange("writes", original);
		const mode: SessionMode = { mode: "openspec", binding: { root: root(), change: "writes" } };
		const provider = createSnapshotProvider({}, { getMode: () => mode, getOrdinary: () => [] });
		const writer = createWriter({ provider });

		const view = await provider.refresh("s1");
		const target = view.linked.find((r) => r.description === "1.2 Target")!;
		const outcome = await writer.complete("s1", target.id, view.revision!);
		expect(outcome).toMatchObject({ kind: "completed", changed: true });
		expect(readFileSync(tasksPath, "utf-8")).toBe(original.replace("[ ] 1.2 Target", "[x] 1.2 Target"));

		const cli = spawnSync("openspec", ["instructions", "apply", "--change", "writes", "--json"], { cwd: fixture.root, encoding: "utf-8" });
		const apply = JSON.parse(cli.stdout);
		expect(apply.tasks.map((t: any) => [t.description, t.done])).toEqual([["1.1 Done", true], ["1.2 Target", true], ["1.3 Started", false]]);
		expect(apply.progress).toMatchObject({ total: 4, complete: 2 });

		// A second attempt is a no-op, and a stale revision is refused.
		const again = await provider.refresh("s1");
		expect(await writer.complete("s1", target.id, again.revision!)).toMatchObject({ kind: "completed", changed: false });
		expect(await writer.complete("s1", target.id, view.revision!)).toMatchObject({ kind: "rejected", code: "stale-revision" });
	}, 60_000);
});
