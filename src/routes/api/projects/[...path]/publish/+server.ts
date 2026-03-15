/**
 * Publish API: apply publish state changes and update settings.
 *
 * POST: Apply a publish state transition or update publish settings.
 *   body.state → triggers state transition (up, down, lazy)
 *   body.image, body.subdomain, body.container_port → updates settings
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { getConfig } from '$lib/server/config';
import { verifyVibezzzDir } from '$lib/server/projects';
import { readDeployConfig } from '$lib/server/preview';
import { applyPublishState, updatePublishSettings, SubdomainConflictError, type PublishState } from '$lib/server/publish';
import { reconciliationReady } from '$lib/server/reconcile';

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
	if (!vibezzzDir) throw error(404, '.vibezzz not found');

	// Derive project name from the last path segment
	const segments = path.split('/');
	const projectName = segments[segments.length - 1] || path;

	return { resolvedPath, vibezzzDir, projectName };
}

const VALID_STATES: PublishState[] = ['up', 'down', 'lazy'];

export const GET: RequestHandler = async ({ params }) => {
	const { vibezzzDir } = await resolveProject(params.path);
	const config = await readDeployConfig(vibezzzDir);
	return json(config?.publish ?? null);
};

export const POST: RequestHandler = async ({ params, request }) => {
	await reconciliationReady();
	const projectPath = params.path;
	const { vibezzzDir, projectName } = await resolveProject(projectPath);
	const body = await request.json();

	// Update settings first if provided
	if (body.image !== undefined || body.subdomain !== undefined || body.container_port !== undefined) {
		try {
			await updatePublishSettings(vibezzzDir, projectName, {
				image: body.image,
				subdomain: body.subdomain,
				container_port: body.container_port ? parseInt(body.container_port, 10) : undefined
			});
		} catch (err) {
			if (err instanceof SubdomainConflictError) {
				throw error(409, err.message);
			}
			throw err;
		}
	}

	// Apply state change if requested
	if (body.state) {
		if (!VALID_STATES.includes(body.state)) {
			throw error(400, `Invalid publish state: ${body.state}. Must be one of: ${VALID_STATES.join(', ')}`);
		}

		try {
			const config = await applyPublishState(vibezzzDir, projectPath, projectName, body.state);
			return json(config);
		} catch (err) {
			if (err instanceof SubdomainConflictError) {
				throw error(409, err.message);
			}
			const message = err instanceof Error ? err.message : 'Publish operation failed';
			throw error(400, message);
		}
	}

	// No state change, just return updated config
	const config = await readDeployConfig(vibezzzDir);
	return json(config);
};
