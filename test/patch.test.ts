import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { patchCompletion } from "../src/openspec/patch.js";
import { fingerprint, listTasks, scanTasks } from "../src/openspec/tasks.js";
import { createOpenspecRoot } from "./fixtures.js";

const target = (description: string) => ({ fingerprint: fingerprint(description) });
const buf = (text: string) => Buffer.from(text, "utf-8");

/** Indexes where two equal-length buffers differ. */
function diff(a: Buffer, b: Buffer): number[] {
	expect(b.length).toBeGreaterThanOrEqual(a.length);
	const out: number[] = [];
	for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
	return out;
}

function expectOk(result: ReturnType<typeof patchCompletion>) {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.reason);
	return result;
}

describe("narrow checkbox patch", () => {
	it("changes exactly one byte for an unchecked box", () => {
		const original = buf("# Tasks\n- [ ] Alpha\n- [ ] Beta\n");
		const result = expectOk(patchCompletion(original, target("Beta")));
		expect(result.changed).toBe(true);
		expect(result.bytes.toString()).toBe("# Tasks\n- [ ] Alpha\n- [x] Beta\n");
		expect(diff(original, result.bytes)).toEqual([original.indexOf("Beta") - 3]);
	});

	it("turns other unchecked marker forms into x, changing only the marker", () => {
		const cases: Array<[string, string]> = [
			["- [~] Task\n", "- [x] Task\n"],
			["- [-] Task\n", "- [x] Task\n"],
			["- [?] Task\n", "- [x] Task\n"],
			["- [] Task\n", "- [x] Task\n"],
			["- [  ] Task\n", "- [x ] Task\n"],
			["- [ ~ ] Task\n", "- [ x ] Task\n"],
			["1. [ ] Task\n", "1. [x] Task\n"],
			["2) [ ] Task\n", "2) [x] Task\n"],
			["+ [ ] Task\n", "+ [x] Task\n"],
			["  * [ ] Task\n", "  * [x] Task\n"],
			["\t- [ ] Task\n", "\t- [x] Task\n"],
		];
		for (const [before, after] of cases) expect(expectOk(patchCompletion(buf(before), target("Task"))).bytes.toString()).toBe(after);
	});

	it("preserves every other byte: line endings, BOM, tabs, unicode, missing final newline", () => {
		const text = "﻿# 日本語 Tâche ☕\r\n\r\n- [x] Done 🚀\r\n- [ ] Target\tvalue  \r\n  - [ ] Child\n\ttail without newline";
		const original = buf(text);
		const result = expectOk(patchCompletion(original, target("Target\tvalue")));
		expect(result.bytes.length).toBe(original.length);
		expect(diff(original, result.bytes)).toHaveLength(1);
		expect(result.bytes.toString().replace("[x] Target", "[ ] Target")).toBe(text);
	});

	it("handles multi-byte characters before the box on earlier lines and the same line", () => {
		const text = "日本語日本語\nÿ ☕ 🚀\n- [ ] Target ☕\n";
		const result = expectOk(patchCompletion(buf(text), target("Target ☕")));
		expect(result.bytes.toString()).toBe("日本語日本語\nÿ ☕ 🚀\n- [x] Target ☕\n");
	});

	it("leaves identical-looking boxes on other lines alone", () => {
		const original = buf("- [ ] A\n- [ ] B\n```\n- [ ] A inside fence\n```\n- [ ] C\n");
		const result = expectOk(patchCompletion(original, target("B")));
		expect(result.bytes.toString()).toBe("- [ ] A\n- [x] B\n```\n- [ ] A inside fence\n```\n- [ ] C\n");
	});

	it("completes only the matching row when other rows share a prefix or a label", () => {
		const original = buf("- [ ] 1.1 Install\n- [ ] 1.1.1 Install plugin\n- [ ] Install\n");
		const result = expectOk(patchCompletion(original, target("1.1.1 Install plugin")));
		expect(result.bytes.toString()).toBe("- [ ] 1.1 Install\n- [x] 1.1.1 Install plugin\n- [ ] Install\n");
	});

	it("matches a description regardless of spacing differences", () => {
		const result = expectOk(patchCompletion(buf("- [ ]   Do   the  thing  \n"), target("Do the thing")));
		expect(result.bytes.toString()).toBe("- [x]   Do   the  thing  \n");
	});

	it("re-scans to the same tasks with only the target changed", () => {
		const original = buf("- [x] One\n- [ ] Two\n- [ ]\n- [~] Three\n  - [ ] Four\n");
		const before = listTasks(scanTasks(original.toString()));
		const after = listTasks(scanTasks(expectOk(patchCompletion(original, target("Three"))).bytes.toString()));
		expect(after.map((t) => [t.description, t.done])).toEqual(before.map((t) => [t.description, t.description === "Three" ? true : t.done]));
	});
});

describe("already completed tasks", () => {
	it("returns the same bytes and reports no change", () => {
		const original = buf("- [x] Done\r\n- [ ] Open\r\n");
		const result = expectOk(patchCompletion(original, target("Done")));
		expect(result.changed).toBe(false);
		expect(result.bytes.equals(original)).toBe(true);
	});

	it("treats upper-case X and padded x as done", () => {
		for (const box of ["[X]", "[ x ]", "[x ]"]) expect(expectOk(patchCompletion(buf(`- ${box} Done\n`), target("Done"))).changed).toBe(false);
	});
});

describe("refusals", () => {
	it("refuses when the wording is no longer in the file", () => {
		const result = patchCompletion(buf("- [ ] Reworded\n"), target("Original"));
		expect(result).toMatchObject({ ok: false, code: "missing" });
	});

	it("refuses duplicate wording instead of picking one", () => {
		const result = patchCompletion(buf("- [ ] Same\n- [ ] Same\n"), target("Same"));
		expect(result).toMatchObject({ ok: false, code: "ambiguous" });
	});

	it("refuses a textless box even when asked for empty wording", () => {
		expect(patchCompletion(buf("- [ ]\n"), target(""))).toMatchObject({ ok: false, code: "missing" });
	});

	it("refuses a file that is not valid UTF-8, because rewriting it would change other bytes", () => {
		const bytes = Buffer.concat([buf("- [ ] Target\n"), Buffer.from([0xff, 0xfe, 0x41, 0x0a])]);
		expect(patchCompletion(bytes, target("Target"))).toMatchObject({ ok: false, code: "not-utf8" });
	});

	it("refuses an empty file", () => {
		expect(patchCompletion(Buffer.alloc(0), target("Anything"))).toMatchObject({ ok: false, code: "missing" });
	});
});

describe("random files", () => {
	it("patch exactly one marker byte and keep every other byte", () => {
		let seed = 424242;
		const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
		const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)];
		for (let round = 0; round < 200; round++) {
			let text = "";
			for (let i = 0, n = 1 + Math.floor(next() * 10); i < n; i++) {
				text += `${pick(["-", "*", "+", "1.", "  -", "\t-"])} ${pick(["[ ]", "[x]", "[~]", "[]", "[  ]"])} ${pick(["alpha", "日本語", "Tâche ☕", "spaced out", "dup", "dup", "x".repeat(40)])} ${i}${pick(["\n", "\r\n", "\n\n"])}`;
			}
			const original = buf(text);
			for (const t of listTasks(scanTasks(text))) {
				const result = patchCompletion(original, { fingerprint: t.fingerprint });
				const sameWording = listTasks(scanTasks(text)).filter((x) => x.fingerprint === t.fingerprint).length;
				if (sameWording > 1) {
					expect(result).toMatchObject({ ok: false, code: "ambiguous" });
					continue;
				}
				const done = expectOk(result);
				if (t.done) {
					expect(done.bytes.equals(original)).toBe(true);
					continue;
				}
				const after = listTasks(scanTasks(done.bytes.toString()));
				expect(after.map((x) => [x.description, x.done])).toEqual(listTasks(scanTasks(text)).map((x) => [x.description, x.fingerprint === t.fingerprint ? true : x.done]));
				expect(done.bytes.length - original.length).toBeLessThanOrEqual(1);
			}
		}
	});
});

const HAS_CLI = spawnSync("openspec", ["--version"], { encoding: "utf-8" }).status === 0;
const fixture = createOpenspecRoot();
afterAll(() => fixture.cleanup());

describe.skipIf(!HAS_CLI)("patched files as the installed CLI reads them", () => {
	it("shows exactly the patched task as done", () => {
		const variants = ["- [ ] Target\n- [ ] Other\n", "- [~] Target\r\n- [ ] Other\r\n", "- [] Target\n- [x] Other\n", "1. [ ] Target\n  - [ ] Other\n"];
		variants.forEach((text, i) => {
			const name = `patched-${i}`;
			const { tasksPath } = fixture.addChange(name, text);
			const result = expectOk(patchCompletion(buf(text), target("Target")));
			require("node:fs").writeFileSync(tasksPath, result.bytes);
			const run = spawnSync("openspec", ["instructions", "apply", "--change", name, "--json"], { cwd: fixture.root, encoding: "utf-8" });
			const tasks = JSON.parse(run.stdout).tasks as Array<{ description: string; done: boolean }>;
			expect(tasks.find((t) => t.description === "Target")?.done).toBe(true);
			const other = text.includes("[x] Other");
			expect(tasks.find((t) => t.description === "Other")?.done).toBe(other);
			expect(readFileSync(tasksPath).equals(result.bytes)).toBe(true);
		});
	});
});
