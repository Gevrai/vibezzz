/**
 * Startup reconciliation.
 *
 * On vibebox startup, scans all projects for stale agent runs,
 * preview processes, and publish state.  A run/preview is considered stale when:
 *   - the PID no longer exists
 *   - the process start time doesn't match
 *   - the process doesn't belong to the expected working directory
 *
 * Publish reconciliation:
 *   - Verifies containers for `state: up` projects are still running
 *   - Re-registers Caddy routes for published/lazy projects
 *   - Populates the lazy wake registry for `state: lazy` projects
 *
 * Also rehydrates live previews into the in-memory map so the monitor
 * and live UI surfaces work immediately after restart.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readYaml, writeYaml } from './yaml.js';
import { scanProjects } from './projects.js';
import { getConfig } from './config.js';
import { upsertRoute } from './caddy.js';
import { checkPreviewHealth, rehydratePreview } from './preview.js';
import type { AgentRunEntry } from './agents.js';
import { rehydrateRun } from './agents.js';
import type { DeployConfig } from './preview.js';
import { reconcilePublish } from './publish.js';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Check if a PID is alive and optionally verify its start time.
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the process start time from /proc on Linux.
 * Returns the start time in clock ticks, or null if unavailable.
 */
async function getProcessStartTime(pid: number): Promise<number | null> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, 'utf-8');
		const parts = stat.split(') ');
		if (parts.length < 2) return null;
		const fields = parts[1].split(' ');
		// Field index 19 (0-based from after the closing paren) is starttime
		return parseInt(fields[19], 10) || null;
	} catch {
		return null;
	}
}

/**
 * Read the working directory of a process from /proc on Linux.
 * Returns the cwd path, or null if unavailable.
 */
async function getProcessCwd(pid: number): Promise<string | null> {
	try {
		const cwd = await readFile(`/proc/${pid}/cwd`, 'utf-8').catch(async () => {
			// /proc/PID/cwd is a symlink — read it via readlink
			const { readlink } = await import('node:fs/promises');
			return readlink(`/proc/${pid}/cwd`);
		});
		return cwd || null;
	} catch {
		return null;
	}
}

/**
 * Validate that a running process actually belongs to the expected run.
 * Checks start time proximity and working directory.
 */
async function isProcessValid(
	pid: number,
	expectedStartedAt: string | null,
	expectedCwd: string | null
): Promise<boolean> {
	if (!isPidAlive(pid)) return false;

	// Verify working directory if we have an expected cwd
	if (expectedCwd) {
		const actualCwd = await getProcessCwd(pid);
		if (actualCwd && actualCwd !== expectedCwd) {
			return false;
		}
	}

	// Verify start time proximity if we have an expected start time
	if (expectedStartedAt) {
		const startTicks = await getProcessStartTime(pid);
		if (startTicks !== null) {
			// We can't perfectly correlate ISO timestamps with clock ticks,
			// but we can detect obvious PID reuse: if the process start time
			// is vastly different from when we recorded it, the PID was reused.
			// Use a boot-time-based approach to convert ticks to epoch seconds.
			try {
				const uptime = await readFile('/proc/uptime', 'utf-8');
				const uptimeSec = parseFloat(uptime.split(' ')[0]);
				const bootEpoch = Date.now() / 1000 - uptimeSec;
				const clkTck = 100; // standard Linux value
				const procStartEpoch = bootEpoch + startTicks / clkTck;
				const expectedEpoch = new Date(expectedStartedAt).getTime() / 1000;
				// Allow 30 seconds of skew between our recorded time and the
				// kernel-reported process start time
				if (Math.abs(procStartEpoch - expectedEpoch) > 30) {
					return false;
				}
			} catch {
				// Can't verify — assume valid if PID is alive
			}
		}
	}

	return true;
}

// ── Public API ───────────────────────────────────────────────────────

// ── Reconciliation gate ─────────────────────────────────────────────
//
// Mutating APIs (run, preview, publish) must await reconciliationReady()
// before checking in-memory state.  This prevents duplicate starts during
// the async reconciliation window after a server restart.

let _reconcileResolve: () => void;
let _reconcilePromise: Promise<void> = new Promise((r) => { _reconcileResolve = r; });

/**
 * Wait until startup reconciliation has completed.
 * Mutating API handlers should call this before proceeding.
 */
export function reconciliationReady(): Promise<void> {
	return _reconcilePromise;
}

/**
 * Reconcile all agent runs and preview processes across all projects.
 * Called once on server startup.  Always resolves the reconciliation gate
 * so mutating APIs are never permanently blocked.
 */
export async function reconcileOnStartup(): Promise<void> {
	try {
		await _doReconcile();
	} finally {
		_reconcileResolve();
	}
}

async function _doReconcile(): Promise<void> {
	console.log('[reconcile] Starting startup reconciliation…');

	const config = getConfig();

	let projects;
	try {
		projects = await scanProjects();
	} catch (err) {
		console.warn(`[reconcile] Failed to scan projects: ${(err as Error).message}`);
		return;
	}

	let reconciled = 0;

	for (const project of projects) {
		const absPath = join(config.projectsDir, project.path);
		const vibezzzDir = join(absPath, '.vibezzz');

		try {
			// Reconcile agent runs
			const agentsPath = join(vibezzzDir, 'agents.yaml');
			const agents = await readYaml<AgentRunEntry[]>(agentsPath, []);
			let agentsChanged = false;

			for (const agent of agents) {
				if (agent.status !== 'running') continue;

				let alive = false;
				if (agent.pid) {
					alive = await isProcessValid(
						agent.pid,
						agent.process_started_at,
						agent.cwd
					);
				}

				if (!alive) {
					agent.status = 'failed';
					agent.finished_at = new Date().toISOString();
					agent.result = 'failed';
					agentsChanged = true;
					reconciled++;
					console.log(
						`[reconcile] Marked stale agent run #${agent.id} as failed (project: ${project.path})`
					);
				} else {
					// Process is still alive — rehydrate into in-memory tracking
					rehydrateRun(project.path, agent, vibezzzDir);
					console.log(
						`[reconcile] Rehydrated active agent run #${agent.id} (project: ${project.path})`
					);
				}
			}

			if (agentsChanged) {
				await writeYaml(agentsPath, agents);
			}

			// Reconcile preview process
			const deployPath = join(vibezzzDir, 'deploy.yaml');
			const deploy = await readYaml<DeployConfig | null>(deployPath, null);

			if (deploy?.preview) {
				const preview = deploy.preview;
				if (
					preview.pid &&
					(preview.status === 'starting' || preview.status === 'ready')
				) {
					const alive = await isProcessValid(
						preview.pid,
						preview.process_started_at,
						null
					);
					if (!alive) {
						preview.status = 'stopped';
						preview.pid = null;
						preview.process_started_at = null;
						preview.url = null;
						await writeYaml(deployPath, deploy);
						reconciled++;
						console.log(
							`[reconcile] Cleared stale preview for project: ${project.path}`
						);
					} else {
						// Preview is still alive — verify via healthcheck
						const healthy = preview.status === 'ready'
							? await checkPreviewHealth(preview.port, preview.healthcheck_path)
							: true; // 'starting' previews might not be healthy yet

						if (healthy || preview.status === 'starting') {
							// Re-register Caddy route for public ready previews
							if (preview.public && preview.subdomain && preview.status === 'ready') {
								const host = `${preview.subdomain}.${config.domain}`;
								const routeId = `vibebox-preview-${preview.subdomain}`;
								await upsertRoute(routeId, host, preview.port);
							}

							// Rehydrate into in-memory map for live UI/monitoring
							rehydratePreview(project.path, preview);
							console.log(
								`[reconcile] Rehydrated active preview for project: ${project.path}`
							);
						} else {
							// Process alive but not healthy — mark failed
							preview.status = 'failed';
							await writeYaml(deployPath, deploy);
							reconciled++;
							console.log(
								`[reconcile] Preview process alive but unhealthy for project: ${project.path}`
							);
						}
					}
				}
			}

			// Reconcile publish state (containers + Caddy routes + lazy registry)
			try {
				await reconcilePublish(vibezzzDir, project.path);
			} catch (err) {
				console.warn(
					`[reconcile] Error reconciling publish for ${project.path}: ${(err as Error).message}`
				);
			}
		} catch (err) {
			console.warn(
				`[reconcile] Error reconciling project ${project.path}: ${(err as Error).message}`
			);
		}
	}

	console.log(`[reconcile] Done. Reconciled ${reconciled} stale entries.`);
}
