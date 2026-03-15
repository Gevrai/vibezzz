/**
 * Mark a project idea as implemented.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfig } from '$lib/server/config';
import { verifyVibezzzDir } from '$lib/server/projects';
import { readYaml, writeYaml } from '$lib/server/yaml';

const execFileAsync = promisify(execFile);

interface ProjectIdea {
	id: number;
	content: string;
	created_at: string;
	status: string;
	implemented_at: string | null;
	git_tag: string | null;
}

export const POST: RequestHandler = async ({ params }) => {
	const projectPath = params.path.replace(/\/ideas\/\d+\/implement$/, '');
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

	const ideasPath = join(vibezzzDir, 'ideas.yaml');
	const ideas = await readYaml<ProjectIdea[]>(ideasPath, []);
	const idea = ideas.find((i) => i.id === ideaId);
	if (!idea) throw error(404, 'Idea not found');
	if (idea.status === 'implemented') throw error(400, 'Already implemented');

	// Try to create a git tag
	const slug = idea.content
		.slice(0, 40)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '');
	const tagName = `idea/${ideaId}-${slug}`;

	let gitTag: string | null = null;
	try {
		await execFileAsync('git', ['tag', tagName], { cwd: resolvedPath });
		gitTag = tagName;
	} catch {
		// Repo may have no commits, or tag already exists
	}

	idea.status = 'implemented';
	idea.implemented_at = new Date().toISOString();
	idea.git_tag = gitTag;
	await writeYaml(ideasPath, ideas);

	return json(idea);
};
