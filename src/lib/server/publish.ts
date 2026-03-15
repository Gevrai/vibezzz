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
import { realpath } from 'node:fs/promises';
import { readDeployConfig, writeDeployConfig, type DeployConfig } from './preview.js';
import { upsertRoute, removeRoute } from './caddy.js';
import { getConfig } from './config.js';
import { readYaml, writeYaml } from './yaml.js';
import { notify } from './notifications.js';
import { scanProjects } from './projects.js';
import { withDeployLock, withSubdomainClaimLock } from './deploy-lock.js';

/**
 * Thrown when a subdomain is already claimed by another project.
 * Endpoints should catch this and return a 400/409 response.
 */
export class SubdomainConflictError extends Error {
	constructor(subdomain: string) {
		super(`Subdomain '${subdomain}' is already claimed by another project`);
		this.name = 'SubdomainConflictError';
	}
}

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
	startPromise: Promise<number | null> | null;
	/** Set during unpublish to prevent in-flight wakes from reviving state. */
	disabled: boolean;
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
 * Serialization queue for host-port allocation.
 *
 * allocateHostPort()'s check/probe/add sequence is non-atomic across
 * concurrent callers (e.g. parallel lazy wakes for different subdomains).
 * This global queue ensures only one allocation runs at a time.
 */
let portAllocationQueue = Promise.resolve();

/**
 * Pick the next free host port that isn't already allocated in-memory
 * and isn't bound on the OS.  Serialized via portAllocationQueue so
 * concurrent callers cannot race on the same port.
 */
async function allocateHostPort(): Promise<number> {
	let release!: () => void;
	const next = new Promise<void>((r) => { release = r; });
	const prev = portAllocationQueue;
	portAllocationQueue = next;

	await prev;
	try {
		for (let port = HOST_PORT_START; port <= HOST_PORT_END; port++) {
			if (allocatedHostPorts.has(port)) continue;
			if (!(await isPortFree(port))) continue;
			allocatedHostPorts.add(port);
			return port;
		}
		throw new Error('No free host ports in the publish range');
	} finally {
		release();
	}
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

/**
 * Check if a subdomain is already claimed by another project.
 * Checks both the in-memory lazy registry and persisted deploy configs.
 */
async function isSubdomainClaimedByOther(
	subdomain: string,
	currentVibezzzDir: string
): Promise<boolean> {
	// Fast path: check in-memory lazy registry
	const lazyEntry = lazyRegistry.get(subdomain);
	if (lazyEntry && lazyEntry.vibezzzDir !== currentVibezzzDir) {
		return true;
	}

	// Full check: scan all project deploy configs on disk
	let projects;
	try {
		projects = await scanProjects();
	} catch {
		return false;
	}

	const config = getConfig();
	let resolvedProjectsDir: string;
	try {
		resolvedProjectsDir = await realpath(config.projectsDir);
	} catch {
		return false;
	}

	for (const project of projects) {
		const projectVibezzzDir = join(resolvedProjectsDir, project.path, '.vibezzz');
		if (projectVibezzzDir === currentVibezzzDir) continue;
		try {
			const deploy = await readDeployConfig(projectVibezzzDir);
			if (deploy?.publish?.subdomain === subdomain) {
				return true;
			}
		} catch {
			continue;
		}
	}

	return false;
}

// ── Helpers ──────────────────────────────────────────────────────────

function runtime(): string {
	return getConfig().containerRuntime;
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
	return withSubdomainClaimLock(() => withDeployLock(vibezzzDir, async () => {
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

	// Track deferred live side-effects for after the persist step
	let oldRouteToRemove: string | null = null;
	let oldSubdomainToDelete: string | null = null;
	let lazyReRegistration: (() => void) | null = null;
	let containerToStop: string | null = null;
	let portToRelease: number | null = null;

	if (settings.subdomain !== undefined && settings.subdomain !== deploy.publish.subdomain) {
		// Reject if subdomain is already claimed by another project
		if (await isSubdomainClaimedByOther(settings.subdomain, vibezzzDir)) {
			throw new SubdomainConflictError(settings.subdomain);
		}

		const oldSubdomain = deploy.publish.subdomain;
		const oldRouteId = deploy.publish.caddy_route_id;
		const oldContainerName = deploy.publish.container_name;
		const previousState = deploy.publish.state;

		// Defer container stop until after persist so a failed write
		// doesn't leave a dead container with no rollback path.
		if (deploy.publish.state !== 'down') {
			if (deploy.publish.container_id) {
				containerToStop = oldContainerName;
				portToRelease = deploy.publish.host_port;
				deploy.publish.container_id = null;
				deploy.publish.host_port = null;
			}

			if (previousState === 'up') {
				deploy.publish.state = 'down';
				deploy.publish.url = null;
			}

			// Defer route/registry cleanup until after persist
			oldRouteToRemove = oldRouteId;
			oldSubdomainToDelete = oldSubdomain;
		}

		deploy.publish.subdomain = settings.subdomain;
		deploy.publish.container_name = `vibebox-${settings.subdomain}`;
		deploy.publish.caddy_route_id = `vibebox-${settings.subdomain}`;

		// Prepare lazy re-registration (deferred until after persist)
		if (previousState === 'lazy' && deploy.publish.image) {
			const config = getConfig();
			const host = `${settings.subdomain}.${config.domain}`;
			deploy.publish.url = `https://${host}`;

			lazyReRegistration = () => {
				registerLazy(settings.subdomain!, {
					vibezzzDir,
					projectPath: projectName,
					containerName: deploy.publish!.container_name,
					containerPort: deploy.publish!.container_port,
					hostPort: null,
					image: deploy.publish!.image!,
					idleTimeout: deploy.publish!.idle_timeout || config.lazyIdleTimeout,
					lastRequestAt: Date.now(),
					starting: false,
					startPromise: null,
					disabled: false
				});
			};
		}
	}
	if (settings.container_port !== undefined) deploy.publish.container_port = settings.container_port;
	if (settings.idle_timeout !== undefined) deploy.publish.idle_timeout = settings.idle_timeout;

	// If image or port changed on a running lazy container, stop it so the
	// next request triggers a fresh wake with the updated configuration.
	const existingLazyEntry = lazyRegistry.get(deploy.publish.subdomain);
	let imageChanged = false;
	let portChanged = false;
	if (existingLazyEntry) {
		imageChanged = settings.image !== undefined && settings.image !== existingLazyEntry.image;
		portChanged = settings.container_port !== undefined && settings.container_port !== existingLazyEntry.containerPort;

		if (imageChanged || portChanged) {
			// Disable the entry BEFORE persist so in-flight wakeAndProxy()
			// calls abort instead of waking with stale image/port settings.
			// Container stop is deferred until after persist succeeds so a
			// failed write doesn't leave a dead container with no rollback.
			existingLazyEntry.disabled = true;
			deploy.publish.container_id = null;
			deploy.publish.host_port = null;
		}
	}

	// Persist before applying any live routing / registry changes.
	// If image/port changed, the lazy entry is still disabled here; on
	// failure we re-enable it with old (disk-consistent) values.
	try {
		await writeDeployConfig(vibezzzDir, deploy);
	} catch (persistErr) {
		if (existingLazyEntry && (imageChanged || portChanged)) {
			existingLazyEntry.disabled = false;
		}
		throw persistErr;
	}

	// -- Live side-effects (only reached after successful persist) --

	// Execute deferred container stop for subdomain change
	if (containerToStop) {
		await stopContainer(containerToStop);
		releaseHostPort(portToRelease);
	}

	// Execute deferred container stop for image/port change on lazy entry
	if (existingLazyEntry && (imageChanged || portChanged)) {
		const running = await containerIsRunning(existingLazyEntry.containerName);
		if (running) {
			await stopContainer(existingLazyEntry.containerName);
			releaseHostPort(existingLazyEntry.hostPort);
			existingLazyEntry.hostPort = null;

			// Restore Caddy route to vibebox's wake endpoint so the
			// hostname doesn't point at a dead upstream until the next
			// lazy wake re-switches it.
			const config = getConfig();
			const host = `${deploy.publish.subdomain}.${config.domain}`;
			const routeOk = await upsertRoute(deploy.publish.caddy_route_id, host, config.port);
			if (!routeOk) {
				console.error(`[publish] Failed to restore wake route for ${host} after stopping lazy container — will recover on next reconcile`);
			}
		}
	}

	// Disable old lazy entry before removal so in-flight wakeAndProxy()
	// calls on the old subdomain abort instead of persisting stale metadata.
	// Save the entry for potential rollback if new route registration fails.
	let savedOldLazyEntry: LazyEntry | undefined;
	if (oldSubdomainToDelete) {
		const oldEntry = lazyRegistry.get(oldSubdomainToDelete);
		if (oldEntry) {
			savedOldLazyEntry = { ...oldEntry, starting: false, startPromise: null };
			oldEntry.disabled = true;
		}
	}

	if (oldRouteToRemove) await removeRoute(oldRouteToRemove);
	if (oldSubdomainToDelete) lazyRegistry.delete(oldSubdomainToDelete);
	if (lazyReRegistration) {
		const config = getConfig();
		const host = `${settings.subdomain}.${config.domain}`;
		const routeOk = await upsertRoute(deploy.publish.caddy_route_id, host, config.port);
		if (!routeOk) {
			// Route registration failed — restore previous persisted state
			// so in-memory and on-disk stay consistent.
			console.error(`[publish] Caddy route upsert failed for ${host}, rolling back subdomain change`);
			deploy.publish.subdomain = oldSubdomainToDelete!;
			deploy.publish.container_name = `vibebox-${oldSubdomainToDelete}`;
			deploy.publish.caddy_route_id = `vibebox-${oldSubdomainToDelete}`;
			deploy.publish.url = deploy.publish.state === 'lazy' ? `https://${oldSubdomainToDelete}.${config.domain}` : deploy.publish.url;
			await writeDeployConfig(vibezzzDir, deploy);

			// Restore old Caddy route — mandatory for the old subdomain to remain reachable
			const oldHost = `${oldSubdomainToDelete}.${config.domain}`;
			const oldRouteOk = await upsertRoute(deploy.publish.caddy_route_id, oldHost, config.port);
			if (!oldRouteOk) {
				console.error(`[publish] CRITICAL: Failed to restore old wake route for ${oldHost} during rollback — hostname unreachable until next reconcile`);
			}

			// Restore old lazy registry entry so the project remains reachable
			if (savedOldLazyEntry) {
				savedOldLazyEntry.disabled = false;
				registerLazy(oldSubdomainToDelete!, savedOldLazyEntry);
			}

			throw new Error(`Failed to register Caddy route for new subdomain ${settings.subdomain}`);
		}
		lazyReRegistration();
	}

	// Sync ALL updated settings to the in-memory lazy registry now that
	// persistence has succeeded.  Image/port updates were deferred from
	// the pre-persist block so the entry never diverges from disk state.
	if (existingLazyEntry) {
		const config = getConfig();
		if (settings.container_port !== undefined) existingLazyEntry.containerPort = deploy.publish.container_port;
		if (settings.idle_timeout !== undefined)
			existingLazyEntry.idleTimeout = deploy.publish.idle_timeout || config.lazyIdleTimeout;
		if (settings.image !== undefined) existingLazyEntry.image = settings.image;
		// Re-enable after syncing (was disabled during image/port change teardown)
		if (existingLazyEntry.disabled) existingLazyEntry.disabled = false;
	}

	return deploy;
	}));
}

/**
 */
export async function applyPublishState(
	vibezzzDir: string,
	projectPath: string,
	projectName: string,
	targetState: PublishState
): Promise<DeployConfig> {
	return withSubdomainClaimLock(() => withDeployLock(vibezzzDir, async () => {
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
		if (await isSubdomainClaimedByOther(pub.subdomain, vibezzzDir)) {
			throw new SubdomainConflictError(pub.subdomain);
		}

		// Disable the lazy entry before removing it so any in-flight
		// wakeAndProxy() call aborts instead of continuing to start/persist
		// a container that the new 'up' transition will replace.
		const savedLazyEntry = lazyRegistry.get(pub.subdomain) ?? null;
		if (savedLazyEntry) savedLazyEntry.disabled = true;
		lazyRegistry.delete(pub.subdomain);

		// Release any previously allocated host port before allocating a new one
		releaseHostPort(pub.host_port);

		const hostPort = await allocateHostPort();
		const containerId = await startContainer(pub.container_name, pub.image, pub.container_port, hostPort);
		if (!containerId) {
			releaseHostPort(hostPort);
			if (savedLazyEntry) {
				savedLazyEntry.disabled = false;
				registerLazy(pub.subdomain, savedLazyEntry);
			}
			throw new Error('Failed to start container');
		}

		const host = `${pub.subdomain}.${config.domain}`;
		pub.state = 'up';
		pub.container_id = containerId;
		pub.host_port = hostPort;
		pub.url = `https://${host}`;

		// Persist before applying live side-effects so a failed write
		// doesn't leave Caddy routes / meta.yaml out of sync with YAML.
		try {
			await writeDeployConfig(vibezzzDir, deploy);
		} catch (err) {
			await stopContainer(pub.container_name);
			releaseHostPort(hostPort);
			if (savedLazyEntry) {
				savedLazyEntry.disabled = false;
				registerLazy(pub.subdomain, savedLazyEntry);
			}
			throw err;
		}

		// Live side-effects: only reached after successful persist
		const routeOk = await upsertRoute(pub.caddy_route_id, host, hostPort);
		if (!routeOk) {
			// Caddy route failed — revert persisted state and clean up
			await stopContainer(pub.container_name);
			releaseHostPort(hostPort);
			pub.state = 'down';
			pub.container_id = null;
			pub.host_port = null;
			pub.url = null;
			if (savedLazyEntry) {
				savedLazyEntry.disabled = false;
				registerLazy(pub.subdomain, savedLazyEntry);
			}
			await writeDeployConfig(vibezzzDir, deploy);
			throw new Error(`Failed to register Caddy route for ${host}`);
		}

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
		if (await isSubdomainClaimedByOther(pub.subdomain, vibezzzDir)) {
			throw new SubdomainConflictError(pub.subdomain);
		}

		// Stop container if running (lazy starts on demand)
		if (pub.container_id) {
			await stopContainer(pub.container_name);
		}

		// Release any previously allocated host port — lazy allocates on wake
		releaseHostPort(pub.host_port);

		const host = `${pub.subdomain}.${config.domain}`;
		pub.state = 'lazy';
		pub.container_id = null;
		pub.host_port = null;
		pub.url = `https://${host}`;

		// Persist before live side-effects
		await writeDeployConfig(vibezzzDir, deploy);

		// Live side-effects: Caddy wake route + lazy registry + meta
		const routeOk = await upsertRoute(pub.caddy_route_id, host, config.port);
		if (!routeOk) {
			// Caddy route failed — revert persisted state
			pub.state = 'down';
			pub.url = null;
			await writeDeployConfig(vibezzzDir, deploy);
			throw new Error(`Failed to register Caddy wake route for ${host}`);
		}

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
			startPromise: null,
			disabled: false
		});

		const metaPath = join(vibezzzDir, 'meta.yaml');
		const meta = await readYaml<Record<string, unknown> | null>(metaPath, null);
		if (meta) {
			meta.project_stage = 'published';
			await writeYaml(metaPath, meta);
		}

		await notify('publish_succeeded', projectPath, `Published ${projectPath} (lazy)`, pub.url);

	} else if (targetState === 'down') {
		// Disable lazy entry before transition to prevent in-flight wakes
		// from reviving runtime metadata after state becomes 'down'.
		const lazyEntry = lazyRegistry.get(pub.subdomain);
		if (lazyEntry) lazyEntry.disabled = true;

		// Stop container
		if (pub.container_id || await containerIsRunning(pub.container_name)) {
			await stopContainer(pub.container_name);
		}

		releaseHostPort(pub.host_port);

		pub.state = 'down';
		pub.container_id = null;
		pub.host_port = null;
		pub.url = null;

		// Persist before live side-effects
		await writeDeployConfig(vibezzzDir, deploy);

		// Live side-effects: Caddy route removal + lazy registry cleanup + meta
		const routeOk = await removeRoute(pub.caddy_route_id);
		if (!routeOk) {
			console.warn(`[publish] Caddy route removal failed for ${pub.caddy_route_id}, route may be stale`);
		}
		lazyRegistry.delete(pub.subdomain);

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

	return deploy;
	}));
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
			startPromise: null,
			disabled: false
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
	if (!entry || entry.disabled) return null;

	// Update last-request timestamp
	entry.lastRequestAt = Date.now();

	// Persist last_request_at to deploy.yaml (best-effort, non-blocking)
	persistLastRequest(entry).catch(() => {});

	// Check if container is already running
	const running = await containerIsRunning(entry.containerName);
	if (running && entry.hostPort) {
		// Ensure Caddy routes directly to the live container (may have been
		// missed if a previous route update failed or if the request arrived
		// during a brief race window).  If the route switch fails, return
		// null so hooks.server.ts responds 503 instead of redirect-looping.
		const host = `${subdomain}.${config.domain}`;
		const routeOk = await upsertRoute(`vibebox-${subdomain}`, host, entry.hostPort);
		return routeOk ? entry.hostPort : null;
	}

	// Serialize concurrent start attempts
	if (entry.startPromise) {
		return await entry.startPromise;
	}

	entry.starting = true;
	// Capture the image/port at wake start so we can detect if a settings
	// change races with this wake.  We use these for startContainer AND
	// verify them before persisting.
	const wakeImage = entry.image;
	const wakePort = entry.containerPort;
	entry.startPromise = (async () => {
		try {
			// Allocate a fresh host port for this container
			releaseHostPort(entry.hostPort);
			const hostPort = await allocateHostPort();
			entry.hostPort = hostPort;

			const containerId = await startContainer(
				entry.containerName,
				wakeImage,
				wakePort,
				hostPort
			);
			if (!containerId) {
				releaseHostPort(hostPort);
				entry.hostPort = null;
				return null;
			}

			// Wait for the container to be healthy
			const healthy = await waitForContainerHealthy(hostPort);
			if (!healthy) {
				console.warn(`[publish] Lazy container ${entry.containerName} started but not healthy`);
				await stopContainer(entry.containerName);
				releaseHostPort(hostPort);
				entry.hostPort = null;
				return null;
			}

			// Check if entry was disabled during wake (e.g. unpublish started)
			if (entry.disabled) {
				await stopContainer(entry.containerName);
				releaseHostPort(hostPort);
				entry.hostPort = null;
				return null;
			}

			// Check if image/port settings changed during wake — the
			// container was started with stale values and must not persist.
			if (entry.image !== wakeImage || entry.containerPort !== wakePort) {
				console.warn(`[publish] Lazy wake aborted: settings changed during wake for ${entry.containerName}`);
				await stopContainer(entry.containerName);
				releaseHostPort(hostPort);
				entry.hostPort = null;
				return null;
			}

			// Persist container_id and host_port atomically via the deploy lock.
			// Revalidates state, identity, AND settings to prevent persisting
			// stale metadata after a concurrent settings change, subdomain
			// rename, or unpublish.
			try {
				await withDeployLock(entry.vibezzzDir, async () => {
					const deploy = await readDeployConfig(entry.vibezzzDir);
					if (
						deploy?.publish &&
						deploy.publish.state === 'lazy' &&
						deploy.publish.subdomain === subdomain &&
						deploy.publish.container_name === entry.containerName &&
						deploy.publish.image === wakeImage &&
						deploy.publish.container_port === wakePort
					) {
						deploy.publish.container_id = containerId;
						deploy.publish.host_port = hostPort;
						deploy.publish.last_request_at = new Date().toISOString();
						await writeDeployConfig(entry.vibezzzDir, deploy);

						// Switch Caddy route to point directly to the live
						// container so subsequent traffic bypasses vibebox
						// (supports WebSockets, SSE, and long-lived requests).
						const host = `${subdomain}.${config.domain}`;
						const routeOk = await upsertRoute(deploy.publish.caddy_route_id, host, hostPort);
						if (!routeOk) {
							throw new Error(`Failed to switch Caddy route to live container for ${host}`);
						}
					} else {
						// State, identity, or settings changed during wake — abort
						throw new Error('Publish state, identity, or settings changed during lazy wake');
					}
				});
			} catch (persistErr) {
				console.error(`[publish] Lazy wake persistence failed for ${entry.containerName}, rolling back: ${(persistErr as Error).message}`);
				await stopContainer(entry.containerName);
				releaseHostPort(hostPort);
				entry.hostPort = null;

				// Restore Caddy route to vibebox's wake endpoint so the
				// hostname remains reachable for subsequent wake attempts.
				const host = `${subdomain}.${config.domain}`;
				const routeOk = await upsertRoute(`vibebox-${subdomain}`, host, config.port);
				if (!routeOk) {
					console.error(`[publish] CRITICAL: Failed to restore wake route for ${host} after wake rollback — hostname unreachable until next reconcile`);
				}
				return null;
			}

			console.log(`[publish] Lazy wake: started ${entry.containerName} for ${subdomain}`);
			return hostPort;
		} catch (err) {
			console.error(`[publish] Lazy wake failed for ${entry.containerName}: ${(err as Error).message}`);
			return null;
		} finally {
			entry.starting = false;
			entry.startPromise = null;
		}
	})();

	return await entry.startPromise;
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

		// Skip entries that are currently waking
		if (entry.starting || entry.startPromise) continue;

		// Check if container is actually running before stopping
		const running = await containerIsRunning(entry.containerName);
		if (!running) continue;

		console.log(
			`[publish] Idle shutdown: ${entry.containerName} idle for ${Math.round(idleMs / 1000)}s (timeout: ${entry.idleTimeout}s)`
		);

		// Perform all cleanup under the deploy lock so a concurrent lazy
		// wake that just restarted the container is not clobbered.
		await withDeployLock(entry.vibezzzDir, async () => {
			// Revalidate idle state — a request may have arrived while
			// we were waiting for the lock.
			const freshIdleMs = Date.now() - entry.lastRequestAt;
			if (freshIdleMs < timeoutMs) return;

			// Abort if a wake started while we waited for the lock
			if (entry.starting || entry.startPromise) return;

			// Revalidate identity against persisted state
			const deploy = await readDeployConfig(entry.vibezzzDir);
			if (
				!deploy?.publish ||
				deploy.publish.state !== 'lazy' ||
				deploy.publish.subdomain !== subdomain ||
				deploy.publish.container_name !== entry.containerName
			) {
				return;
			}

			// All checks passed — stop the container and clear metadata
			await stopContainer(entry.containerName);
			releaseHostPort(entry.hostPort);
			entry.hostPort = null;

			// Revert Caddy route back to vibebox's port for wake-on-demand.
			// This is mandatory — without it the hostname has no upstream.
			const config = getConfig();
			const host = `${subdomain}.${config.domain}`;
			const routeOk = await upsertRoute(deploy.publish.caddy_route_id, host, config.port);
			if (!routeOk) {
				console.error(`[publish] CRITICAL: Failed to restore wake route for ${host} after idle shutdown — hostname unreachable until next reconcile`);
			}

			deploy.publish.container_id = null;
			deploy.publish.host_port = null;
			await writeDeployConfig(entry.vibezzzDir, deploy);
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
