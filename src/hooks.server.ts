/**
 * Server hooks — runs once on startup.
 * Performs reconciliation of stale agent runs, preview processes, and publish state.
 * Also intercepts requests to lazy-published projects for wake-on-demand.
 */

import type { Handle } from '@sveltejs/kit';
import { reconcileOnStartup, reconciliationReady } from '$lib/server/reconcile';
import { isLazyHost, wakeAndProxy } from '$lib/server/publish';

// Run reconciliation on startup (non-blocking).
// The exported reconciliationReady() gate prevents mutating APIs from
// racing with in-memory rehydration.
reconcileOnStartup().catch((err) => {
	console.error('[hooks] Startup reconciliation failed:', err);
});

/**
 * SvelteKit handle hook.
 * Intercepts requests whose hostname matches a lazy-published subdomain,
 * wakes the container on demand, and redirects through Caddy's reverse
 * proxy (which fully supports WebSocket upgrades and long-lived traffic).
 */
export const handle: Handle = async ({ event, resolve }) => {
	const host = event.request.headers.get('host');
	if (host) {
		// Strip port from host header if present
		const hostname = host.split(':')[0];
		// Await reconciliation so the lazy registry is populated before
		// checking isLazyHost().  The promise resolves immediately after
		// the first startup reconciliation completes.
		await reconciliationReady();
		if (isLazyHost(hostname)) {
			const port = await wakeAndProxy(hostname);
			if (port) {
				// Container is running and Caddy route has been updated to
				// point directly to it.  Redirect (307 preserves method and
				// body) so the request goes through Caddy's full reverse
				// proxy, which handles WebSocket upgrades, SSE, and
				// long-lived connections without a timeout ceiling.
				const url = new URL(event.request.url);
				return new Response(null, {
					status: 307,
					headers: { Location: `https://${host}${url.pathname}${url.search}` }
				});
			} else {
				return new Response('Service unavailable — container failed to start', { status: 503 });
			}
		}
	}

	return resolve(event);
};
