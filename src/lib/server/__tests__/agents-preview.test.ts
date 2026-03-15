import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

function setBaseEnv(overrides: Record<string, string> = {}) {
	const defaults: Record<string, string> = {
		PROJECTS_DIR: '/tmp/test-projects',
		VIBEZZZ_REPO: '/tmp/test-vibezzz',
		DOMAIN: 'test.example.com',
		BIND_HOST: '100.64.0.1',
		CADDY_ADMIN_URL: 'http://localhost:29999'
	};
	Object.assign(process.env, defaults, overrides);
}

function mockSvelteEnv() {
	vi.doMock('$env/dynamic/private', () => ({
		env: process.env
	}));
}

describe('notifications', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
		setBaseEnv();
		mockSvelteEnv();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('tracks notifications in memory', async () => {
		const { notify, getRecentNotifications } = await import('../notifications');
		await notify('preview_ready', 'test/project', 'Preview ready');
		const recent = getRecentNotifications();
		expect(recent.length).toBe(1);
		expect(recent[0].event).toBe('preview_ready');
		expect(recent[0].project).toBe('project');
	});

	it('includes URL in notification when provided', async () => {
		const { notify, getRecentNotifications } = await import('../notifications');
		await notify('preview_ready', 'test/proj', 'Ready', 'https://example.com');
		const recent = getRecentNotifications();
		expect(recent[0].url).toBe('https://example.com');
	});

	it('limits recent notifications', async () => {
		const { notify, getRecentNotifications } = await import('../notifications');
		for (let i = 0; i < 60; i++) {
			await notify('run_completed', `proj-${i}`, `Run ${i}`);
		}
		const recent = getRecentNotifications();
		expect(recent.length).toBeLessThanOrEqual(50);
	});
});

describe('providers', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('lists available providers', async () => {
		const { listProviders } = await import('../providers');
		const providers = listProviders();
		expect(providers).toContain('claude');
		expect(providers).toContain('copilot');
	});

	it('gets a provider by name', async () => {
		const { getProvider } = await import('../providers');
		const claude = getProvider('claude');
		expect(claude.name).toBe('claude');
	});

	it('throws for unknown provider', async () => {
		const { getProvider } = await import('../providers');
		expect(() => getProvider('unknown' as any)).toThrow('Unknown provider');
	});
});

describe('caddy', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
		setBaseEnv();
		mockSvelteEnv();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('handles unavailable Caddy gracefully on upsert', async () => {
		const { upsertRoute } = await import('../caddy');
		const result = await upsertRoute('test-route', 'test.example.com', 3001);
		expect(result).toBe(false);
	});

	it('handles unavailable Caddy gracefully on remove', async () => {
		const { removeRoute } = await import('../caddy');
		const result = await removeRoute('nonexistent-route');
		expect(result).toBe(false);
	});

	it('reports Caddy as unavailable when not running', async () => {
		const { isCaddyAvailable } = await import('../caddy');
		const available = await isCaddyAvailable();
		expect(available).toBe(false);
	});
});

describe('agents', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-agents-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('returns empty run history for new project', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'agents.yaml'), []);

		const { getRunHistory } = await import('../agents');
		const history = await getRunHistory(vibezzzDir);
		expect(history).toEqual([]);
	});

	it('tracks active runs in memory', async () => {
		const { getAllActiveRuns } = await import('../agents');
		const runs = getAllActiveRuns();
		expect(runs).toEqual([]);
	});
});

describe('reconcile', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-reconcile-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('runs without crashing on empty projects dir', async () => {
		const { reconcileOnStartup } = await import('../reconcile');
		await reconcileOnStartup();
	});

	it('marks stale runs as failed', async () => {
		const { writeYaml, readYaml } = await import('../yaml');
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const execFileAsync = promisify(execFile);

		const projDir = join(tempDir, 'cat', 'proj');
		await mkdir(projDir, { recursive: true });
		await execFileAsync('git', ['init', projDir]);

		const vibezzzDir = join(projDir, '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		await writeYaml(join(vibezzzDir, 'meta.yaml'), {
			name: 'proj',
			category: 'cat',
			origin: 'brain',
			created_at: new Date().toISOString(),
			idea_id: null,
			template: null,
			project_stage: 'building',
			last_ready_at: null
		});

		await writeYaml(join(vibezzzDir, 'agents.yaml'), [{
			id: 1,
			provider: 'claude',
			kind: 'implement',
			summary: 'Test run',
			started_at: new Date().toISOString(),
			finished_at: null,
			status: 'running',
			pid: 999999,
			process_started_at: new Date().toISOString(),
			cwd: projDir,
			idea_id: null,
			log_path: '.vibezzz/logs/1.log',
			exit_code: null,
			branch: 'main',
			commit_sha: null,
			result: null,
			preview_url: null
		}]);

		const { reconcileOnStartup } = await import('../reconcile');
		await reconcileOnStartup();

		const agents = await readYaml<any[]>(join(vibezzzDir, 'agents.yaml'), []);
		expect(agents[0].status).toBe('failed');
		expect(agents[0].finished_at).toBeTruthy();
	});
});

describe('preview', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-preview-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('returns empty active previews initially', async () => {
		const { getAllActivePreviews } = await import('../preview');
		expect(getAllActivePreviews()).toEqual([]);
	});

	it('reads deploy config from YAML', async () => {
		const { writeYaml } = await import('../yaml');
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: 'npm run dev',
				port: 3001,
				healthcheck_path: '/',
				pid: null,
				process_started_at: null,
				status: 'stopped',
				subdomain: 'test-preview',
				url: null,
				public: true,
				last_ready_at: null
			}
		});

		const { readDeployConfig } = await import('../preview');
		const config = await readDeployConfig(vibezzzDir);
		expect(config).toBeTruthy();
		expect(config!.preview.command).toBe('npm run dev');
		expect(config!.preview.port).toBe(3001);
	});

	it('updates deploy settings', async () => {
		const { writeYaml, readYaml } = await import('../yaml');
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '',
				port: 3001,
				healthcheck_path: '/',
				pid: null,
				process_started_at: null,
				status: 'stopped',
				subdomain: '',
				url: null,
				public: true,
				last_ready_at: null
			}
		});

		const { updateDeploySettings } = await import('../preview');
		await updateDeploySettings(vibezzzDir, {
			previewCommand: 'bun run dev',
			previewPort: 4000
		});

		const updated = await readYaml<any>(join(vibezzzDir, 'deploy.yaml'), null);
		expect(updated.preview.command).toBe('bun run dev');
		expect(updated.preview.port).toBe(4000);
	});

	it('rejects start with no command configured', async () => {
		const { writeYaml } = await import('../yaml');
		const projDir = join(tempDir, 'cat', 'proj');
		const vibezzzDir = join(projDir, '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '',
				port: 3001,
				healthcheck_path: '/',
				pid: null,
				process_started_at: null,
				status: 'stopped',
				subdomain: '',
				url: null,
				public: true,
				last_ready_at: null
			}
		});

		const { startPreview } = await import('../preview');
		await expect(startPreview('cat/proj', projDir, vibezzzDir)).rejects.toThrow(
			'No preview command configured'
		);
	});

	it('checks preview health returns false for non-running port', async () => {
		const { checkPreviewHealth } = await import('../preview');
		const healthy = await checkPreviewHealth(49999, '/');
		expect(healthy).toBe(false);
	});
});
