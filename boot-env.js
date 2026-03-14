/**
 * Boot-time env validation.
 * Used by vite.config.ts (dev) and start.js (prod) to enforce the
 * same env contract used by the SvelteKit runtime config.
 *
 * Required fields and parsing rules come from env-schema.js so
 * boot-time and runtime validation stay in sync.
 */
import { validateRequired, parsePort } from './env-schema.js';

/** @returns {{ host: string, port: number }} */
export function loadBootConfig() {
	validateRequired((name) => process.env[name]);
	return {
		host: /** @type {string} */ (process.env.BIND_HOST),
		port: parsePort(process.env.PORT)
	};
}
