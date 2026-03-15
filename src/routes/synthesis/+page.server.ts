import type { PageServerLoad } from './$types';
import { listProviders } from '$lib/server/providers';
import { getConfig } from '$lib/server/config';
import { listIdeas } from '$lib/server/ideas';

export const load: PageServerLoad = async () => {
	const config = getConfig();
	const providers = listProviders();
	const ideas = await listIdeas();
	const rawCount = ideas.filter((i) => i.status === 'raw').length;

	return {
		providers,
		defaultProvider: config.defaultProvider,
		rawIdeaCount: rawCount
	};
};
