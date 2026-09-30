import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { listTasks, scanTasks } from "../src/openspec/tasks.js";
import { createOpenspecRoot } from "./fixtures.js";

const HAS_CLI = spawnSync("openspec", ["--version"], { encoding: "utf-8" }).status === 0;

const fixture = createOpenspecRoot();
afterAll(() => fixture.cleanup());

interface CliApply {
	progress: { total: number; complete: number };
	tasks: Array<{ id: string; description: string; done: boolean }>;
}

let counter = 0;
/** What the installed CLI reports for a tasks.md with this exact content. */
function cliView(content: string | Buffer): CliApply {
	const name = `case-${counter++}`;
	fixture.addChange(name, content);
	const run = spawnSync("openspec", ["instructions", "apply", "--change", name, "--json"], { cwd: fixture.root, encoding: "utf-8" });
	expect(run.status, run.stderr).toBe(0);
	return JSON.parse(run.stdout);
}

/** Every case compares the scanner with the CLI on ids, wording, state and totals. */
function expectParity(content: string) {
	const cli = cliView(content);
	const scanned = scanTasks(content);
	const listed = listTasks(scanned);
	expect(listed.map((t) => ({ id: t.rowId, description: t.description, done: t.done }))).toEqual(cli.tasks);
	expect(scanned.length).toBe(cli.progress.total);
	expect(scanned.filter((t) => t.done).length).toBe(cli.progress.complete);
}

const CASES: Record<string, string> = {
	"basic mixed": "# Tasks\n\n## 1. A\n\n- [x] 1.1 Done\n- [ ] 1.2 Open\n- [ ] 1.3 Another\n",
	"reordered rows": "- [ ] Second\n- [x] First\n- [ ] Third\n",
	"duplicate descriptions": "- [ ] Same\n- [ ] Same\n- [x] Same\n- [ ] Other\n",
	"textless boxes": "- [ ] Real\n- [ ]\n- []\n- [x]\n- [ ] Another\n",
	"CRLF line endings": "- [ ] One\r\n- [x] Two\r\n  - [ ] Nested\r\n- [ ]\r\n",
	"mixed line endings": "- [ ] One\r\n- [x] Two\n- [ ] Three\r\n",
	"bare CR only": "- [ ] One\r- [x] Two\r",
	"nesting and tabs": "- [ ] Top\n  - [ ] Child\n    - [x] Grandchild\n\t- [ ] Tabbed\n\t\t- [ ] Deep tab\n",
	"list markers": "- [ ] dash\n* [ ] star\n+ [ ] plus\n1. [ ] ordered dot\n2) [x] ordered paren\n123456789. [ ] nine digits\n1234567890. [ ] ten digits\n",
	"marker variants": "- [~] tilde\n- [-] dash\n- [ x ] padded\n- [X] upper\n- [?] question\n- [1] digit\n- [xx] two chars\n- [WIP] word\n- [x]glued\n",
	"link bullets are not tasks": "- [A](https://example.com)\n- [1](./one)\n- [a][ref]\n- [Some doc](./doc.md)\n- [ ](https://example.com)\n- [ ][ref]\n- [ ] Real task\n",
	"fences and comments still count": "```md\n- [ ] in a fence\n```\n<!-- - [ ] in a comment -->\n- [ ] after\n    - [ ] indented code-like\n",
	"not list items": "[ ] bare\n-[ ] no space\n- text [ ] later\n> - [ ] quote\n",
	"empty file": "",
	"headings only": "# Tasks\n\n## 1. Nothing\n",
	"no trailing newline": "- [ ] One\n- [x] Two",
	"unicode and symbols": "- [ ] Tâche café ☕ 日本語\n- [x] emoji 🚀 done\n- [ ] quotes \"a\" 'b' `c` <d> &e\n",
	"trailing spaces and inner tabs": "- [ ]   spaced out   \n- [x]\ttabbed\n- [ ]\t\n",
	"long description": `- [ ] ${"word ".repeat(400)}\n`,
};

describe.skipIf(!HAS_CLI)("scanner parity with the installed OpenSpec CLI", () => {
	for (const [name, content] of Object.entries(CASES)) it(name, () => expectParity(content));

	it("matches on seeded random files", () => {
		let seed = 20260930;
		const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
		const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)];
		const markers = ["-", "*", "+", "1.", "12)", "  -", "\t-", "    *", ""];
		const boxes = ["[ ]", "[x]", "[X]", "[]", "[~]", "[ x ]", "[-]", "[A]", "[xx]", "[ ](u)", "[a][r]"];
		const texts = ["", " ", " task", "  spaced  ", " dup", " dup", " 1.1 labelled", " done", "\t", " é"];
		const endings = ["\n", "\r\n", "\n\n", ""];
		for (let round = 0; round < 25; round++) {
			let content = "";
			for (let line = 0, n = 1 + Math.floor(next() * 12); line < n; line++) {
				content += `${pick(markers)}${pick([" ", ""])}${pick(boxes)}${pick(texts)}${pick(endings)}`;
				if (next() < 0.2) content += `${pick(["# Heading", "text", "```", ""])}\n`;
			}
			expectParity(content);
		}
	}, 120_000);
});

describe("scanner details the CLI does not expose", () => {
	it("reports box positions and marker text for every checkbox line", () => {
		const content = "# T\n- [ ] A\n  * [x] B\n- [~] C\n- [ ]\n";
		const scanned = scanTasks(content);
		expect(scanned.map((t) => ({ line: t.line, marker: t.marker, text: content.slice(t.boxStart, t.boxEnd + 1) }))).toEqual([
			{ line: 1, marker: "", text: "[ ]" },
			{ line: 2, marker: "x", text: "[x]" },
			{ line: 3, marker: "~", text: "[~]" },
			{ line: 4, marker: "", text: "[ ]" },
		]);
	});

	it("keeps offsets correct across CRLF lines", () => {
		const content = "- [ ] A\r\n- [x] B\r\n";
		for (const t of scanTasks(content)) expect(content.slice(t.boxStart, t.boxEnd + 1)).toMatch(/^\[[ x]\]$/);
	});

	it("extracts a leading dotted label", () => {
		const listed = listTasks(scanTasks("- [ ] 3.4 Implement it\n- [ ] 12 Twelve\n- [ ] No label\n- [ ] 1.2.3.4 Deep\n- [ ] v2 not a label\n- [ ] 7up is a drink\n- [ ] 3.4: colon\n"));
		expect(listed.map((t) => t.label)).toEqual(["3.4", "12", undefined, "1.2.3.4", undefined, undefined, undefined]);
	});

	it("gives equal fingerprints to whitespace variants and different ones to different wording", () => {
		const [a, b, c] = listTasks(scanTasks("- [ ] Do  the   thing\n- [x]   Do the thing  \n- [ ] Do the other thing\n"));
		expect(a.fingerprint).toBe(b.fingerprint);
		expect(a.fingerprint).not.toBe(c.fingerprint);
	});
});
