import type { PageServerLoad } from './$types';
import { join } from 'node:path';
import { readYaml } from '$lib/server/yaml';
import { getConfig } from '$lib/server/config';
import { error } from '@sveltejs/kit';
import type { ProjectMeta } from '$lib/server/projects';

export const load: PageServerLoad = async ({ params }) => {
	const projectPath = params.path;
	const { projectsDir } = getConfig();
	const absPath = join(projectsDir, projectPath);
	const metaPath = join(absPath, '.vibezzz', 'meta.yaml');

	const meta = await readYaml<ProjectMeta | null>(metaPath, null);
	if (!meta) {
		throw error(404, `Project not found: ${projectPath}`);
	}

	return { path: projectPath, meta };
};
