/**
 * Project-scoped ideas API.
 * GET: list project ideas
 * POST: add a new project-scoped idea
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { getConfig } from '$lib/server/config';
import { verifyVibezzzDir } from '$lib/server/projects';
import { readYaml, writeYaml } from '$lib/server/yaml';

interface ProjectIdea {
	id: number;
	content: string;
	created_at: string;
	status: 'raw' | 'promoted' | 'implemented';
	project_path: string | null;
	implemented_at: string | null;
	git_tag: string | null;
}

async function resolveProject(path: string) {
	const { projectsDir } = getConfig();
	const absPath = join(projectsDir, path);
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
	if (!vibezzzDir) throw error(404, 'Project .vibezzz directory not found');
	return { resolvedPath, vibezzzDir };
}

export const GET: RequestHandler = async ({ params }) => {
	const { vibezzzDir } = await resolveProject(params.path);
	const ideas = await readYaml<ProjectIdea[]>(join(vibezzzDir, 'ideas.yaml'), []);
	return json(ideas);
};

export const POST: RequestHandler = async ({ params, request }) => {
	const { vibezzzDir } = await resolveProject(params.path);
	const body = await request.json();

	if (!body.content || typeof body.content !== 'string' || !body.content.trim()) {
		throw error(400, 'content is required');
	}

	const ideas = await readYaml<ProjectIdea[]>(join(vibezzzDir, 'ideas.yaml'), []);
	const nextId = ideas.length > 0 ? Math.max(...ideas.map((i) => i.id)) + 1 : 1;

	const idea: ProjectIdea = {
		id: nextId,
		content: body.content.trim(),
		created_at: new Date().toISOString(),
		status: 'raw',
		project_path: params.path,
		implemented_at: null,
		git_tag: null
	};

	ideas.push(idea);
	await writeYaml(join(vibezzzDir, 'ideas.yaml'), ideas);
	return json(idea, { status: 201 });
};
