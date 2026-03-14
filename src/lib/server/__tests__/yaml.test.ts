import { describe, it, expect, afterEach } from 'vitest';
import { readYaml, writeYaml } from '../yaml.js';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('yaml utilities', () => {
	let testDir: string;

	async function makeTempDir() {
		testDir = await mkdtemp(join(tmpdir(), 'vibebox-yaml-test-'));
		return testDir;
	}

	afterEach(async () => {
		if (testDir) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	describe('readYaml', () => {
		it('returns default value when file does not exist', async () => {
			await makeTempDir();
			const result = await readYaml(join(testDir, 'missing.yaml'), []);
			expect(result).toEqual([]);
		});

		it('parses YAML content', async () => {
			await makeTempDir();
			const filePath = join(testDir, 'data.yaml');
			const data = [{ id: 1, content: 'test idea', status: 'raw' }];

			await writeYaml(filePath, data);
			const result = await readYaml(filePath, []);

			expect(result).toEqual(data);
		});

		it('returns default for empty file', async () => {
			await makeTempDir();
			const filePath = join(testDir, 'empty.yaml');
			const { writeFile } = await import('node:fs/promises');
			await writeFile(filePath, '', 'utf-8');

			const result = await readYaml(filePath, []);
			expect(result).toEqual([]);
		});
	});

	describe('writeYaml', () => {
		it('writes valid YAML atomically', async () => {
			await makeTempDir();
			const filePath = join(testDir, 'output.yaml');
			const data = { name: 'test-project', stage: 'building' };

			await writeYaml(filePath, data);

			const content = await readFile(filePath, 'utf-8');
			expect(content).toContain('name: test-project');
			expect(content).toContain('stage: building');
		});

		it('creates parent directories if needed', async () => {
			await makeTempDir();
			const filePath = join(testDir, 'nested', 'deep', 'data.yaml');

			await writeYaml(filePath, { key: 'value' });

			const content = await readFile(filePath, 'utf-8');
			expect(content).toContain('key: value');
		});

		it('overwrites existing files', async () => {
			await makeTempDir();
			const filePath = join(testDir, 'overwrite.yaml');

			await writeYaml(filePath, { version: 1 });
			await writeYaml(filePath, { version: 2 });

			const result = await readYaml(filePath, {});
			expect(result).toEqual({ version: 2 });
		});

		it('leaves no temp files on success', async () => {
			await makeTempDir();
			const filePath = join(testDir, 'clean.yaml');

			await writeYaml(filePath, { clean: true });

			const { readdir } = await import('node:fs/promises');
			const files = await readdir(testDir);
			expect(files).toEqual(['clean.yaml']);
		});

		it('handles arrays correctly', async () => {
			await makeTempDir();
			const filePath = join(testDir, 'ideas.yaml');
			const ideas = [
				{ id: 1, content: 'idea one', status: 'raw' },
				{ id: 2, content: 'idea two', status: 'promoted' }
			];

			await writeYaml(filePath, ideas);
			const result = await readYaml(filePath, []);

			expect(result).toEqual(ideas);
		});
	});
});
