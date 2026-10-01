/** A promise that stays pending until released, for holding one I/O stage open. */
export function gate() {
	let release!: () => void;
	const open = new Promise<void>((resolve) => (release = resolve));
	let entered = 0;
	return {
		open,
		release,
		/** Call at the start of the held stage; resolves once the gate is released. */
		async hold() {
			entered++;
			await open;
		},
		entered: () => entered,
	};
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until `check` is true, or fail after `ms`. No fixed sleeps in assertions. */
export async function until(check: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("until: condition not reached");
		await sleep(5);
	}
}

/**
 * Proves the event loop is not blocked: counts timer ticks while `work` runs and
 * returns them, so a test can require that ticks kept coming during the hold.
 */
export async function ticksDuring(ms: number): Promise<number> {
	let ticks = 0;
	const timer = setInterval(() => ticks++, 5);
	await sleep(ms);
	clearInterval(timer);
	return ticks;
}
