/**
 * Server hooks — runs once on startup.
 * Performs reconciliation of stale agent runs and preview processes.
 */

import { reconcileOnStartup } from '$lib/server/reconcile';

// Run reconciliation on startup (non-blocking)
reconcileOnStartup().catch((err) => {
	console.error('[hooks] Startup reconciliation failed:', err);
});
