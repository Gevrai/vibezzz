/**
 * Publish manager.
 *
 * Manages the lifecycle of published projects: starting/stopping containers,
 * registering Caddy routes, and persisting state in deploy.yaml.
 *
 * publish state transitions:
 *   down → up    : start container, register route
 *   down → lazy  : register wake route (container starts on first request)
 *   up   → down  : stop container, remove route
 *   lazy → down  : remove wake route, stop container if running
 *   up   → lazy  : stop container, register wake route
 *   lazy → up    : start container, register direct route
 */

import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readDeployConfig, writeDeployConfig, type DeployConfig } from './preview.js';
import { upsertRoute, removeRoute } from './caddy.js';
import { getConfig } from './config.js';
import { readYaml, writeYaml } from './yaml.js';
import { notify } from './notifications.js';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────

export type PublishState = 'up' | 'down' | 'lazy';

export interface PublishSettings {
	image?: string;
	subdomain?: string;
	state?: PublishState;
	container_port?: number;
	idle_timeout?: number;
}

interface PublishConfig {
	state: string;
	subdomain: string;
	url: string | null;
	image: string | null;
	container_name: string;
	container_id: string | null;
	container_port: number;
	idle_timeout: number;
	last_request_at: string | null;
	caddy_route_id: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function runtime(): string {
	return getConfig().containerRuntime;
}

function defaultPublish(projectName: string): PublishConfig {
	const subdomain = projectName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
	return {
		state: 'down',
		subdomain,
		url: null,
		image: null,
		container_name: `vibebox-${subdomain}`,
		container_id: null,
		container_port: 3001,
		idle_timeout: 300,
		last_request_at: null,
		caddy_route_id: `vibebox-${subdomain}`
	};
}

async function containerExists(name: string): Promise<boolean> {
	try {
		await execFileAsync(runtime(), ['inspect', name]);
		return true;
	} catch {
		return false;
	}
}

async function containerIsRunning(name: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			runtime(),
			['inspect', '-f', '{{.State.Running}}', name]
		);
		return stdout.trim() === 'true';
	} catch {
		return false;
	}
}

async function startContainer(
	name: string,
	image: string,
	port: number
): Promise<string | null> {
	// Remove existing container if present
	if (await containerExists(name)) {
		try {
			await execFileAsync(runtime(), ['rm', '-f', name]);
		} catch { /* ignore */ }
	}

	try {
		const { stdout } = await execFileAsync(runtime(), [
			'run', '-d',
			'--name', name,
			'-p', `${port}:${port}`,
			'--restart', 'unless-stopped',
			image
		]);
		return stdout.trim() || null;
	} catch (err) {
		console.error(`[publish] Failed to start container ${name}: ${(err as Error).message}`);
		return null;
	}
}

async function stopContainer(name: string): Promise<void> {
	try {
		await execFileAsync(runtime(), ['stop', name], { timeout: 15_000 });
	} catch { /* already stopped or doesn't exist */ }
	try {
		await execFileAsync(runtime(), ['rm', '-f', name]);
	} catch { /* already removed */ }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Update publish settings in deploy.yaml without changing state.
 */
export async function updatePublishSettings(
	vibezzzDir: string,
	projectName: string,
	settings: PublishSettings
): Promise<DeployConfig> {
	const deploy = (await readDeployConfig(vibezzzDir)) ?? {
		preview: {
			command: '',
			port: 3001,
			healthcheck_path: '/',
			pid: null,
			process_started_at: null,
			status: 'stopped' as const,
			subdomain: '',
			url: null,
			public: true,
			last_ready_at: null
		}
	};

	if (!deploy.publish) {
		deploy.publish = defaultPublish(projectName);
	}

	if (settings.image !== undefined) deploy.publish.image = settings.image;
	if (settings.subdomain !== undefined) {
		deploy.publish.subdomain = settings.subdomain;
		deploy.publish.container_name = `vibebox-${settings.subdomain}`;
		deploy.publish.caddy_route_id = `vibebox-${settings.subdomain}`;
	}
	if (settings.container_port !== undefined) deploy.publish.container_port = settings.container_port;
	if (settings.idle_timeout !== undefined) deploy.publish.idle_timeout = settings.idle_timeout;

	await writeDeployConfig(vibezzzDir, deploy);
	return deploy;
}

/**
 * Apply a publish state transition (up, down, or lazy).
 */
export async function applyPublishState(
	vibezzzDir: string,
	projectPath: string,
	projectName: string,
	targetState: PublishState
): Promise<DeployConfig> {
	const config = getConfig();

	const deploy = (await readDeployConfig(vibezzzDir)) ?? {
		preview: {
			command: '',
			port: 3001,
			healthcheck_path: '/',
			pid: null,
			process_started_at: null,
			status: 'stopped' as const,
			subdomain: '',
			url: null,
			public: true,
			last_ready_at: null
		}
	};

	if (!deploy.publish) {
		deploy.publish = defaultPublish(projectName);
	}

	const pub = deploy.publish;

	if (targetState === 'up') {
		if (!pub.image) {
			throw new Error('Cannot publish: no container image configured');
		}
		if (!pub.subdomain) {
			throw new Error('Cannot publish: no subdomain configured');
		}

		const containerId = await startContainer(pub.container_name, pub.image, pub.container_port);
		if (!containerId) {
			throw new Error('Failed to start container');
		}

		const host = `${pub.subdomain}.${config.domain}`;
		await upsertRoute(pub.caddy_route_id, host, pub.container_port);

		pub.state = 'up';
		pub.container_id = containerId;
		pub.url = `https://${host}`;

		// Update project stage
		const metaPath = join(vibezzzDir, 'meta.yaml');
		const meta = await readYaml<Record<string, unknown> | null>(metaPath, null);
		if (meta) {
			meta.project_stage = 'published';
			await writeYaml(metaPath, meta);
		}

		await notify('publish_succeeded', projectPath, `Published ${projectPath}`, pub.url);

	} else if (targetState === 'lazy') {
		if (!pub.image) {
			throw new Error('Cannot set lazy publish: no container image configured');
		}
		if (!pub.subdomain) {
			throw new Error('Cannot set lazy publish: no subdomain configured');
		}

		// Stop container if running (lazy starts on demand)
		if (pub.container_id) {
			await stopContainer(pub.container_name);
		}

		// Register a wake route pointing to vibebox itself (the app will
		// start the container on first request in a future middleware).
		// For now, register a route to the container port so it works when started.
		const host = `${pub.subdomain}.${config.domain}`;
		await upsertRoute(pub.caddy_route_id, host, pub.container_port);

		pub.state = 'lazy';
		pub.container_id = null;
		pub.url = `https://${host}`;

		const metaPath = join(vibezzzDir, 'meta.yaml');
		const meta = await readYaml<Record<string, unknown> | null>(metaPath, null);
		if (meta) {
			meta.project_stage = 'published';
			await writeYaml(metaPath, meta);
		}

	} else if (targetState === 'down') {
		// Stop container
		if (pub.container_id || await containerIsRunning(pub.container_name)) {
			await stopContainer(pub.container_name);
		}

		// Remove Caddy route
		await removeRoute(pub.caddy_route_id);

		pub.state = 'down';
		pub.container_id = null;
		// Keep url as null when down
		pub.url = null;

		// Revert stage to preview_ready or building (don't regress to paused)
		const metaPath = join(vibezzzDir, 'meta.yaml');
		const meta = await readYaml<Record<string, unknown> | null>(metaPath, null);
		if (meta && meta.project_stage === 'published') {
			meta.project_stage = 'preview_ready';
			await writeYaml(metaPath, meta);
		}
	}

	await writeDeployConfig(vibezzzDir, deploy);
	return deploy;
}

/**
 * Reconcile publish state on startup: verify container still exists,
 * re-register Caddy routes for published projects.
 */
export async function reconcilePublish(
	vibezzzDir: string,
	projectPath: string
): Promise<void> {
	const deploy = await readDeployConfig(vibezzzDir);
	if (!deploy?.publish) return;

	const pub = deploy.publish;
	const config = getConfig();

	if (pub.state === 'up' && pub.container_id) {
		const running = await containerIsRunning(pub.container_name);
		if (!running) {
			// Container is gone — mark as down
			pub.state = 'down';
			pub.container_id = null;
			pub.url = null;
			await removeRoute(pub.caddy_route_id);
			await writeDeployConfig(vibezzzDir, deploy);
			console.warn(`[publish] Reconcile: container ${pub.container_name} gone for ${projectPath}, marked down`);
			return;
		}
		// Re-register route
		if (pub.subdomain) {
			const host = `${pub.subdomain}.${config.domain}`;
			await upsertRoute(pub.caddy_route_id, host, pub.container_port);
		}
	}

	if (pub.state === 'lazy' && pub.subdomain) {
		// Re-register the wake route
		const host = `${pub.subdomain}.${config.domain}`;
		await upsertRoute(pub.caddy_route_id, host, pub.container_port);
	}
}
