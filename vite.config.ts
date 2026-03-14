import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { loadBootConfig } from './boot-env.js';

export default defineConfig(({ command, mode }) => {
	// Validate boot config only when actually starting the dev server.
	// Builds and test runs don't bind to a network host.
	const server =
		command === 'serve' && mode !== 'test'
			? (() => {
					const b = loadBootConfig();
					return { host: b.host, port: b.port };
				})()
			: {};

	return {
		plugins: [tailwindcss(), sveltekit()],
		server
	};
});
