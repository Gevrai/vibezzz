/**
 * Server hooks — runs once on startup.
 * Performs reconciliation of stale agent runs, preview processes, and publish state.
 * Also intercepts requests to lazy-published projects for wake-on-demand.
 */

import type { Handle } from '@sveltejs/kit';
import { reconcileOnStartup } from '$lib/server/reconcile';
import { isLazyHost, wakeAndProxy } from '$lib/server/publish';

// Run reconciliation on startup (non-blocking)
reconcileOnStartup().catch((err) => {
	console.error('[hooks] Startup reconciliation failed:', err);
});

/**
 * SvelteKit handle hook.
 * Intercepts requests whose hostname matches a lazy-published subdomain,
 * wakes the container on demand, and proxies the request through.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const host = event.request.headers.get('host');
	if (host) {
		// Strip port from host header if present
		const hostname = host.split(':')[0];
		if (isLazyHost(hostname)) {
			const port = await wakeAndProxy(hostname);
			if (port) {
				// Proxy the request to the container
				const url = new URL(event.request.url);
				const targetUrl = `http://localhost:${port}${url.pathname}${url.search}`;
				try {
					const proxyResp = await fetch(targetUrl, {
						method: event.request.method,
						headers: event.request.headers,
						body: event.request.method !== 'GET' && event.request.method !== 'HEAD'
							? event.request.body
							: undefined,
						signal: AbortSignal.timeout(30_000),
						// @ts-expect-error duplex needed for streaming body
						duplex: 'half'
					});
					return new Response(proxyResp.body, {
						status: proxyResp.status,
						statusText: proxyResp.statusText,
						headers: proxyResp.headers
					});
				} catch (err) {
					console.error(`[hooks] Proxy to lazy container failed: ${(err as Error).message}`);
					return new Response('Service temporarily unavailable', { status: 502 });
				}
			} else {
				return new Response('Service unavailable — container failed to start', { status: 503 });
			}
		}
	}

	return resolve(event);
};
