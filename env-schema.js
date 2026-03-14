/**
 * Shared environment schema — single source of truth for required env vars
 * and common parsing rules.
 *
 * Environment-agnostic: callers supply their own env-getter so this works
 * at boot time (process.env) and inside SvelteKit ($env/dynamic/private).
 */

/** Env vars that must be set for the app to function. */
export const REQUIRED_ENV = /** @type {const} */ ([
	'BIND_HOST',
	'PROJECTS_DIR',
	'VIBEZZZ_REPO',
	'DOMAIN'
]);

/**
 * Validate that every required env var has a non-empty value.
 * @param {(name: string) => string | undefined} get
 */
export function validateRequired(get) {
	const missing = REQUIRED_ENV.filter((name) => !get(name));
	if (missing.length > 0) {
		throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
	}
}

/**
 * Parse a PORT string into a validated integer.
 * @param {string | undefined} raw
 * @param {number} [fallback=3000]
 * @returns {number}
 */
export function parsePort(raw, fallback = 3000) {
	if (raw == null || raw === '') return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`PORT must be a valid integer (1–65535), got: ${raw}`);
	}
	return parsed;
}
