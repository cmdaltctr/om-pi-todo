import { defineConfig } from "vitest/config";

import { resolve } from "node:path";

// Test-only resolution of Pi host packages. The extension declares them as
// wildcard peers and never bundles or installs private copies, so tests borrow
// them from `.pi-host/`. Run `scripts/setup-host.sh` to create it.
const HOST = process.env.PI_HOST_MODULES ?? resolve(__dirname, ".pi-host/node_modules");

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^typebox$/, replacement: `${HOST}/typebox/build/index.mjs` },
			{ find: /^@earendil-works\/pi-ai$/, replacement: `${HOST}/@earendil-works/pi-ai/dist/index.js` },
			{ find: /^@earendil-works\/pi-tui$/, replacement: `${HOST}/@earendil-works/pi-tui/dist/index.js` },
			{
				find: /^@earendil-works\/pi-coding-agent$/,
				replacement: `${HOST}/@earendil-works/pi-coding-agent/dist/index.js`,
			},
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
