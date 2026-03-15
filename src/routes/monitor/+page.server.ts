import type { PageServerLoad } from './$types';
import { getAllActiveRuns, type AgentRunEntry } from '$lib/server/agents';
import { getAllActivePreviews } from '$lib/server/preview';
import { getRecentNotifications } from '$lib/server/notifications';
import { scanProjects } from '$lib/server/projects';
import { getConfig } from '$lib/server/config';
import { join } from 'node:path';
import { readYaml } from '$lib/server/yaml';
import { verifyVibezzzDir } from '$lib/server/projects';

export const load: PageServerLoad = async () => {
	const config = getConfig();

	// Active agent runs
	const activeRuns = getAllActiveRuns().map((r) => ({
		projectPath: r.projectPath,
		id: r.entry.id,
		provider: r.entry.provider,
		summary: r.entry.summary,
		started_at: r.entry.started_at,
		status: r.entry.status
	}));

	// Active previews
	const activePreviews = getAllActivePreviews().map((p) => ({
		projectPath: p.projectPath,
		status: p.config.status,
		url: p.config.url,
		port: p.config.port
	}));

	// Recent completed runs across all projects
	const projects = await scanProjects();
	const recentRuns: Array<AgentRunEntry & { projectPath: string }> = [];

	for (const project of projects) {
		const absPath = join(config.projectsDir, project.path);
		const vibezzzDir = await verifyVibezzzDir(absPath);
		if (!vibezzzDir) continue;

		const agents = await readYaml<AgentRunEntry[]>(join(vibezzzDir, 'agents.yaml'), []);
		for (const agent of agents) {
			if (agent.status !== 'running') {
				recentRuns.push({ ...agent, projectPath: project.path });
			}
		}
	}

	// Sort by started_at desc, take latest 20
	recentRuns.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
	const recentCompletedRuns = recentRuns.slice(0, 20);

	// Recent notifications
	const notifications = getRecentNotifications().slice(0, 20);

	return {
		activeRuns,
		activePreviews,
		recentRuns: recentCompletedRuns,
		notifications
	};
};
