import type { TaskState } from "../state/state.js";

/** Counts shown in the panel heading when OpenSpec sync is on. */
export interface PanelSections {
	/** OpenSpec's own task progress, the same numbers `/todos` reports. */
	openspec: { complete: number; total: number; freshness: string; refreshing?: boolean };
	/** The session's incidental tasks, kept apart from OpenSpec progress. */
	incidental: { complete: number; total: number };
}

/** Everything the panel needs, from one committed snapshot. */
export interface PanelModel {
	state: TaskState;
	/** Absent in normal mode. */
	sections?: PanelSections;
}
