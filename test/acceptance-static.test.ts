import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..", "src");
const files = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
	});
const sources = files(SRC).map((path) => ({
	path: path.slice(SRC.length + 1),
	text: readFileSync(path, "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
}));

describe("asynchronous contract, checked in the source", () => {
	it("runtime code never calls a synchronous file, process or wait API", () => {
		const forbidden =
			/\b(readFileSync|writeFileSync|appendFileSync|existsSync|statSync|lstatSync|mkdirSync|readdirSync|renameSync|unlinkSync|rmSync|copyFileSync|openSync|closeSync|accessSync|realpathSync|execSync|execFileSync|spawnSync|Atomics\.wait)\b/;
		expect(sources.filter((s) => forbidden.test(s.text)).map((s) => s.path)).toEqual([]);
	});

	it("render code imports no file, process or network module", () => {
		const render = sources.filter((s) =>
			["todo-overlay.ts", "view/format.ts", "view/presentation.ts", "view/panel-model.ts", "sync/text.ts"].includes(
				s.path,
			),
		);
		expect(render).toHaveLength(5);
		for (const s of render)
			expect(s.text, s.path).not.toMatch(
				/from "node:(fs|child_process|net|http|https|dns|worker_threads)(\/promises)?"/,
			);
	});

	it("no busy waiting: no loop spins on Date.now() without an await", () => {
		for (const s of sources) {
			for (const m of s.text.matchAll(/while\s*\([^)]*Date\.now\(\)[^)]*\)\s*\{([^}]*)\}/g))
				expect(m[1], s.path).toMatch(/await/);
		}
	});

	it("every setTimeout or setInterval in runtime code is cleared or unref'd", () => {
		for (const s of sources) {
			const starts = [...s.text.matchAll(/\b(setTimeout|setInterval)\(/g)].length;
			if (starts === 0) continue;
			expect(s.text, s.path).toMatch(/clearTimeout|clearInterval|\.unref\??\.?\(|removeEventListener/);
		}
	});
});
