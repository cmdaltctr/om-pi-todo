/**
 * Display text helpers. The UI is English only. `t(key, fallback)` returns
 * the fallback, so every call site keeps its inline British English literal.
 *
 * Call sites MUST use this module at render time, never bake the result into
 * a top-level `const`.
 */

import type { TaskStatus } from "../tool/types.js";

export function t(_key: string, fallback: string): string {
	return fallback;
}

export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "in progress";
		case "completed":
			return "completed";
		case "deleted":
			return "deleted";
	}
}
