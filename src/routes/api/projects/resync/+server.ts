import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resyncProjects } from '$lib/server/projects';

export const POST: RequestHandler = async () => {
	const projects = await resyncProjects();
	return json({ projects, count: projects.length });
};
