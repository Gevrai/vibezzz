/**
 * Run an agent from a project-scoped idea.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { getConfig } from '$lib/server/config';
import { verifyVibezzzDir } from '$lib/server/projects';
import { readYaml } from '$lib/server/yaml';
import { startRun } from '$lib/server/agents';
import type { ProviderName, RunKind } from '$lib/server/providers';

interface ProjectIdea {
	id: number;
	content: string;
	status: string;
}

export const POST: RequestHandler = async ({ params, request }) => {
	const projectPath = params.path.replace(/\/ideas\/\d+\/run$/, '');
	const ideaId = parseInt(params.id, 10);
	if (isNaN(ideaId) || ideaId < 1) throw error(400, 'Invalid idea ID');

	const { projectsDir } = getConfig();
	const absPath = join(projectsDir, projectPath);
	let resolvedPath: string;
	try {
		resolvedPath = await realpath(absPath);
	} catch {
		throw error(404, 'Project not found');
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
	if (!vibezzzDir) throw error(404, '.vibezzz not found');

	const ideas = await readYaml<ProjectIdea[]>(join(vibezzzDir, 'ideas.yaml'), []);
	const idea = ideas.find((i) => i.id === ideaId);
	if (!idea) throw error(404, 'Idea not found');

	const body = await request.json().catch(() => ({}));

	const entry = await startRun({
		projectPath: params.path.replace(/\/ideas\/\d+\/run$/, ''),
		projectAbsPath: resolvedPath,
		vibezzzDir,
		provider: (body.provider as ProviderName) || undefined,
		kind: (body.kind as RunKind) || 'implement',
		prompt: idea.content,
		ideaId: idea.id
	});

	return json(entry, { status: 201 });
};
