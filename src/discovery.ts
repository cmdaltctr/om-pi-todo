/** Change discovery contract used by `/todo-settings`. The CLI-backed implementation is in `openspec/discover.ts`. */

export interface DiscoveredChange {
	name: string;
	supported: boolean;
	/** Why a change cannot be bound. Set when `supported` is false. */
	reason?: string;
}

export type Discovery =
	| { ok: true; root: string; /** How the CLI chose the root: nearest, declared, store, and so on. */ rootSource?: string; changes: DiscoveredChange[] }
	| { ok: false; error: string };

/** Resolve the planning root and changes visible from `cwd`. Never throws. */
export type ChangeDiscovery = (cwd: string, signal?: AbortSignal) => Promise<Discovery>;
