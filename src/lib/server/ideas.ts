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

// Serializes all mutations to ideas.yaml so concurrent requests
// cannot perform overlapping read-modify-write cycles.
let _lockChain: Promise<void> = Promise.resolve();

async function withIdeasLock<T>(fn: () => Promise<T>): Promise<T> {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const prev = _lockChain;
	_lockChain = gate;
	await prev;
	try {
		return await fn();
	} finally {
		release();
	}
}

export async function listIdeas(): Promise<Idea[]> {
	return await readYaml<Idea[]>(globalIdeasPath(), []);
}

function nextId(ideas: Idea[]): number {
	if (ideas.length === 0) return 1;
	return Math.max(...ideas.map((i) => i.id)) + 1;
}

export async function appendIdea(content: string): Promise<Idea> {
	return withIdeasLock(async () => {
		const ideas = await readYaml<Idea[]>(globalIdeasPath(), []);
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
	});
}

export async function updateIdea(
	id: number,
	updates: Partial<Pick<Idea, 'status' | 'project_path' | 'implemented_at' | 'git_tag'>>
): Promise<Idea> {
	return withIdeasLock(async () => {
		const ideas = await readYaml<Idea[]>(globalIdeasPath(), []);
		const idx = ideas.findIndex((i) => i.id === id);
		if (idx === -1) {
			throw new Error(`Idea #${id} not found`);
		}
		Object.assign(ideas[idx], updates);
		await writeYaml(globalIdeasPath(), ideas);
		return ideas[idx];
	});
}

/**
 * Atomically claims an idea for promotion: reads the ideas file, verifies the
 * idea exists and is still 'raw', marks it 'promoted', and writes back — all
 * under the ideas lock so a concurrent promote cannot double-claim.
 */
export async function claimIdeaForPromotion(id: number, projectPath: string): Promise<Idea> {
	return withIdeasLock(async () => {
		const ideas = await readYaml<Idea[]>(globalIdeasPath(), []);
		const idx = ideas.findIndex((i) => i.id === id);
		if (idx === -1) {
			throw new Error(`Idea #${id} not found`);
		}
		if (ideas[idx].status !== 'raw') {
			throw new Error(`Idea #${id} is already ${ideas[idx].status}`);
		}
		ideas[idx].status = 'promoted';
		ideas[idx].project_path = projectPath;
		await writeYaml(globalIdeasPath(), ideas);
		return ideas[idx];
	});
}

/**
 * Rolls back a claimed idea to 'raw' when project bootstrap fails after
 * claimIdeaForPromotion succeeded. Only resets ideas that are still 'promoted'.
 */
export async function unclaimIdea(id: number): Promise<void> {
	return withIdeasLock(async () => {
		const ideas = await readYaml<Idea[]>(globalIdeasPath(), []);
		const idx = ideas.findIndex((i) => i.id === id);
		if (idx === -1) return;
		if (ideas[idx].status !== 'promoted') return;
		ideas[idx].status = 'raw';
		ideas[idx].project_path = null;
		await writeYaml(globalIdeasPath(), ideas);
	});
}

export async function getIdea(id: number): Promise<Idea | undefined> {
	const ideas = await listIdeas();
	return ideas.find((i) => i.id === id);
}
