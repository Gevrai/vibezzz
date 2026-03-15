/**
 * Caddy reverse-proxy route management via the admin API.
 *
 * All operations are safe when Caddy is unavailable — they log warnings
 * and return gracefully rather than crashing the app.
 */

import { getConfig } from './config.js';

// ── Types ────────────────────────────────────────────────────────────

export interface CaddyRoute {
	'@id': string;
	match: Array<{ host: string[] }>;
	handle: Array<{
		handler: string;
		upstreams?: Array<{ dial: string }>;
		routes?: unknown[];
	}>;
	terminal?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

function adminUrl(): string {
	return getConfig().caddyAdminUrl;
}

async function caddyFetch(
	path: string,
	init?: RequestInit
): Promise<{ ok: boolean; status: number; body: unknown }> {
	const url = `${adminUrl()}${path}`;
	try {
		const resp = await fetch(url, {
			...init,
			headers: {
				'Content-Type': 'application/json',
				...(init?.headers ?? {})
			}
		});
		let body: unknown = null;
		try {
			body = await resp.json();
		} catch {
			/* empty or non-JSON response */
		}
		return { ok: resp.ok, status: resp.status, body };
	} catch (err) {
		console.warn(`[caddy] Request failed (${url}): ${(err as Error).message}`);
		return { ok: false, status: 0, body: null };
	}
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Upsert a named route that reverse-proxies `host` → `localhost:port`.
 */
export async function upsertRoute(
	routeId: string,
	host: string,
	port: number
): Promise<boolean> {
	const route: CaddyRoute = {
		'@id': routeId,
		match: [{ host: [host] }],
		handle: [
			{
				handler: 'reverse_proxy',
				upstreams: [{ dial: `localhost:${port}` }]
			}
		],
		terminal: true
	};

	// Try PATCH first (update existing), fall back to POST (create new)
	const patch = await caddyFetch(`/id/${routeId}`, {
		method: 'PATCH',
		body: JSON.stringify(route)
	});

	if (patch.ok) return true;

	// Route doesn't exist yet — add it via config path
	const post = await caddyFetch('/config/apps/http/servers/srv0/routes', {
		method: 'POST',
		body: JSON.stringify(route)
	});

	if (post.ok) return true;

	console.warn(`[caddy] Failed to upsert route ${routeId} (status ${patch.status}/${post.status})`);
	return false;
}

/**
 * Remove a named route by its `@id`.
 */
export async function removeRoute(routeId: string): Promise<boolean> {
	const res = await caddyFetch(`/id/${routeId}`, { method: 'DELETE' });
	if (res.ok || res.status === 404) return true;
	console.warn(`[caddy] Failed to remove route ${routeId} (status ${res.status})`);
	return false;
}

/**
 * Check whether Caddy admin API is reachable.
 */
export async function isCaddyAvailable(): Promise<boolean> {
	const res = await caddyFetch('/config/');
	return res.ok;
}
