import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { promoteIdeaToProject, isValidPathSegment } from '$lib/server/projects';

export const POST: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id < 1) {
		return json({ error: 'Invalid idea id' }, { status: 400 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const { name, category, template } = (body ?? {}) as Record<string, unknown>;

	if (!name || typeof name !== 'string' || name.trim().length === 0) {
		return json({ error: 'name is required' }, { status: 400 });
	}
	if (!category || typeof category !== 'string' || category.trim().length === 0) {
		return json({ error: 'category is required' }, { status: 400 });
	}

	const trimmedName = name.trim();
	const trimmedCategory = category.trim();

	if (!isValidPathSegment(trimmedCategory)) {
		return json({ error: 'category contains invalid characters' }, { status: 400 });
	}
	if (!isValidPathSegment(trimmedName)) {
		return json({ error: 'name contains invalid characters' }, { status: 400 });
	}

	try {
		const project = await promoteIdeaToProject({
			ideaId: id,
			name: trimmedName,
			category: trimmedCategory,
			template: typeof template === 'string' ? template : undefined
		});
		return json(project, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Promotion failed';
		return json({ error: message }, { status: 400 });
	}
};
