/**
 * Agent runs API.
 * GET: list run history
 * POST: start a new run
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { getConfig } from '$lib/server/config';
import { verifyVibezzzDir } from '$lib/server/projects';
import { startRun, getRunHistory } from '$lib/server/agents';
import type { ProviderName, RunKind } from '$lib/server/providers';

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
	const runs = await getRunHistory(vibezzzDir);
	return json(runs);
};

export const POST: RequestHandler = async ({ params, request }) => {
	const { resolvedPath, vibezzzDir } = await resolveProject(params.path);
	const body = await request.json();

	if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
		throw error(400, 'prompt is required');
	}

	try {
		const entry = await startRun({
			projectPath: params.path,
			projectAbsPath: resolvedPath,
			vibezzzDir,
			provider: (body.provider as ProviderName) || undefined,
			kind: (body.kind as RunKind) || 'implement',
			prompt: body.prompt.trim(),
			ideaId: body.idea_id ?? null
		});

		return json(entry, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to start run';
		throw error(409, message);
	}
};
