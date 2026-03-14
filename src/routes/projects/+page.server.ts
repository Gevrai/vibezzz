import type { PageServerLoad } from './$types';
import { scanProjects } from '$lib/server/projects';

export const load: PageServerLoad = async () => {
	const projects = await scanProjects();

	// Group by category
	const grouped: Record<string, typeof projects> = {};
	for (const p of projects) {
		const cat = p.meta.category;
		if (!grouped[cat]) grouped[cat] = [];
		grouped[cat].push(p);
	}

	// Sort categories alphabetically, projects by name within each
	const categories = Object.keys(grouped).sort();
	for (const cat of categories) {
		grouped[cat].sort((a, b) => a.meta.name.localeCompare(b.meta.name));
	}

	return { grouped, categories, count: projects.length };
};
