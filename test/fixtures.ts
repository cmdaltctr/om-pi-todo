import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A disposable OpenSpec root holding changes the real CLI can read. */
export function createOpenspecRoot() {
	const root = mkdtempSync(join(tmpdir(), "pi-todo-root-"));
	return {
		root,
		/** Write a spec-driven change whose tasks.md holds exactly `tasks` (a string or bytes). */
		addChange(name: string, tasks: string | Buffer, schema = "spec-driven") {
			const dir = join(root, "openspec", "changes", name);
			mkdirSync(join(dir, "specs", "cap"), { recursive: true });
			writeFileSync(join(dir, ".openspec.yaml"), `schema: ${schema}\ncreated: 2026-09-30\n`);
			writeFileSync(join(dir, "proposal.md"), "# Proposal\n");
			writeFileSync(join(dir, "design.md"), "# Design\n");
			writeFileSync(join(dir, "specs", "cap", "spec.md"), "# Spec\n");
			writeFileSync(join(dir, "tasks.md"), tasks);
			return { dir, tasksPath: join(dir, "tasks.md") };
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
