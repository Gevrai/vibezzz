import type { Actions, PageServerLoad } from './$types';
import { listIdeas, appendIdea } from '$lib/server/ideas';
import { fail } from '@sveltejs/kit';

export const load: PageServerLoad = async () => {
	const ideas = await listIdeas();
	return {
		ideas: ideas.slice().reverse()
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const data = await request.formData();
		const content = data.get('content');

		if (!content || typeof content !== 'string' || content.trim().length === 0) {
			return fail(400, { error: 'Content is required', content: '' });
		}

		await appendIdea(content.trim());
		return { success: true };
	}
};
