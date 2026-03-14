import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { readYaml, writeYaml } from '../yaml.js';

const execFileAsync = promisify(execFile);

describe('projects', () => {
	let testDir: string;
	let projectsDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), 'vibebox-projects-test-'));
		projectsDir = join(testDir, 'projects');
		await mkdir(projectsDir, { recursive: true });

		vi.resetModules();

		vi.doMock('$env/dynamic/private', () => ({
			env: {
				BIND_HOST: '100.64.0.1',
				PROJECTS_DIR: projectsDir,
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

	async function createGitRepo(path: string): Promise<void> {
		await mkdir(path, { recursive: true });
		await execFileAsync('git', ['init', path]);
	}

	it('returns empty list when projects dir is empty', async () => {
		const { scanProjects } = await import('../projects.js');
		const projects = await scanProjects();
		expect(projects).toEqual([]);
	});

	it('discovers git repos with .vibezzz/meta.yaml', async () => {
		const projPath = join(projectsDir, 'js', 'my-app');
		await createGitRepo(projPath);

		const meta = {
			name: 'my-app',
			category: 'js',
			origin: 'brain',
			created_at: '2026-01-01T00:00:00Z',
			idea_id: 1,
			template: null,
			project_stage: 'building',
			last_ready_at: null
		};
		await writeYaml(join(projPath, '.vibezzz', 'meta.yaml'), meta);

		const { scanProjects } = await import('../projects.js');
		const projects = await scanProjects();

		expect(projects).toHaveLength(1);
		expect(projects[0].path).toBe('js/my-app');
		expect(projects[0].meta.origin).toBe('brain');
		expect(projects[0].signals).toBeDefined();
	});

	it('recognizes external repos without .vibezzz', async () => {
		const projPath = join(projectsDir, 'python', 'external-lib');
		await createGitRepo(projPath);

		const { scanProjects } = await import('../projects.js');
		const projects = await scanProjects();

		expect(projects).toHaveLength(1);
		expect(projects[0].meta.origin).toBe('external');
		expect(projects[0].meta.name).toBe('external-lib');
		expect(projects[0].meta.category).toBe('python');
		expect(projects[0].signals).toBeDefined();
	});

	it('resync creates meta.yaml for external repos', async () => {
		const projPath = join(projectsDir, 'go', 'bare-repo');
		await createGitRepo(projPath);

		const { resyncProjects } = await import('../projects.js');
		await resyncProjects();

		const meta = await readYaml<any>(join(projPath, '.vibezzz', 'meta.yaml'), null);
		expect(meta).not.toBeNull();
		expect(meta.origin).toBe('external');
		expect(meta.name).toBe('bare-repo');
	});

	it('promotes an idea into a project', async () => {
		const { appendIdea } = await import('../ideas.js');
		const { promoteIdeaToProject } = await import('../projects.js');

		await appendIdea('build a CLI tool');

		const project = await promoteIdeaToProject({
			ideaId: 1,
			name: 'cli-tool',
			category: 'rust'
		});

		expect(project.path).toBe('rust/cli-tool');
		expect(project.meta.origin).toBe('brain');
		expect(project.meta.idea_id).toBe(1);
		expect(project.meta.project_stage).toBe('bootstrapping');

		// Verify directory structure
		const metaPath = join(projectsDir, 'rust', 'cli-tool', '.vibezzz', 'meta.yaml');
		const meta = await readYaml<any>(metaPath, null);
		expect(meta.name).toBe('cli-tool');

		// Verify .git exists
		await expect(access(join(projectsDir, 'rust', 'cli-tool', '.git'))).resolves.toBeUndefined();

		// Verify idea was updated
		const { getIdea } = await import('../ideas.js');
		const idea = await getIdea(1);
		expect(idea?.status).toBe('promoted');
		expect(idea?.project_path).toBe('rust/cli-tool');
	});

	it('rejects promoting an already promoted idea', async () => {
		const { appendIdea } = await import('../ideas.js');
		const { promoteIdeaToProject } = await import('../projects.js');

		await appendIdea('build something');
		await promoteIdeaToProject({ ideaId: 1, name: 'proj', category: 'js' });

		await expect(
			promoteIdeaToProject({ ideaId: 1, name: 'proj2', category: 'js' })
		).rejects.toThrow('already promoted');
	});

	it('rejects promoting to existing directory', async () => {
		const { appendIdea } = await import('../ideas.js');
		const { promoteIdeaToProject } = await import('../projects.js');

		await appendIdea('build something');
		await mkdir(join(projectsDir, 'js', 'taken'), { recursive: true });

		await expect(
			promoteIdeaToProject({ ideaId: 1, name: 'taken', category: 'js' })
		).rejects.toThrow('already exists');
	});

	it('creates deploy.yaml with correct defaults', async () => {
		const { appendIdea } = await import('../ideas.js');
		const { promoteIdeaToProject } = await import('../projects.js');

		await appendIdea('deploy test');
		await promoteIdeaToProject({ ideaId: 1, name: 'deploy-test', category: 'web' });

		const deploy = await readYaml<any>(
			join(projectsDir, 'web', 'deploy-test', '.vibezzz', 'deploy.yaml'),
			null
		);
		expect(deploy.preview.status).toBe('stopped');
		expect(deploy.publish.state).toBe('down');
		expect(deploy.automation.auto_start_agent).toBe(true);
	});

	it('rejects path traversal in category', async () => {
		const { appendIdea } = await import('../ideas.js');
		const { promoteIdeaToProject } = await import('../projects.js');

		await appendIdea('traversal test');
		await expect(
			promoteIdeaToProject({ ideaId: 1, name: 'safe-name', category: '..' })
		).rejects.toThrow('Invalid');
	});

	it('rejects path traversal in name', async () => {
		const { appendIdea } = await import('../ideas.js');
		const { promoteIdeaToProject } = await import('../projects.js');

		await appendIdea('traversal test');
		await expect(
			promoteIdeaToProject({ ideaId: 1, name: '../../../etc', category: 'js' })
		).rejects.toThrow('Invalid');
	});

	it('rejects slashes in name', async () => {
		const { appendIdea } = await import('../ideas.js');
		const { promoteIdeaToProject } = await import('../projects.js');

		await appendIdea('slash test');
		await expect(
			promoteIdeaToProject({ ideaId: 1, name: 'foo/bar', category: 'js' })
		).rejects.toThrow('Invalid');
	});

	it('validates isValidPathSegment correctly', async () => {
		const { isValidPathSegment } = await import('../projects.js');

		expect(isValidPathSegment('my-project')).toBe(true);
		expect(isValidPathSegment('project_name')).toBe(true);
		expect(isValidPathSegment('project.name')).toBe(true);
		expect(isValidPathSegment('Project123')).toBe(true);

		expect(isValidPathSegment('..')).toBe(false);
		expect(isValidPathSegment('.')).toBe(false);
		expect(isValidPathSegment('')).toBe(false);
		expect(isValidPathSegment('../etc')).toBe(false);
		expect(isValidPathSegment('foo/bar')).toBe(false);
		expect(isValidPathSegment('.hidden')).toBe(false);
		expect(isValidPathSegment('-starts-with-dash')).toBe(false);
	});

	it('reads deploy.yaml signals during scan', async () => {
		const projPath = join(projectsDir, 'web', 'signal-test');
		await createGitRepo(projPath);

		const meta = {
			name: 'signal-test',
			category: 'web',
			origin: 'brain',
			created_at: '2026-01-01T00:00:00Z',
			idea_id: null,
			template: null,
			project_stage: 'preview_ready',
			last_ready_at: null
		};
		await writeYaml(join(projPath, '.vibezzz', 'meta.yaml'), meta);
		await writeYaml(join(projPath, '.vibezzz', 'deploy.yaml'), {
			preview: { status: 'ready', url: 'https://signal-test-preview.example.com' },
			publish: { state: 'up', url: 'https://signal-test.example.com' }
		});
		await writeYaml(join(projPath, '.vibezzz', 'agents.yaml'), [
			{ id: 'run-1', status: 'running', started_at: '2026-01-01T00:00:00Z' }
		]);

		const { scanProjects } = await import('../projects.js');
		const projects = await scanProjects();
		const project = projects.find(p => p.meta.name === 'signal-test');

		expect(project).toBeDefined();
		expect(project!.signals.preview_status).toBe('ready');
		expect(project!.signals.preview_url).toBe('https://signal-test-preview.example.com');
		expect(project!.signals.publish_state).toBe('up');
		expect(project!.signals.publish_url).toBe('https://signal-test.example.com');
		expect(project!.signals.agent_active).toBe(true);
		expect(project!.signals.last_agent_status).toBe('running');
	});
});
