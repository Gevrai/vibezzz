import { join } from 'node:path';
import { readYaml, writeYaml } from './yaml';
import { getConfig } from './config';

export interface Idea {
	id: number;
	content: string;
	created_at: string;
	status: 'raw' | 'promoted' | 'implemented';
	project_path: string | null;
	implemented_at: string | null;
	git_tag: string | null;
}

function globalIdeasPath(): string {
	return join(getConfig().vibezzzRepo, 'ideas.yaml');
}

export async function listIdeas(): Promise<Idea[]> {
	return await readYaml<Idea[]>(globalIdeasPath(), []);
}

function nextId(ideas: Idea[]): number {
	if (ideas.length === 0) return 1;
	return Math.max(...ideas.map((i) => i.id)) + 1;
}

export async function appendIdea(content: string): Promise<Idea> {
	const ideas = await listIdeas();
	const idea: Idea = {
		id: nextId(ideas),
		content,
		created_at: new Date().toISOString(),
		status: 'raw',
		project_path: null,
		implemented_at: null,
		git_tag: null
	};
	ideas.push(idea);
	await writeYaml(globalIdeasPath(), ideas);
	return idea;
}

export async function updateIdea(
	id: number,
	updates: Partial<Pick<Idea, 'status' | 'project_path' | 'implemented_at' | 'git_tag'>>
): Promise<Idea> {
	const ideas = await listIdeas();
	const idx = ideas.findIndex((i) => i.id === id);
	if (idx === -1) {
		throw new Error(`Idea #${id} not found`);
	}
	Object.assign(ideas[idx], updates);
	await writeYaml(globalIdeasPath(), ideas);
	return ideas[idx];
}

export async function getIdea(id: number): Promise<Idea | undefined> {
	const ideas = await listIdeas();
	return ideas.find((i) => i.id === id);
}
