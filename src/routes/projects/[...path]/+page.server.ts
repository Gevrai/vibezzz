import type { PageServerLoad } from './$types';
import { join, resolve } from 'node:path';
import { readYaml } from '$lib/server/yaml';
import { getConfig } from '$lib/server/config';
import { error } from '@sveltejs/kit';
import { verifyVibezzzDir } from '$lib/server/projects';
import type { ProjectMeta, ProjectSignals, DeployPreview, DeployPublish, AgentEntry } from '$lib/server/projects';
import { realpath } from 'node:fs/promises';
import { getActiveRun, getRunHistory, type AgentRunEntry } from '$lib/server/agents';
import { readDeployConfig, getActivePreview, checkPreviewHealth, type DeployConfig } from '$lib/server/preview';
import { listProviders, type ProviderName } from '$lib/server/providers';

export const load: PageServerLoad = async ({ params }) => {
	const projectPath = params.path;
	const { projectsDir, defaultProvider } = getConfig();
	const absPath = join(projectsDir, projectPath);

	// Prevent path traversal outside the projects directory (symlink-safe)
	let resolvedPath: string;
	try {
		resolvedPath = await realpath(absPath);
	} catch {
		throw error(404, `Project not found: ${projectPath}`);
	}
	let resolvedRoot: string;
	try {
		resolvedRoot = await realpath(projectsDir);
	} catch {
		resolvedRoot = resolve(projectsDir);
	}
	if (!resolvedPath.startsWith(resolvedRoot + '/')) {
		throw error(400, 'Invalid project path');
	}

	const vibezzzDir = await verifyVibezzzDir(resolvedPath);

	let meta: ProjectMeta | null = null;
	if (vibezzzDir) {
		meta = await readYaml<ProjectMeta | null>(join(vibezzzDir, 'meta.yaml'), null);
	}

	if (!meta) {
		const segments = projectPath.split('/');
		if (segments.length < 2) {
			throw error(404, `Project not found: ${projectPath}`);
		}
		meta = {
			name: segments[segments.length - 1],
			category: segments[0],
			origin: 'external',
			created_at: new Date().toISOString(),
			idea_id: null,
			template: null,
			project_stage: 'paused',
			last_ready_at: null
		};
	}

	// Signals
	const signals: ProjectSignals = {
		preview_status: null,
		preview_url: null,
		publish_state: null,
		publish_url: null,
		agent_active: false,
		last_agent_status: null
	};

	// Deploy config
	let deploy: DeployConfig | null = null;
	if (vibezzzDir) {
		deploy = await readDeployConfig(vibezzzDir);
	}
	if (deploy) {
		if (deploy.preview) {
			signals.preview_status = deploy.preview.status ?? null;
			signals.preview_url = deploy.preview.url ?? null;
		}
		if (deploy.publish) {
			signals.publish_state = deploy.publish.state ?? null;
			signals.publish_url = deploy.publish.url ?? null;
		}
	}

	// Agent runs
	let runs: AgentRunEntry[] = [];
	if (vibezzzDir) {
		runs = await getRunHistory(vibezzzDir);
	}
	const activeRun = getActiveRun(projectPath);
	if (runs.length > 0) {
		const last = runs[runs.length - 1];
		signals.last_agent_status = last.status ?? null;
		signals.agent_active = last.status === 'running';
	}

	// Project-scoped ideas
	interface ProjectIdea {
		id: number;
		content: string;
		created_at: string;
		status: string;
		implemented_at: string | null;
		git_tag: string | null;
	}
	let ideas: ProjectIdea[] = [];
	if (vibezzzDir) {
		ideas = await readYaml<ProjectIdea[]>(join(vibezzzDir, 'ideas.yaml'), []);
	}

	// Preview healthcheck
	let previewHealthy = false;
	if (deploy?.preview?.status === 'ready' && deploy.preview.port) {
		previewHealthy = await checkPreviewHealth(
			deploy.preview.port,
			deploy.preview.healthcheck_path || '/'
		);
	}

	const providers = listProviders();

	return {
		path: projectPath,
		meta,
		signals,
		runs: runs.reverse(),
		activeRun: activeRun
			? {
					id: activeRun.entry.id,
					provider: activeRun.entry.provider,
					summary: activeRun.entry.summary,
					started_at: activeRun.entry.started_at,
					status: activeRun.entry.status
				}
			: null,
		ideas: ideas.reverse(),
		deploy,
		previewHealthy,
		providers,
		defaultProvider
	};
};
