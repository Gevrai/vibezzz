/**
 * Move API: move a project to a different category.
 *
 * POST: { category: string }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { getConfig } from '$lib/server/config';
import { moveProject } from '$lib/server/projects';

export const POST: RequestHandler = async ({ params, request }) => {
	const projectPath = params.path;
	const { projectsDir } = getConfig();

	// Verify the project exists inside projectsDir
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

	const body = await request.json();
	const targetCategory = body.category;

	if (!targetCategory || typeof targetCategory !== 'string') {
		throw error(400, 'Missing or invalid "category" field');
	}

	try {
		const result = await moveProject(projectPath, targetCategory.trim());
		return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Move failed';
		throw error(400, message);
	}
};
