import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { appendIdea } from '$lib/server/ideas';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const content = body?.content;

	if (!content || typeof content !== 'string' || content.trim().length === 0) {
		return json({ error: 'content is required' }, { status: 400 });
	}

	const idea = await appendIdea(content.trim());
	return json(idea, { status: 201 });
};
