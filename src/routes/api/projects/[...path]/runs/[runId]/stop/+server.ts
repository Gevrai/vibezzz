/**
 * Stop an active agent run.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { getConfig } from '$lib/server/config';
import { verifyVibezzzDir } from '$lib/server/projects';
import { stopRun } from '$lib/server/agents';

export const POST: RequestHandler = async ({ params }) => {
	// The path param includes the full path including /runs/[runId]/stop
	// We need to extract just the project path
	const projectPath = params.path;

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

	const result = await stopRun(projectPath, vibezzzDir);
	if (!result) throw error(404, 'No active run found');

	return json(result);
};
