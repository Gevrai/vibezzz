import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { promoteIdeaToProject } from '$lib/server/projects';

export const POST: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id < 1) {
		return json({ error: 'Invalid idea id' }, { status: 400 });
	}

	const body = await request.json();
	const { name, category, template } = body ?? {};

	if (!name || typeof name !== 'string' || name.trim().length === 0) {
		return json({ error: 'name is required' }, { status: 400 });
	}
	if (!category || typeof category !== 'string' || category.trim().length === 0) {
		return json({ error: 'category is required' }, { status: 400 });
	}

	try {
		const project = await promoteIdeaToProject({
			ideaId: id,
			name: name.trim(),
			category: category.trim(),
			template: template || undefined
		});
		return json(project, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Promotion failed';
		return json({ error: message }, { status: 400 });
	}
};
