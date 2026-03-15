/**
 * Publish manager.
 *
 * Manages the lifecycle of published projects: starting/stopping containers,
 * registering Caddy routes, and persisting state in deploy.yaml.
 *
 * publish state transitions:
 *   down → up    : start container, register route to container
 *   down → lazy  : register wake route to vibebox app, container starts on first request
 *   up   → down  : stop container, remove route
 *   lazy → down  : remove wake route, stop container if running
 *   up   → lazy  : stop container, register wake route
 *   lazy → up    : start container, register direct route
 *
 * Lazy wake semantics:
 *   - Caddy route points to vibebox's own port
 *   - hooks.server.ts intercepts requests by hostname and calls wakeAndProxy()
 *   - wakeAndProxy() starts the container on demand, waits for health, proxies through
 *   - Background idle timer stops containers after idle_timeout seconds
 */

import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { readDeployConfig, writeDeployConfig, type DeployConfig } from './preview.js';
import { upsertRoute, removeRoute } from './caddy.js';
import { getConfig } from './config.js';
import { readYaml, writeYaml } from './yaml.js';
import { notify } from './notifications.js';
import { scanProjects } from './projects.js';

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

export interface PublishConfig {
	state: string;
	subdomain: string;
	url: string | null;
	image: string | null;
	container_name: string;
	container_id: string | null;
	container_port: number;
	host_port: number | null;
	idle_timeout: number;
	last_request_at: string | null;
	caddy_route_id: string;
}

// ── In-memory lazy tracking ─────────────────────────────────────────

interface LazyEntry {
	vibezzzDir: string;
	projectPath: string;
	containerName: string;
	containerPort: number;
	hostPort: number | null;
	image: string;
	idleTimeout: number;
	lastRequestAt: number;
	starting: boolean;
	startPromise: Promise<boolean> | null;
}

// Maps subdomain → lazy entry for fast lookup during request handling
const lazyRegistry = new Map<string, LazyEntry>();
let idleTimerHandle: ReturnType<typeof setInterval> | null = null;

// ── Host port allocation ────────────────────────────────────────────
//
// Published containers expose a dynamic host port distinct from their
// internal container_port so multiple apps can coexist without collision.
// Range: 40000-49999 (10 000 ports).

const HOST_PORT_START = 40000;
const HOST_PORT_END = 49999;
const allocatedHostPorts = new Set<number>();

/**
 * Check whether a port is actually free on the OS by attempting to bind it.
 */
function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.once('error', () => resolve(false));
		srv.listen(port, '0.0.0.0', () => {
			srv.close(() => resolve(true));
		});
	});
}

/**
 * Pick the next free host port that isn't already allocated in-memory
 * and isn't bound on the OS.
 */
async function allocateHostPort(): Promise<number> {
	for (let port = HOST_PORT_START; port <= HOST_PORT_END; port++) {
		if (allocatedHostPorts.has(port)) continue;
		if (!(await isPortFree(port))) continue;
		allocatedHostPorts.add(port);
		return port;
	}
	throw new Error('No free host ports in the publish range');
}

function releaseHostPort(port: number | null | undefined): void {
	if (port != null) allocatedHostPorts.delete(port);
}

function trackHostPort(port: number | null | undefined): void {
	if (port != null) allocatedHostPorts.add(port);
}

export function getLazyRegistry(): ReadonlyMap<string, LazyEntry> {
	return lazyRegistry;
}

// ── Helpers ──────────────────────────────────────────────────────────

function runtime(): string {
	return getConfig().containerRuntime;
}

// ── deploy.yaml serialization lock ──────────────────────────────────
//
// All async read-modify-write cycles on a project's deploy.yaml go through
// this per-directory lock so concurrent writers (idle timer, persistLastRequest,
// wakeAndProxy) don't clobber each other.

const deployLocks = new Map<string, Promise<void>>();

async function withDeployLock<T>(vibezzzDir: string, fn: () => Promise<T>): Promise<T> {
	const prev = deployLocks.get(vibezzzDir) ?? Promise.resolve();
	let release: () => void;
	const next = new Promise<void>((r) => { release = r; });
	deployLocks.set(vibezzzDir, next);

	await prev;
	try {
		return await fn();
	} finally {
		release!();
		if (deployLocks.get(vibezzzDir) === next) {
			deployLocks.delete(vibezzzDir);
		}
	}
}

export function defaultPublish(projectName: string): PublishConfig {
	const subdomain = projectName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
	return {
		state: 'down',
		subdomain,
		url: null,
		image: null,
		container_name: `vibebox-${subdomain}`,
		container_id: null,
		container_port: 3001,
		host_port: null,
		idle_timeout: 300,
		last_request_at: null,
		caddy_route_id: `vibebox-${subdomain}`
	};
}

export async function containerExists(name: string): Promise<boolean> {
	try {
		await execFileAsync(runtime(), ['inspect', name]);
		return true;
	} catch {
		return false;
	}
}

export async function containerIsRunning(name: string): Promise<boolean> {
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

export async function startContainer(
	name: string,
	image: string,
	containerPort: number,
	hostPort: number
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
			'-p', `${hostPort}:${containerPort}`,
			'--restart', 'unless-stopped',
			image
		]);
		return stdout.trim() || null;
	} catch (err) {
		console.error(`[publish] Failed to start container ${name}: ${(err as Error).message}`);
		return null;
	}
}

export async function stopContainer(name: string): Promise<void> {
	try {
		await execFileAsync(runtime(), ['stop', name], { timeout: 15_000 });
	} catch { /* already stopped or doesn't exist */ }
	try {
		await execFileAsync(runtime(), ['rm', '-f', name]);
	} catch { /* already removed */ }
}

async function waitForContainerHealthy(
	port: number,
	timeoutMs: number = 30_000,
	intervalMs: number = 500
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const resp = await fetch(`http://localhost:${port}/`, {
				signal: AbortSignal.timeout(2_000)
			});
			if (resp.ok) return true;
		} catch {
			/* not ready yet */
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return false;
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
	return withDeployLock(vibezzzDir, async () => {
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
	if (settings.subdomain !== undefined && settings.subdomain !== deploy.publish.subdomain) {
		const oldSubdomain = deploy.publish.subdomain;
		const oldRouteId = deploy.publish.caddy_route_id;
		const oldContainerName = deploy.publish.container_name;
		const previousState = deploy.publish.state;

		// Clean up stale routing/registry from the old subdomain when already published
		if (deploy.publish.state !== 'down') {
			await removeRoute(oldRouteId);
			lazyRegistry.delete(oldSubdomain);

			// Stop old container if running (name is changing)
			if (deploy.publish.container_id) {
				await stopContainer(oldContainerName);
				releaseHostPort(deploy.publish.host_port);
				deploy.publish.container_id = null;
				deploy.publish.host_port = null;
			}

			if (previousState === 'up') {
				deploy.publish.state = 'down';
				deploy.publish.url = null;
			}
			// For lazy: we'll re-register below after updating fields
		}

		deploy.publish.subdomain = settings.subdomain;
		deploy.publish.container_name = `vibebox-${settings.subdomain}`;
		deploy.publish.caddy_route_id = `vibebox-${settings.subdomain}`;

		// Re-register lazy routing with the new subdomain so the project
		// stays in lazy-published state instead of dropping to 'down'
		if (previousState === 'lazy' && deploy.publish.image) {
			const config = getConfig();
			const host = `${settings.subdomain}.${config.domain}`;
			await upsertRoute(deploy.publish.caddy_route_id, host, config.port);
			deploy.publish.url = `https://${host}`;

			registerLazy(settings.subdomain, {
				vibezzzDir,
				projectPath: projectName,
				containerName: deploy.publish.container_name,
				containerPort: deploy.publish.container_port,
				hostPort: null,
				image: deploy.publish.image,
				idleTimeout: deploy.publish.idle_timeout || config.lazyIdleTimeout,
				lastRequestAt: Date.now(),
				starting: false,
				startPromise: null
			});
		}
	}
	if (settings.container_port !== undefined) deploy.publish.container_port = settings.container_port;
	if (settings.idle_timeout !== undefined) deploy.publish.idle_timeout = settings.idle_timeout;

	// Sync updated settings to the in-memory lazy registry so wakeAndProxy() uses fresh values
	const lazyEntry = lazyRegistry.get(deploy.publish.subdomain);
	if (lazyEntry) {
		const config = getConfig();
		const imageChanged = settings.image !== undefined && settings.image !== lazyEntry.image;
		const portChanged = settings.container_port !== undefined && settings.container_port !== lazyEntry.containerPort;

		if (settings.container_port !== undefined) lazyEntry.containerPort = deploy.publish.container_port;
		if (settings.idle_timeout !== undefined)
			lazyEntry.idleTimeout = deploy.publish.idle_timeout || config.lazyIdleTimeout;
		if (settings.image !== undefined) lazyEntry.image = settings.image;

		// If image or port changed, stop the running container so the next
		// request triggers a fresh wake with the updated configuration.
		if (imageChanged || portChanged) {
			const running = await containerIsRunning(lazyEntry.containerName);
			if (running) {
				await stopContainer(lazyEntry.containerName);
				releaseHostPort(lazyEntry.hostPort);
				lazyEntry.hostPort = null;
				deploy.publish.container_id = null;
				deploy.publish.host_port = null;
			}
		}
	}

	await writeDeployConfig(vibezzzDir, deploy);
	return deploy;
	});
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
	return withDeployLock(vibezzzDir, async () => {
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

		// Remove from lazy registry if transitioning from lazy → up
		lazyRegistry.delete(pub.subdomain);

		// Release any previously allocated host port before allocating a new one
		releaseHostPort(pub.host_port);

		const hostPort = await allocateHostPort();
		const containerId = await startContainer(pub.container_name, pub.image, pub.container_port, hostPort);
		if (!containerId) {
			releaseHostPort(hostPort);
			throw new Error('Failed to start container');
		}

		const host = `${pub.subdomain}.${config.domain}`;
		await upsertRoute(pub.caddy_route_id, host, hostPort);

		pub.state = 'up';
		pub.container_id = containerId;
		pub.host_port = hostPort;
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

		// Register a wake route pointing to vibebox's own port so the
		// SvelteKit handle hook can intercept and start the container on demand
		const host = `${pub.subdomain}.${config.domain}`;
		await upsertRoute(pub.caddy_route_id, host, config.port);

		// Release any previously allocated host port — lazy allocates on wake
		releaseHostPort(pub.host_port);

		pub.state = 'lazy';
		pub.container_id = null;
		pub.host_port = null;
		pub.url = `https://${host}`;

		// Register in lazy in-memory map for wake-on-request
		registerLazy(pub.subdomain, {
			vibezzzDir,
			projectPath,
			containerName: pub.container_name,
			containerPort: pub.container_port,
			hostPort: null,
			image: pub.image,
			idleTimeout: pub.idle_timeout || config.lazyIdleTimeout,
			lastRequestAt: Date.now(),
			starting: false,
			startPromise: null
		});

		const metaPath = join(vibezzzDir, 'meta.yaml');
		const meta = await readYaml<Record<string, unknown> | null>(metaPath, null);
		if (meta) {
			meta.project_stage = 'published';
			await writeYaml(metaPath, meta);
		}

		await notify('publish_succeeded', projectPath, `Published ${projectPath} (lazy)`, pub.url);

	} else if (targetState === 'down') {
		// Stop container
		if (pub.container_id || await containerIsRunning(pub.container_name)) {
			await stopContainer(pub.container_name);
		}

		// Remove Caddy route and lazy registry entry
		await removeRoute(pub.caddy_route_id);
		lazyRegistry.delete(pub.subdomain);

		releaseHostPort(pub.host_port);

		pub.state = 'down';
		pub.container_id = null;
		pub.host_port = null;
		pub.url = null;

		// Only revert project_stage if it was set to 'published' by the publish flow.
		// Do NOT touch the stage if it's any other value — that would mutate
		// unrelated preview semantics (spec: "leave preview flow untouched").
		const metaPath = join(vibezzzDir, 'meta.yaml');
		const meta = await readYaml<Record<string, unknown> | null>(metaPath, null);
		if (meta && meta.project_stage === 'published') {
			// If preview is still active, revert to preview_ready rather than
			// building so the preview flow remains untouched.
			meta.project_stage =
				deploy.preview?.status === 'ready' ? 'preview_ready' : 'building';
			await writeYaml(metaPath, meta);
		}
	}

	await writeDeployConfig(vibezzzDir, deploy);
	return deploy;
	});
}

/**
 * Reconcile publish state on startup: verify container still exists,
 * re-register Caddy routes for published projects, populate lazy registry.
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
			releaseHostPort(pub.host_port);
			pub.state = 'down';
			pub.container_id = null;
			pub.host_port = null;
			pub.url = null;
			await removeRoute(pub.caddy_route_id);
			await writeDeployConfig(vibezzzDir, deploy);
			console.warn(`[publish] Reconcile: container ${pub.container_name} gone for ${projectPath}, marked down`);
			return;
		}
		// Track the host port so it won't be re-allocated
		trackHostPort(pub.host_port);
		// Re-register route pointing to the host port (or container port for legacy configs)
		if (pub.subdomain) {
			const host = `${pub.subdomain}.${config.domain}`;
			await upsertRoute(pub.caddy_route_id, host, pub.host_port ?? pub.container_port);
		}
	}

	if (pub.state === 'lazy' && pub.subdomain && pub.image) {
		// Clear stale container metadata (mirrors the 'up' reconciliation path)
		if (pub.container_id) {
			const running = await containerIsRunning(pub.container_name);
			if (!running) {
				releaseHostPort(pub.host_port);
				pub.container_id = null;
				pub.host_port = null;
				await writeDeployConfig(vibezzzDir, deploy);
				console.warn(`[publish] Reconcile: stale container_id cleared for lazy project ${projectPath}`);
			} else {
				// Container still running from before restart — track its host port
				trackHostPort(pub.host_port);
			}
		}

		// Re-register the wake route pointing to vibebox's own port
		const host = `${pub.subdomain}.${config.domain}`;
		await upsertRoute(pub.caddy_route_id, host, config.port);

		// Reuse persisted last_request_at so idle shutdown remains restart-stable
		const restoredLastRequest = pub.last_request_at
			? new Date(pub.last_request_at).getTime()
			: Date.now();

		// Re-populate the lazy registry
		registerLazy(pub.subdomain, {
			vibezzzDir,
			projectPath,
			containerName: pub.container_name,
			containerPort: pub.container_port,
			hostPort: pub.host_port ?? null,
			image: pub.image,
			idleTimeout: pub.idle_timeout || config.lazyIdleTimeout,
			lastRequestAt: restoredLastRequest,
			starting: false,
			startPromise: null
		});
	}
}

// ── Lazy wake-on-request ────────────────────────────────────────────

function registerLazy(subdomain: string, entry: LazyEntry): void {
	lazyRegistry.set(subdomain, entry);
	ensureIdleTimer();
}

/**
 * Check if a hostname matches a lazy-published project.
 */
export function isLazyHost(hostname: string): boolean {
	const config = getConfig();
	if (!hostname.endsWith(`.${config.domain}`)) return false;
	const subdomain = hostname.slice(0, -(config.domain.length + 1));
	return lazyRegistry.has(subdomain);
}

/**
 * Wake a lazy container on first request.
 * Returns the local port to proxy to, or null on failure.
 * Serializes concurrent wake attempts for the same subdomain.
 */
export async function wakeAndProxy(hostname: string): Promise<number | null> {
	const config = getConfig();
	if (!hostname.endsWith(`.${config.domain}`)) return null;
	const subdomain = hostname.slice(0, -(config.domain.length + 1));

	const entry = lazyRegistry.get(subdomain);
	if (!entry) return null;

	// Update last-request timestamp
	entry.lastRequestAt = Date.now();

	// Persist last_request_at to deploy.yaml (best-effort, non-blocking)
	persistLastRequest(entry).catch(() => {});

	// Check if container is already running
	const running = await containerIsRunning(entry.containerName);
	if (running && entry.hostPort) {
		return entry.hostPort;
	}

	// Serialize concurrent start attempts
	if (entry.startPromise) {
		const ok = await entry.startPromise;
		return ok ? entry.hostPort : null;
	}

	entry.starting = true;
	entry.startPromise = (async () => {
		try {
			// Allocate a fresh host port for this container
			releaseHostPort(entry.hostPort);
			const hostPort = await allocateHostPort();
			entry.hostPort = hostPort;

			const containerId = await startContainer(
				entry.containerName,
				entry.image,
				entry.containerPort,
				hostPort
			);
			if (!containerId) {
				releaseHostPort(hostPort);
				entry.hostPort = null;
				return false;
			}

			// Wait for the container to be healthy
			const healthy = await waitForContainerHealthy(hostPort);
			if (!healthy) {
				console.warn(`[publish] Lazy container ${entry.containerName} started but not healthy`);
				await stopContainer(entry.containerName);
				releaseHostPort(hostPort);
				entry.hostPort = null;
				return false;
			}

			// Persist container_id and host_port atomically via the deploy lock.
			// If persistence fails, roll back the running container and port
			// so we don't leak resources.
			try {
				await withDeployLock(entry.vibezzzDir, async () => {
					const deploy = await readDeployConfig(entry.vibezzzDir);
					if (deploy?.publish) {
						deploy.publish.container_id = containerId;
						deploy.publish.host_port = hostPort;
						deploy.publish.last_request_at = new Date().toISOString();
						await writeDeployConfig(entry.vibezzzDir, deploy);
					}
				});
			} catch (persistErr) {
				console.error(`[publish] Lazy wake persistence failed for ${entry.containerName}, rolling back: ${(persistErr as Error).message}`);
				await stopContainer(entry.containerName);
				releaseHostPort(hostPort);
				entry.hostPort = null;
				return false;
			}

			console.log(`[publish] Lazy wake: started ${entry.containerName} for ${subdomain}`);
			return true;
		} catch (err) {
			console.error(`[publish] Lazy wake failed for ${entry.containerName}: ${(err as Error).message}`);
			return false;
		} finally {
			entry.starting = false;
			entry.startPromise = null;
		}
	})();

	const ok = await entry.startPromise;
	return ok ? entry.hostPort : null;
}

async function persistLastRequest(entry: LazyEntry): Promise<void> {
	await withDeployLock(entry.vibezzzDir, async () => {
		const deploy = await readDeployConfig(entry.vibezzzDir);
		if (deploy?.publish) {
			deploy.publish.last_request_at = new Date().toISOString();
			await writeDeployConfig(entry.vibezzzDir, deploy);
		}
	});
}

// ── Idle timeout cleanup ────────────────────────────────────────────

function ensureIdleTimer(): void {
	if (idleTimerHandle) return;
	// Check every 60 seconds
	idleTimerHandle = setInterval(() => {
		checkIdleContainers().catch((err) => {
			console.warn(`[publish] Idle check error: ${(err as Error).message}`);
		});
	}, 60_000);
	// Don't hold the event loop open for this timer
	if (idleTimerHandle && typeof idleTimerHandle === 'object' && 'unref' in idleTimerHandle) {
		idleTimerHandle.unref();
	}
}

export async function checkIdleContainers(): Promise<void> {
	const now = Date.now();

	for (const [subdomain, entry] of lazyRegistry) {
		const idleMs = now - entry.lastRequestAt;
		const timeoutMs = (entry.idleTimeout || 300) * 1000;

		if (idleMs < timeoutMs) continue;

		// Check if container is actually running before stopping
		const running = await containerIsRunning(entry.containerName);
		if (!running) continue;

		console.log(
			`[publish] Idle shutdown: ${entry.containerName} idle for ${Math.round(idleMs / 1000)}s (timeout: ${entry.idleTimeout}s)`
		);

		await stopContainer(entry.containerName);

		// Release the host port and clear it from the entry
		releaseHostPort(entry.hostPort);
		entry.hostPort = null;

		// Update deploy.yaml under lock
		await withDeployLock(entry.vibezzzDir, async () => {
			const deploy = await readDeployConfig(entry.vibezzzDir);
			if (deploy?.publish) {
				deploy.publish.container_id = null;
				deploy.publish.host_port = null;
				await writeDeployConfig(entry.vibezzzDir, deploy);
			}
		});
	}
}

/**
 * Stop the idle timer. Used for testing cleanup.
 */
export function stopIdleTimer(): void {
	if (idleTimerHandle) {
		clearInterval(idleTimerHandle);
		idleTimerHandle = null;
	}
}

/**
 * Initialize lazy registry from all projects on startup.
 * Called from reconcileOnStartup after project scan.
 */
export async function initLazyRegistry(): Promise<void> {
	let projects;
	try {
		projects = await scanProjects();
	} catch {
		return;
	}

	const config = getConfig();

	for (const project of projects) {
		const absPath = join(config.projectsDir, project.path);
		const vibezzzDir = join(absPath, '.vibezzz');

		try {
			await reconcilePublish(vibezzzDir, project.path);
		} catch (err) {
			console.warn(`[publish] Failed to reconcile publish for ${project.path}: ${(err as Error).message}`);
		}
	}
}
