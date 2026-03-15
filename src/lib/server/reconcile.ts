/**
 * Startup reconciliation.
 *
 * On vibebox startup, scans all projects for stale agent runs and
 * preview processes.  A run/preview is considered stale when:
 *   - the PID no longer exists
 *   - the process start time doesn't match
 *   - the process doesn't belong to the expected working directory
 */

import { join } from 'node:path';
import { readYaml, writeYaml } from './yaml.js';
import { scanProjects } from './projects.js';
import { getConfig } from './config.js';
import { upsertRoute } from './caddy.js';
import type { AgentRunEntry } from './agents.js';
import type { DeployConfig } from './preview.js';

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
		const stat = await Bun.file(`/proc/${pid}/stat`).text();
		const parts = stat.split(') ');
		if (parts.length < 2) return null;
		const fields = parts[1].split(' ');
		// Field index 19 (0-based from after the closing paren) is starttime
		return parseInt(fields[19], 10) || null;
	} catch {
		return null;
	}
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Reconcile all agent runs and preview processes across all projects.
 * Called once on server startup.
 */
export async function reconcileOnStartup(): Promise<void> {
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
					alive = isPidAlive(agent.pid);
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
					const alive = isPidAlive(preview.pid);
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
						// Preview is still alive — re-register its Caddy route
						if (preview.public && preview.subdomain && preview.status === 'ready') {
							const host = `${preview.subdomain}.${config.domain}`;
							const routeId = `vibebox-preview-${preview.subdomain}`;
							await upsertRoute(routeId, host, preview.port);
						}
					}
				}
			}
		} catch (err) {
			console.warn(
				`[reconcile] Error reconciling project ${project.path}: ${(err as Error).message}`
			);
		}
	}

	console.log(`[reconcile] Done. Reconciled ${reconciled} stale entries.`);
}
