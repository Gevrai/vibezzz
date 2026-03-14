/**
 * Shared boot-time env validation.
 * Used by vite.config.ts (dev) and start.js (prod) to enforce the
 * same env contract declared in src/lib/server/config.ts.
 *
 * Cannot import the SvelteKit config module directly because it
 * depends on $env/dynamic/private which is only available at runtime.
 */

/** @param {string} name */
export function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

/** @returns {{ host: string, port: number }} */
export function loadBootConfig() {
	return {
		host: requireEnv('BIND_HOST'),
		port: parseInt(process.env.PORT || '3000', 10)
	};
}
