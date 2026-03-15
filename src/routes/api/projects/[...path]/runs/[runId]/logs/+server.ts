/**
 * Stream live logs for an active agent run.
 * Uses Server-Sent Events (SSE) for real-time log streaming.
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { getConfig } from '$lib/server/config';
import { verifyVibezzzDir } from '$lib/server/projects';
import { subscribeLogs, getActiveRun, readRunLog } from '$lib/server/agents';

export const GET: RequestHandler = async ({ params, request }) => {
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

	const activeRun = getActiveRun(projectPath);
	if (!activeRun) {
		// No active run — return the static log if a runId was specified
		const runId = parseInt(params.runId, 10);
		if (!isNaN(runId)) {
			const { readYaml } = await import('$lib/server/yaml');
			const entries = await readYaml<Array<{ id: number; log_path: string }>>(
				join(vibezzzDir, 'agents.yaml'),
				[]
			);
			const entry = entries.find((e) => e.id === runId);
			if (entry?.log_path) {
				const log = await readRunLog(resolvedPath, entry.log_path);
				return new Response(log, {
					headers: { 'Content-Type': 'text/plain' }
				});
			}
		}
		throw error(404, 'No active run found');
	}

	// SSE stream for live logs
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const send = (data: string) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					/* stream closed */
				}
			};

			const unsub = subscribeLogs(projectPath, send);

			// Close when client disconnects
			request.signal.addEventListener('abort', () => {
				unsub();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});

			// Close when run completes
			activeRun.done.then(() => {
				send('[DONE]');
				unsub();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
