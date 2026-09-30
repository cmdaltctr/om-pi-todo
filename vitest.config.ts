import { defineConfig } from "vitest/config";

// Test-only resolution of Pi host packages. The extension declares them as
// wildcard peers and never bundles or installs private copies, so tests borrow
// the copies from the Pi release that runs the extension.
const HOST = process.env.PI_HOST_MODULES ?? ".pi-host/node_modules";

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
