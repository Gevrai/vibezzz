/**
 * Webhook notification system.
 *
 * Sends JSON POST requests for important events when NOTIFY_WEBHOOK_URL
 * is configured.  Uses bearer-token authentication if a token is set.
 *
 * Failures are logged but never throw — notifications are best-effort.
 */

import { getConfig } from './config.js';

// ── Types ────────────────────────────────────────────────────────────

export type NotificationEvent =
	| 'preview_ready'
	| 'publish_succeeded'
	| 'run_failed'
	| 'run_completed';

export interface NotificationPayload {
	event: NotificationEvent;
	project: string;
	summary: string;
	url?: string;
	timestamp: string;
}

// ── In-memory recent notifications (for /monitor) ────────────────────

const MAX_RECENT = 50;
const recentNotifications: NotificationPayload[] = [];

export function getRecentNotifications(): readonly NotificationPayload[] {
	return recentNotifications;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Send a notification via the configured webhook.
 * No-op if NOTIFY_WEBHOOK_URL is not set.
 */
export async function notify(
	event: NotificationEvent,
	project: string,
	summary: string,
	url?: string
): Promise<void> {
	const payload: NotificationPayload = {
		event,
		project,
		summary,
		url,
		timestamp: new Date().toISOString()
	};

	// Always track in memory for the monitor page
	recentNotifications.unshift(payload);
	if (recentNotifications.length > MAX_RECENT) {
		recentNotifications.length = MAX_RECENT;
	}

	const config = getConfig();
	if (!config.notifyWebhookUrl) return;

	const headers: Record<string, string> = {
		'Content-Type': 'application/json'
	};
	if (config.notifyWebhookBearerToken) {
		headers['Authorization'] = `Bearer ${config.notifyWebhookBearerToken}`;
	}

	try {
		const resp = await fetch(config.notifyWebhookUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload)
		});
		if (!resp.ok) {
			console.warn(
				`[notify] Webhook returned ${resp.status} for event "${event}" (project: ${project})`
			);
		}
	} catch (err) {
		console.warn(`[notify] Webhook failed for event "${event}": ${(err as Error).message}`);
	}
}
