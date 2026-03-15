/**
 * Update deploy configuration (preview command, port, publish settings, etc).
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { getConfig } from '$lib/server/config';
import { verifyVibezzzDir } from '$lib/server/projects';
import { updateDeploySettings, readDeployConfig } from '$lib/server/preview';
import { updatePublishSettings } from '$lib/server/publish';

export const GET: RequestHandler = async ({ params }) => {
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
		resolvedRoot = await resolve(projectsDir);
	}
	if (!resolvedPath.startsWith(resolvedRoot + '/')) {
		throw error(400, 'Invalid project path');
	}

	const vibezzzDir = await verifyVibezzzDir(resolvedPath);
	if (!vibezzzDir) throw error(404, '.vibezzz not found');

	const config = await readDeployConfig(vibezzzDir);
	return json(config);
};

export const POST: RequestHandler = async ({ params, request }) => {
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
		resolvedRoot = await resolve(projectsDir);
	}
	if (!resolvedPath.startsWith(resolvedRoot + '/')) {
		throw error(400, 'Invalid project path');
	}

	const vibezzzDir = await verifyVibezzzDir(resolvedPath);
	if (!vibezzzDir) throw error(404, '.vibezzz not found');

	const body = await request.json();
	let config = await updateDeploySettings(vibezzzDir, {
		previewCommand: body.preview_command,
		previewPort: body.preview_port ? parseInt(body.preview_port, 10) : undefined,
		previewSubdomain: body.preview_subdomain,
		healthcheckPath: body.healthcheck_path
	});

	// Also update publish settings if provided
	if (body.publish_image !== undefined || body.publish_subdomain !== undefined) {
		const segments = projectPath.split('/');
		const projectName = segments[segments.length - 1] || projectPath;
		config = await updatePublishSettings(vibezzzDir, projectName, {
			image: body.publish_image,
			subdomain: body.publish_subdomain
		});
	}

	return json(config);
};
