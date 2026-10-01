import { describe, expect, it } from "vitest";
import { refreshPreferences, savePreferences } from "../src/preferences.js";
import { setSessionMode } from "../src/session-mode.js";
import { setActiveRenderSession } from "../src/state/store.js";
import { DEFAULT_PROMPT_GUIDELINES, registerTodoTool } from "../src/todo.js";
import { renderTodoCall, renderTodoResult } from "../src/view/format.js";
import { buildSync, md, useSyncRoot } from "./sync-harness.js";
import { createHost, useCleanEnvironment } from "./helpers.js";

useCleanEnvironment();
const paths = useSyncRoot();

/** A theme whose styling calls return plain text, so rendered lines can be compared. */
const theme: any = new Proxy(
	{},
	{ get: (_t, key) => (key === "fg" || key === "bg" ? (_c: string, text: string) => text : (text: string) => text) },
);
const rendered = (component: { render(width: number): string[] }) => component.render(200).join("\n").trim();
const guidance = () => DEFAULT_PROMPT_GUIDELINES.join("\n");

describe("tool guidance", () => {
	it("tells the agent to complete a linked task the moment its criteria are met, never in a batch", () => {
		expect(guidance()).toMatch(/Mark it completed IMMEDIATELY when done — never batch completions/);
		expect(guidance()).toMatch(/OpenSpec sync mode[^.]*imported[^.]*tasks\.md/i);
		expect(guidance()).toMatch(/completing a linked task checks its box in tasks\.md/i);
	});

	it("tells the agent how to pass the revision, and to read it from list, get or the last result", () => {
		expect(guidance()).toMatch(/expectedRevision[^.]*latest (list|get)/i);
	});

	it("tells the agent to use imported ids and never paraphrase a plan task into a new one", () => {
		expect(guidance()).toMatch(/never paraphrase a plan task/i);
		expect(guidance()).toMatch(/scope "incidental"[^.]*reason[^.]*temporary[^.]*outside the plan/i);
		expect(guidance()).toMatch(/never count as OpenSpec progress/i);
	});

	it("tells the agent to state waiting and failure reasons explicitly, and to clear them when resolved", () => {
		expect(guidance()).toMatch(/waitingReason[^.]*approval[^.]*review/i);
		expect(guidance()).toMatch(/failureReason[^.]*failed/i);
		expect(guidance()).toMatch(/empty string[^.]*resolved|resolved[^.]*empty string/i);
	});

	it("keeps verification claims honest: a checked box is recorded progress, not proof", () => {
		expect(guidance()).toMatch(/checked box records progress[^.]*not proof that tests passed/i);
		expect(guidance()).toMatch(/report what you ran and what it showed/i);
	});

	it("keeps the original rules that protect against false completion", () => {
		expect(guidance()).toMatch(/Never mark a task completed if tests are failing/);
		expect(guidance()).toMatch(/Exactly one task in_progress at a time/);
	});

	it("is what the registered tool offers, unless the user overrides it in preferences", async () => {
		const host = createHost();
		registerTodoTool(host.pi);
		expect(host.tools.get("todo").promptGuidelines).toEqual(DEFAULT_PROMPT_GUIDELINES);
		await savePreferences({ guidance: { promptGuidelines: ["Custom rule"] } });
		await refreshPreferences();
		const again = createHost();
		registerTodoTool(again.pi);
		expect(again.tools.get("todo").promptGuidelines).toEqual(["Custom rule"]);
	});

	it("describes the sync scope in the tool description", () => {
		const host = createHost();
		registerTodoTool(host.pi);
		expect(host.tools.get("todo").description).toMatch(/OpenSpec sync mode/);
		expect(host.tools.get("todo").description).toMatch(/scope/);
	});
});

describe("result labels are honest", () => {
	it("a successful update shows the new status", () => {
		const details = {
			action: "update",
			params: { action: "update", id: 1, status: "completed" },
			tasks: [{ id: 1, subject: "A", status: "completed" }],
			nextId: 2,
		};
		expect(rendered(renderTodoResult({ details }, theme))).toBe("● completed");
	});

	it("a failed call never shows a success status, even when it asked for one", () => {
		const details = {
			action: "update",
			params: { action: "update", id: 1, status: "completed" },
			tasks: [{ id: 1, subject: "A", status: "pending" }],
			nextId: 2,
			error: "The task file could not be written",
		};
		expect(rendered(renderTodoResult({ details }, theme))).toBe("✗ failed");
	});

	it("the failure is styled as an error, not as success", () => {
		const coloured: any = new Proxy(
			{},
			{ get: (_t, key) => (key === "fg" ? (c: string, text: string) => `<${c}>${text}` : (text: string) => text) },
		);
		const details = {
			action: "update",
			params: { action: "update", id: 1, status: "completed" },
			tasks: [],
			nextId: 1,
			error: "x",
		};
		expect(rendered(renderTodoResult({ details }, coloured))).toBe("<error>✗ failed");
	});

	it("a failed create, delete and list are all shown as failed", () => {
		for (const action of ["create", "delete", "list"]) {
			const details = {
				action,
				params: { action },
				tasks: [{ id: 1, subject: "A", status: "pending" }],
				nextId: 2,
				error: "nope",
			};
			expect(rendered(renderTodoResult({ details }, theme))).toBe("✗ failed");
		}
	});

	it("a linked activity update is not labelled with a same-numbered incidental task's status", async () => {
		const t = buildSync(paths, md("- [ ] A", "- [ ] B"));
		await t.call({ action: "create", subject: "Mine", scope: "incidental", reason: "r" });
		await t.call({ action: "update", id: 1, status: "completed", scope: "incidental" }); // incidental #1 is completed
		const r = await t.call({ action: "update", id: 1, owner: "me" }); // linked #1, no status
		expect(r.details.linked).toBeDefined();
		expect(rendered(renderTodoResult({ details: r.details }, theme))).toBe("✓");
	});

	it("an incidental update still shows its own status", async () => {
		const t = buildSync(paths, md("- [ ] A"));
		await t.call({ action: "create", subject: "Mine", scope: "incidental", reason: "r" });
		const r = await t.call({ action: "update", id: 1, activeForm: "doing", scope: "incidental" });
		expect(rendered(renderTodoResult({ details: r.details }, theme))).toBe("○ pending");
	});

	it("a failed linked completion shows as failed through the real tool", async () => {
		const t = buildSync(paths, md("- [ ] A"), { fs: { rename: async () => undefined } });
		const rev = await t.revision();
		const r = await t.call({ action: "update", id: 1, status: "completed", expectedRevision: rev });
		expect(rendered(renderTodoResult({ details: r.details }, theme))).toBe("✗ failed");
	});
});

describe("call labels name the right task", () => {
	const state = { tasks: [{ id: 1, subject: "Ordinary one", status: "pending" as const }], nextId: 2 };

	it("uses the ordinary list by default", () => {
		expect(rendered(renderTodoCall({ action: "update", id: 1 } as any, theme, state))).toBe("todo → Ordinary one");
	});

	it("names a linked task by its tasks.md wording for linked ids, and an incidental one by its own subject", async () => {
		const t = buildSync(paths, md("- [ ] 1.1 Linked wording"));
		await t.call({ action: "create", subject: "Mine", scope: "incidental", reason: "r" });
		await t.call({ action: "list" });
		setActiveRenderSession("s1");
		const tool = t.host.tools.get("todo");
		expect(rendered(tool.renderCall({ action: "update", id: 1 }, theme, {}))).toBe("todo → 1.1 Linked wording");
		expect(rendered(tool.renderCall({ action: "get", id: 1, scope: "incidental" }, theme, {}))).toBe("todo › Mine");
	});

	it("falls back to the plain id for an unknown linked id", async () => {
		const t = buildSync(paths, md("- [ ] A"));
		await t.call({ action: "list" });
		setActiveRenderSession("s1");
		expect(rendered(t.host.tools.get("todo").renderCall({ action: "update", id: 9 }, theme, {}))).toBe("todo → #9");
	});

	it("uses the ordinary list for a normal session even with a runtime registered", async () => {
		const t = buildSync(paths, md("- [ ] A"));
		setSessionMode("s1", { mode: "normal" });
		await t.call({ action: "create", subject: "Plain" });
		setActiveRenderSession("s1");
		expect(rendered(t.host.tools.get("todo").renderCall({ action: "update", id: 1 }, theme, {}))).toBe("todo → Plain");
	});
});
