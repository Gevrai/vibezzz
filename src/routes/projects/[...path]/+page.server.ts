import type { PageServerLoad } from './$types';
import { join, resolve } from 'node:path';
import { readYaml } from '$lib/server/yaml';
import { getConfig } from '$lib/server/config';
import { error } from '@sveltejs/kit';
import type { ProjectMeta, ProjectSignals, DeployPreview, DeployPublish, AgentEntry } from '$lib/server/projects';
import { realpath } from 'node:fs/promises';

export const load: PageServerLoad = async ({ params }) => {
	const projectPath = params.path;
	const { projectsDir } = getConfig();
	const absPath = join(projectsDir, projectPath);

	// Prevent path traversal outside the projects directory (symlink-safe)
	let resolvedPath: string;
	try {
		resolvedPath = await realpath(absPath);
	} catch {
		// If the path doesn't exist at all, it's a 404 anyway
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

	const vibezzzDir = join(absPath, '.vibezzz');
	const metaPath = join(vibezzzDir, 'meta.yaml');

	let meta = await readYaml<ProjectMeta | null>(metaPath, null);

	// External repo without .vibezzz/meta.yaml — synthesize metadata
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

	// Read signals
	const signals: ProjectSignals = {
		preview_status: null,
		preview_url: null,
		publish_state: null,
		publish_url: null,
		agent_active: false,
		last_agent_status: null
	};

	const deploy = await readYaml<{ preview?: DeployPreview; publish?: DeployPublish } | null>(
		join(vibezzzDir, 'deploy.yaml'),
		null
	);
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

	const agents = await readYaml<AgentEntry[]>(join(vibezzzDir, 'agents.yaml'), []);
	if (agents.length > 0) {
		const last = agents[agents.length - 1];
		signals.last_agent_status = last.status ?? null;
		signals.agent_active = last.status === 'running';
	}

	return { path: projectPath, meta, signals };
};
