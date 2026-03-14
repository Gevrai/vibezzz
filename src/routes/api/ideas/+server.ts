import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { appendIdea } from '$lib/server/ideas';

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const content = (body as Record<string, unknown>)?.content;

	if (!content || typeof content !== 'string' || content.trim().length === 0) {
		return json({ error: 'content is required' }, { status: 400 });
	}

	const idea = await appendIdea(content.trim());
	return json(idea, { status: 201 });
};
