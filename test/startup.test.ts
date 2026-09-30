import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Starts a real Pi (RPC mode, offline, no model call) in an isolated agent
 * directory that holds no `rpiv-*` package, and loads this project's real
 * `package.json` as an extension package. Pi has no entry point here yet, so a
 * throwaway shim re-exports the extension factory and adds a probe command that
 * drives the registered `todo` tool inside the real host.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_AVAILABLE = spawnSync("pi", ["--version"], { encoding: "utf-8" }).status === 0;

const SHIM = `import extension from ${JSON.stringify(join(ROOT, "src/extension.ts"))};

export default async function (pi: any) {
	let tool: any;
	const wrapped = new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") return (def: any) => { tool = def; return target.registerTool(def); };
			const value = target[key];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	await extension(wrapped);
	pi.registerCommand("todo-probe", {
		description: "Drive the todo tool through the real host",
		handler: async (_args: string, ctx: any) => {
			const out: string[] = [];
			for (const params of [
				{ action: "create", subject: "Probe task" },
				{ action: "update", id: 1, status: "completed" },
				{ action: "list" },
			]) {
				out.push((await tool.execute("probe", params, undefined, undefined, ctx)).content[0].text);
			}
			ctx.ui.notify("PROBE:" + JSON.stringify(out), "info");
		},
	});
}
`;

const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface Session {
	agentDir: string;
	commands: string[];
	probe: string[];
	stderr: string;
}

/** Load the real manifest (plus an entry declaration) in a fresh Pi and run the probe. */
async function startPi(manifestEdit: (m: Record<string, any>) => void = () => undefined): Promise<Session> {
	const base = mkdtempSync(join(tmpdir(), "pi-todo-startup-"));
	scratch.push(base);
	const pkgDir = join(base, "pkg");
	const agentDir = join(base, "agent");
	const workDir = join(base, "work");
	for (const dir of [pkgDir, agentDir, workDir]) mkdirSync(dir);

	const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
	delete manifest.devDependencies;
	manifest.pi = { extensions: ["./shim.ts"] };
	manifestEdit(manifest);
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest));
	writeFileSync(join(pkgDir, "shim.ts"), SHIM);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkgDir] }));

	const child = spawn(
		"pi",
		["--mode", "rpc", "--no-session", "--offline", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes"],
		{ cwd: workDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => (stdout += d));
	child.stderr.on("data", (d) => (stderr += d));

	const events = () =>
		stdout
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.flatMap((l) => {
				try {
					return [JSON.parse(l)];
				} catch {
					return [];
				}
			});
	child.stdin.write(`${JSON.stringify({ id: "c", type: "get_commands" })}\n`);
	child.stdin.write(`${JSON.stringify({ id: "p", type: "prompt", message: "/todo-probe" })}\n`);

	const deadline = Date.now() + 30_000;
	const done = () => events().some((e) => e.id === "c") && events().some((e) => e.id === "p");
	while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	child.kill();

	const all = events();
	const commands: string[] = all.find((e) => e.id === "c")?.data?.commands?.map((c: any) => c.name) ?? [];
	const note = all.find((e) => e.method === "notify" && String(e.message).startsWith("PROBE:"));
	return { agentDir, commands, probe: note ? JSON.parse(String(note.message).slice(6)) : [], stderr };
}

describe.skipIf(!PI_AVAILABLE)("isolated Pi startup without rpiv packages", () => {
	it("loads with task operations working and no packaging warning", async () => {
		const session = await startPi();
		expect(readdirSync(session.agentDir, { recursive: true }).map(String).filter((f) => /rpiv|juicesharp/.test(f))).toEqual([]);
		expect(readdirSync(session.agentDir)).not.toContain("npm");
		expect(session.commands).toEqual(expect.arrayContaining(["todos", "todo-settings"]));
		expect(session.probe).toEqual(["Created #1: Probe task (pending)", "Updated #1 (pending → completed)", "[completed] #1 Probe task"]);
		expect(session.stderr).not.toMatch(/Host-provided extension packages|Extension package/);
	}, 60_000);

	it("would show Pi's packaging warning if a host package were a runtime dependency", async () => {
		const session = await startPi((m) => {
			m.dependencies = { typebox: "^1.1.24" };
		});
		expect(session.stderr).toMatch(/Host-provided extension packages must be declared in peerDependencies/);
	}, 60_000);
});
