import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOpenspecJson } from "../src/openspec/exec.js";

/** A fake `openspec` whose behaviour is chosen by its first argument. */
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const [mode, ...rest] = process.argv.slice(2);
const out = (s) => process.stdout.write(s);
switch (mode) {
	case "echo": out(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })); break;
	case "bad-json": out("this is not json"); break;
	case "empty": break;
	case "array": out("[1,2]"); break;
	case "null": out("null"); break;
	case "exit2": process.stderr.write("boom: something failed\\n"); process.exit(2); break;
	case "exit-json": out(JSON.stringify({ status: [{ severity: "error", code: "change_error", message: "Change 'x' not found. Available changes:\\n  a\\n  b" }] })); process.exit(1); break;
	case "exit-text": out("plain failure text on stdout\\n"); process.exit(3); break;
	case "exit-both": out("stdout detail\\n"); process.stderr.write("stderr detail\\n"); process.exit(4); break;
	case "exit-long": process.stderr.write("y".repeat(5000)); process.exit(5); break;
	case "stderr-ok": process.stderr.write("warning: deprecated\\n"); out("{}"); break;
	case "huge": out("x".repeat(6 * 1024 * 1024)); break;
	case "marker": fs.writeFileSync(rest[0], "ran"); out("{}"); break;
	case "slow": fs.writeFileSync(rest[0], String(process.pid)); setInterval(() => {}, 1000); break;
	case "stubborn": process.on("SIGTERM", () => {}); fs.writeFileSync(rest[0], String(process.pid)); setInterval(() => {}, 1000); break;
	default: out("{}");
}
`;

let dir = "";
let fake = "";
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-todo-exec-"));
	fake = join(dir, "fake-openspec");
	writeFileSync(fake, FAKE);
	chmodSync(fake, 0o755);
	mkdirSync(join(dir, "work"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const work = () => join(dir, "work");
const run = (args: string[], extra: Record<string, unknown> = {}) => runOpenspecJson(args, { cwd: work(), command: fake, ...extra });

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

describe("arguments and working directory", () => {
	it("runs in the explicit absolute directory", async () => {
		const result = await run(["echo"]);
		expect(result.ok).toBe(true);
		expect(result.ok && (result.json as any).cwd).toBe(require("node:fs").realpathSync(work()));
	});

	it("passes every argument literally, with no shell interpretation", async () => {
		const hostile = ["; touch PWNED", "$(touch PWNED)", "`touch PWNED`", "a b  c", "'quoted'", '"double"', "--json; rm -rf /", "*", "\n"];
		const result = await run(["echo", ...hostile]);
		expect(result.ok && (result.json as any).args).toEqual(["echo", ...hostile]);
		expect(existsSync(join(work(), "PWNED"))).toBe(false);
	});

	it("rejects a relative working directory without spawning", async () => {
		const marker = join(dir, "never");
		const result = await runOpenspecJson(["marker", marker], { cwd: "relative/dir", command: fake });
		expect(result).toMatchObject({ ok: false, kind: "invalid-cwd" });
		expect(existsSync(marker)).toBe(false);
	});

	it("reports a missing working directory", async () => {
		const result = await runOpenspecJson(["echo"], { cwd: join(dir, "does-not-exist"), command: fake });
		expect(result).toMatchObject({ ok: false, kind: "spawn" });
	});

	it("reports a missing executable", async () => {
		const result = await runOpenspecJson(["echo"], { cwd: work(), command: join(dir, "no-such-binary") });
		expect(result).toMatchObject({ ok: false, kind: "spawn" });
	});
});

describe("output handling", () => {
	it("parses JSON output and keeps stderr separate", async () => {
		const result = await run(["stderr-ok"]);
		expect(result).toEqual({ ok: true, json: {}, stderr: "warning: deprecated\n" });
	});

	it("reports malformed, empty, and non-JSON output", async () => {
		for (const mode of ["bad-json", "empty"]) expect(await run([mode])).toMatchObject({ ok: false, kind: "malformed" });
	});

	it("returns any JSON value and leaves shape checks to the caller", async () => {
		expect(await run(["array"])).toMatchObject({ ok: true, json: [1, 2] });
		expect(await run(["null"])).toMatchObject({ ok: true, json: null });
	});

	it("reports a non-zero exit with its code and stderr", async () => {
		const result = await run(["exit2"]);
		expect(result).toMatchObject({ ok: false, kind: "exit" });
		expect(!result.ok && result.message).toContain("2");
		expect(!result.ok && result.message).toContain("boom: something failed");
	});

	it("reads the failure detail from stdout when stderr is empty, as the real CLI reports errors", async () => {
		const result = await run(["exit-json"]);
		expect(result).toMatchObject({ ok: false, kind: "exit" });
		expect(!result.ok && result.message).toBe("OpenSpec exited with code 1: Change 'x' not found. Available changes:");
	});

	it("falls back to plain stdout text, and prefers stderr when both exist", async () => {
		expect(await run(["exit-text"])).toMatchObject({ ok: false, message: "OpenSpec exited with code 3: plain failure text on stdout" });
		const both = await run(["exit-both"]);
		expect(!both.ok && both.message).toBe("OpenSpec exited with code 4: stderr detail");
	});

	it("bounds the failure detail", async () => {
		const result = await run(["exit-long"]);
		expect(!result.ok && result.message.length).toBeLessThan(600);
	});

	it("stops and reports output larger than the limit", async () => {
		const result = await run(["huge"], { maxBytes: 1024 * 1024 });
		expect(result).toMatchObject({ ok: false, kind: "output-too-large" });
	});
});

describe("timeouts and cancellation", () => {
	it("kills a slow process at the timeout", async () => {
		const pidFile = join(dir, "slow.pid");
		const started = Date.now();
		const result = await run(["slow", pidFile], { timeoutMs: 400 });
		expect(result).toMatchObject({ ok: false, kind: "timeout" });
		expect(Date.now() - started).toBeLessThan(4000);
		const pid = Number(readFileSync(pidFile, "utf-8"));
		expect(alive(pid)).toBe(false); // gone before the result was returned
	});

	it("kills a process that ignores the first signal", async () => {
		const pidFile = join(dir, "stubborn.pid");
		const result = await run(["stubborn", pidFile], { timeoutMs: 300, killGraceMs: 200 });
		expect(result).toMatchObject({ ok: false, kind: "timeout" });
		const pid = Number(readFileSync(pidFile, "utf-8"));
		expect(alive(pid)).toBe(false); // gone before the result was returned
	});

	it("cancels a running process through the abort signal", async () => {
		const pidFile = join(dir, "cancel.pid");
		const controller = new AbortController();
		const pending = run(["slow", pidFile], { signal: controller.signal, timeoutMs: 20_000 });
		await waitFor(() => existsSync(pidFile));
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, kind: "cancelled" });
		const pid = Number(readFileSync(pidFile, "utf-8"));
		expect(alive(pid)).toBe(false); // gone before the result was returned
	});

	it("does not start when the signal is already aborted", async () => {
		const marker = join(dir, "marker-aborted");
		const controller = new AbortController();
		controller.abort();
		const result = await run(["marker", marker], { signal: controller.signal });
		expect(result).toMatchObject({ ok: false, kind: "cancelled" });
		await new Promise((r) => setTimeout(r, 150));
		expect(existsSync(marker)).toBe(false);
	});

	it("settles once and ignores an abort after completion", async () => {
		const controller = new AbortController();
		const result = await run(["echo"], { signal: controller.signal });
		expect(result.ok).toBe(true);
		expect(() => controller.abort()).not.toThrow();
	});

	it("lets one failure leave later calls working", async () => {
		expect(await run(["exit2"])).toMatchObject({ ok: false });
		expect(await run(["echo"])).toMatchObject({ ok: true });
	});
});
