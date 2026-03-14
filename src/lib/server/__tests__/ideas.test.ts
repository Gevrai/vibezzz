import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readYaml, writeYaml } from '../yaml.js';

describe('ideas', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), 'vibebox-ideas-test-'));
		vi.resetModules();

		// Mock config to use our temp dir
		vi.doMock('$env/dynamic/private', () => ({
			env: {
				BIND_HOST: '100.64.0.1',
				PROJECTS_DIR: join(testDir, 'projects'),
				VIBEZZZ_REPO: testDir,
				DOMAIN: 'test.example.com'
			}
		}));
	});

	afterEach(async () => {
		if (testDir) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	it('returns empty list when no ideas file exists', async () => {
		const { listIdeas } = await import('../ideas.js');
		const ideas = await listIdeas();
		expect(ideas).toEqual([]);
	});

	it('appends an idea with auto-incremented id', async () => {
		const { appendIdea, listIdeas } = await import('../ideas.js');

		const idea = await appendIdea('build a music queue app');
		expect(idea.id).toBe(1);
		expect(idea.content).toBe('build a music queue app');
		expect(idea.status).toBe('raw');
		expect(idea.project_path).toBeNull();

		const all = await listIdeas();
		expect(all).toHaveLength(1);
		expect(all[0].id).toBe(1);
	});

	it('auto-increments ids across multiple appends', async () => {
		const { appendIdea } = await import('../ideas.js');

		const first = await appendIdea('first idea');
		const second = await appendIdea('second idea');
		const third = await appendIdea('third idea');

		expect(first.id).toBe(1);
		expect(second.id).toBe(2);
		expect(third.id).toBe(3);
	});

	it('updates idea status and metadata', async () => {
		const { appendIdea, updateIdea, getIdea } = await import('../ideas.js');

		await appendIdea('promote this one');
		const updated = await updateIdea(1, {
			status: 'promoted',
			project_path: 'js/music-queue'
		});

		expect(updated.status).toBe('promoted');
		expect(updated.project_path).toBe('js/music-queue');

		const fetched = await getIdea(1);
		expect(fetched?.status).toBe('promoted');
	});

	it('throws when updating non-existent idea', async () => {
		const { updateIdea } = await import('../ideas.js');
		await expect(updateIdea(999, { status: 'promoted' })).rejects.toThrow('Idea #999 not found');
	});

	it('persists ideas to YAML file', async () => {
		const { appendIdea } = await import('../ideas.js');

		await appendIdea('persistent idea');

		const raw = await readYaml<any[]>(join(testDir, 'ideas.yaml'), []);
		expect(raw).toHaveLength(1);
		expect(raw[0].content).toBe('persistent idea');
		expect(raw[0].status).toBe('raw');
	});
});
