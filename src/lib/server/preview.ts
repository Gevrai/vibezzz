/**
 * Preview process manager.
 *
 * Manages preview dev-server processes: start, stop, healthcheck,
 * Caddy route registration, and status persistence in deploy.yaml.
 */

import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readYaml, writeYaml } from './yaml.js';
import { getConfig } from './config.js';
import { upsertRoute, removeRoute } from './caddy.js';
import { notify } from './notifications.js';

// ── Types ────────────────────────────────────────────────────────────

export interface PreviewConfig {
	command: string;
	port: number;
	healthcheck_path: string;
	pid: number | null;
	process_started_at: string | null;
	status: 'stopped' | 'starting' | 'ready' | 'failed';
	subdomain: string;
	url: string | null;
	public: boolean;
	last_ready_at: string | null;
}

export interface DeployConfig {
	preview: PreviewConfig;
	publish?: {
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
	};
	automation?: {
		auto_start_agent?: boolean;
		auto_start_preview?: boolean;
		auto_notify_on_ready?: boolean;
		auto_publish?: boolean;
	};
}

export interface ActivePreview {
	projectPath: string;
	config: PreviewConfig;
	process: ChildProcess | null;
}

// ── In-memory tracking ───────────────────────────────────────────────

const activePreviews = new Map<string, ActivePreview>();

export function getActivePreview(projectPath: string): ActivePreview | undefined {
	return activePreviews.get(projectPath);
}

export function getAllActivePreviews(): ActivePreview[] {
	return [...activePreviews.values()];
}

/**
 * Rehydrate a preview into the in-memory active map after restart.
 * Used by reconciliation to restore live monitoring state for previews
 * whose process survived the restart.
 */
export function rehydratePreview(projectPath: string, config: PreviewConfig): void {
	// Only rehydrate if not already tracked (avoid overwriting a live process ref)
	if (activePreviews.has(projectPath)) return;

	activePreviews.set(projectPath, {
		projectPath,
		config: { ...config },
		process: null // we don't have a ChildProcess handle after restart
	});
}

// ── Deploy YAML helpers ──────────────────────────────────────────────

function deployPath(vibezzzDir: string): string {
	return join(vibezzzDir, 'deploy.yaml');
}

export async function readDeployConfig(vibezzzDir: string): Promise<DeployConfig | null> {
	return readYaml<DeployConfig | null>(deployPath(vibezzzDir), null);
}

export async function writeDeployConfig(
	vibezzzDir: string,
	config: DeployConfig
): Promise<void> {
	await writeYaml(deployPath(vibezzzDir), config);
}

/**
 * Update just the preview section of deploy.yaml.
 */
async function updatePreviewConfig(
	vibezzzDir: string,
	updates: Partial<PreviewConfig>
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
	deploy.preview = { ...deploy.preview, ...updates };
	await writeDeployConfig(vibezzzDir, deploy);
	return deploy;
}

// ── Healthcheck ──────────────────────────────────────────────────────

async function waitForHealthy(
	port: number,
	healthPath: string,
	timeoutMs: number = 30_000,
	intervalMs: number = 1_000
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const resp = await fetch(`http://localhost:${port}${healthPath}`, {
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

/**
 * One-shot healthcheck for a preview.
 */
export async function checkPreviewHealth(port: number, healthPath: string): Promise<boolean> {
	try {
		const resp = await fetch(`http://localhost:${port}${healthPath}`, {
			signal: AbortSignal.timeout(3_000)
		});
		return resp.ok;
	} catch {
		return false;
	}
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start (or restart) the preview process for a project.
 * Waits for the healthcheck to complete before returning.
 */
export async function startPreview(
	projectPath: string,
	projectAbsPath: string,
	vibezzzDir: string
): Promise<PreviewConfig> {
	// Stop existing preview if any
	await stopPreview(projectPath, vibezzzDir);

	const deploy = await readDeployConfig(vibezzzDir);
	if (!deploy?.preview?.command) {
		throw new Error('No preview command configured in deploy.yaml');
	}

	const preview = deploy.preview;
	const config = getConfig();

	// Mark as starting
	await updatePreviewConfig(vibezzzDir, {
		status: 'starting',
		pid: null,
		process_started_at: null,
		url: null
	});

	// Split command for subprocess
	const parts = preview.command.split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		throw new Error('Empty preview command');
	}

	let proc: ChildProcess;
	try {
		proc = spawn(parts[0], parts.slice(1), {
			cwd: projectAbsPath,
			stdio: ['ignore', 'ignore', 'ignore'],
			env: { ...process.env }
		});
	} catch (err) {
		await updatePreviewConfig(vibezzzDir, { status: 'failed' });
		throw new Error(`Failed to start preview process: ${(err as Error).message}`);
	}

	const startedAt = new Date().toISOString();

	// Track in memory
	const active: ActivePreview = {
		projectPath,
		config: { ...preview, pid: proc.pid ?? null, process_started_at: startedAt, status: 'starting' },
		process: proc
	};
	activePreviews.set(projectPath, active);

	// Update YAML with PID
	await updatePreviewConfig(vibezzzDir, {
		pid: proc.pid,
		process_started_at: startedAt,
		status: 'starting'
	});

	// Handle process exit
	proc.on('exit', async () => {
		const current = activePreviews.get(projectPath);
		if (current?.process === proc) {
			activePreviews.delete(projectPath);
			await updatePreviewConfig(vibezzzDir, {
				status: 'stopped',
				pid: null,
				process_started_at: null
			});
		}
	});

	// Wait for healthcheck to complete before returning
	const healthy = await waitForHealthy(
		preview.port,
		preview.healthcheck_path
	);

	if (healthy) {
		const previewUrl = preview.public
			? `https://${preview.subdomain}.${config.domain}`
			: null;

		await updatePreviewConfig(vibezzzDir, {
			status: 'ready',
			url: previewUrl,
			last_ready_at: new Date().toISOString()
		});

		active.config.status = 'ready';
		active.config.url = previewUrl;

		// Update meta.yaml stage
		const metaPath = join(vibezzzDir, 'meta.yaml');
		const meta = await readYaml<Record<string, unknown> | null>(metaPath, null);
		if (meta) {
			meta.project_stage = 'preview_ready';
			meta.last_ready_at = new Date().toISOString();
			await writeYaml(metaPath, meta);
		}

		// Register Caddy route for public previews
		if (preview.public && preview.subdomain) {
			const host = `${preview.subdomain}.${config.domain}`;
			const routeId = `vibebox-preview-${preview.subdomain}`;
			await upsertRoute(routeId, host, preview.port);
		}

		// Notify if configured
		const automation = deploy.automation;
		if (automation?.auto_notify_on_ready) {
			await notify(
				'preview_ready',
				projectPath,
				`Preview ready for ${projectPath}`,
				previewUrl ?? undefined
			);
		}

		return {
			...preview,
			pid: proc.pid ?? null,
			process_started_at: startedAt,
			status: 'ready',
			url: previewUrl,
			last_ready_at: new Date().toISOString()
		};
	} else {
		await updatePreviewConfig(vibezzzDir, { status: 'failed' });
		active.config.status = 'failed';

		return {
			...preview,
			pid: proc.pid ?? null,
			process_started_at: startedAt,
			status: 'failed'
		};
	}
}

/**
 * Stop the preview process for a project.
 */
export async function stopPreview(
	projectPath: string,
	vibezzzDir: string
): Promise<void> {
	const active = activePreviews.get(projectPath);
	if (active?.process) {
		try {
			active.process.kill('SIGTERM');
			const timer = setTimeout(() => {
				try {
					active.process?.kill('SIGKILL');
				} catch { /* already gone */ }
			}, 5_000);
			await new Promise<void>((resolve) => {
				active.process!.on('exit', () => resolve());
				setTimeout(resolve, 6_000);
			});
			clearTimeout(timer);
		} catch {
			/* already exited */
		}
	}
	activePreviews.delete(projectPath);

	// Remove Caddy route
	const deploy = await readDeployConfig(vibezzzDir);
	if (deploy?.preview?.subdomain) {
		const routeId = `vibebox-preview-${deploy.preview.subdomain}`;
		await removeRoute(routeId);
	}

	// Update YAML
	await updatePreviewConfig(vibezzzDir, {
		status: 'stopped',
		pid: null,
		process_started_at: null,
		url: null
	});
}

/**
 * Update deploy.yaml preview/publish settings.
 */
export async function updateDeploySettings(
	vibezzzDir: string,
	updates: {
		previewCommand?: string;
		previewPort?: number;
		previewSubdomain?: string;
		healthcheckPath?: string;
	}
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

	if (updates.previewCommand !== undefined) deploy.preview.command = updates.previewCommand;
	if (updates.previewPort !== undefined) deploy.preview.port = updates.previewPort;
	if (updates.previewSubdomain !== undefined) deploy.preview.subdomain = updates.previewSubdomain;
	if (updates.healthcheckPath !== undefined)
		deploy.preview.healthcheck_path = updates.healthcheckPath;

	await writeDeployConfig(vibezzzDir, deploy);
	return deploy;
}
