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
		PORT: '3000',
		CADDY_ADMIN_URL: 'http://localhost:29999',
		CONTAINER_RUNTIME: 'docker'
	};
	Object.assign(process.env, defaults, overrides);
}

function mockSvelteEnv() {
	vi.doMock('$env/dynamic/private', () => ({
		env: process.env
	}));
}

describe('publish — settings', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-publish-'));
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

	it('creates default publish config when none exists', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
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

		const { updatePublishSettings } = await import('../publish');
		const result = await updatePublishSettings(vibezzzDir, 'my-proj', {
			image: 'my-image:latest'
		});

		expect(result.publish).toBeTruthy();
		expect(result.publish!.image).toBe('my-image:latest');
		expect(result.publish!.subdomain).toBe('my-proj');
		expect(result.publish!.state).toBe('down');
	});

	it('updates image without changing state', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
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
			},
			publish: {
				state: 'down',
				subdomain: 'test-sub',
				url: null,
				image: 'old:v1',
				container_name: 'vibebox-test-sub',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-test-sub'
			}
		});

		const { updatePublishSettings } = await import('../publish');
		const result = await updatePublishSettings(vibezzzDir, 'proj', {
			image: 'new:v2'
		});

		expect(result.publish!.image).toBe('new:v2');
		expect(result.publish!.state).toBe('down');
		expect(result.publish!.subdomain).toBe('test-sub');
	});

	it('updates subdomain and cascades to container_name and caddy_route_id', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
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

		const { updatePublishSettings } = await import('../publish');
		const result = await updatePublishSettings(vibezzzDir, 'proj', {
			subdomain: 'my-app'
		});

		expect(result.publish!.subdomain).toBe('my-app');
		expect(result.publish!.container_name).toBe('vibebox-my-app');
		expect(result.publish!.caddy_route_id).toBe('vibebox-my-app');
	});
});

describe('publish — defaultPublish', () => {
	beforeEach(() => {
		vi.resetModules();
		setBaseEnv();
		mockSvelteEnv();
	});

	it('generates DNS-safe subdomain from project name', async () => {
		const { defaultPublish } = await import('../publish');
		const config = defaultPublish('My Cool App');
		expect(config.subdomain).toBe('my-cool-app');
		expect(config.container_name).toBe('vibebox-my-cool-app');
		expect(config.state).toBe('down');
	});
});

describe('publish — state transitions', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-publish-state-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		const { stopIdleTimer } = await import('../publish');
		stopIdleTimer();
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('rejects publish up without image', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
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
		await writeYaml(join(vibezzzDir, 'meta.yaml'), {
			name: 'proj',
			category: 'cat',
			origin: 'brain',
			created_at: new Date().toISOString(),
			project_stage: 'building'
		});

		const { applyPublishState } = await import('../publish');
		await expect(
			applyPublishState(vibezzzDir, 'cat/proj', 'proj', 'up')
		).rejects.toThrow('no container image configured');
	});

	it('rejects publish lazy without image', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
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
		await writeYaml(join(vibezzzDir, 'meta.yaml'), {
			name: 'proj',
			category: 'cat',
			origin: 'brain',
			created_at: new Date().toISOString(),
			project_stage: 'building'
		});

		const { applyPublishState } = await import('../publish');
		await expect(
			applyPublishState(vibezzzDir, 'cat/proj', 'proj', 'lazy')
		).rejects.toThrow('no container image configured');
	});

	it('down transition does not mutate non-published project_stage', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml, readYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: 'bun run dev',
				port: 3001,
				healthcheck_path: '/',
				pid: null,
				process_started_at: null,
				status: 'ready',
				subdomain: 'proj-preview',
				url: 'https://proj-preview.test.example.com',
				public: true,
				last_ready_at: new Date().toISOString()
			},
			publish: {
				state: 'down',
				subdomain: 'proj',
				url: null,
				image: 'proj:latest',
				container_name: 'vibebox-proj',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-proj'
			}
		});
		await writeYaml(join(vibezzzDir, 'meta.yaml'), {
			name: 'proj',
			category: 'cat',
			origin: 'brain',
			created_at: new Date().toISOString(),
			project_stage: 'preview_ready'
		});

		const { applyPublishState } = await import('../publish');
		await applyPublishState(vibezzzDir, 'cat/proj', 'proj', 'down');

		const meta = await readYaml<any>(join(vibezzzDir, 'meta.yaml'), null);
		// project_stage should stay as 'preview_ready', NOT be changed
		expect(meta.project_stage).toBe('preview_ready');
	});

	it('down transition reverts published stage to building', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml, readYaml } = await import('../yaml');
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
			},
			publish: {
				state: 'up',
				subdomain: 'proj',
				url: 'https://proj.test.example.com',
				image: 'proj:latest',
				container_name: 'vibebox-proj',
				container_id: 'abc123',
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-proj'
			}
		});
		await writeYaml(join(vibezzzDir, 'meta.yaml'), {
			name: 'proj',
			category: 'cat',
			origin: 'brain',
			created_at: new Date().toISOString(),
			project_stage: 'published'
		});

		const { applyPublishState } = await import('../publish');
		await applyPublishState(vibezzzDir, 'cat/proj', 'proj', 'down');

		const meta = await readYaml<any>(join(vibezzzDir, 'meta.yaml'), null);
		expect(meta.project_stage).toBe('building');
	});

	it('down transition clears publish url and container_id', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
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
			},
			publish: {
				state: 'up',
				subdomain: 'proj',
				url: 'https://proj.test.example.com',
				image: 'proj:latest',
				container_name: 'vibebox-proj',
				container_id: 'abc123',
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-proj'
			}
		});
		await writeYaml(join(vibezzzDir, 'meta.yaml'), {
			name: 'proj',
			category: 'cat',
			origin: 'brain',
			created_at: new Date().toISOString(),
			project_stage: 'published'
		});

		const { applyPublishState } = await import('../publish');
		const result = await applyPublishState(vibezzzDir, 'cat/proj', 'proj', 'down');

		expect(result.publish!.state).toBe('down');
		expect(result.publish!.url).toBeNull();
		expect(result.publish!.container_id).toBeNull();
	});
});

describe('publish — lazy registry', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
		setBaseEnv();
		mockSvelteEnv();
	});

	afterEach(async () => {
		try {
			const { stopIdleTimer } = await import('../publish');
			stopIdleTimer();
		} catch { /* module may not be loaded */ }
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('isLazyHost returns false for non-matching domain', async () => {
		const { isLazyHost } = await import('../publish');
		expect(isLazyHost('other.domain.com')).toBe(false);
	});

	it('isLazyHost returns false for empty lazy registry', async () => {
		const { isLazyHost } = await import('../publish');
		expect(isLazyHost('something.test.example.com')).toBe(false);
	});

	it('getLazyRegistry returns empty map initially', async () => {
		const { getLazyRegistry } = await import('../publish');
		expect(getLazyRegistry().size).toBe(0);
	});
});

describe('publish — reconciliation', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-publish-recon-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		try {
			const { stopIdleTimer } = await import('../publish');
			stopIdleTimer();
		} catch { /* module may not be loaded */ }
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('reconcilePublish skips projects without publish config', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
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

		const { reconcilePublish } = await import('../publish');
		// Should not throw
		await reconcilePublish(vibezzzDir, 'cat/proj');
	});

	it('reconcilePublish populates lazy registry for lazy projects', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
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
			},
			publish: {
				state: 'lazy',
				subdomain: 'my-lazy-app',
				url: 'https://my-lazy-app.test.example.com',
				image: 'my-image:latest',
				container_name: 'vibebox-my-lazy-app',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-my-lazy-app'
			}
		});

		const { reconcilePublish, getLazyRegistry, isLazyHost, stopIdleTimer } = await import('../publish');
		await reconcilePublish(vibezzzDir, 'cat/proj');

		expect(getLazyRegistry().has('my-lazy-app')).toBe(true);
		expect(isLazyHost('my-lazy-app.test.example.com')).toBe(true);
		stopIdleTimer();
	});

	it('reconcilePublish marks stale up container as down', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml, readYaml } = await import('../yaml');
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
			},
			publish: {
				state: 'up',
				subdomain: 'my-app',
				url: 'https://my-app.test.example.com',
				image: 'my-image:latest',
				container_name: 'vibebox-my-app',
				container_id: 'dead-container-id',
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-my-app'
			}
		});

		const { reconcilePublish } = await import('../publish');
		// Container doesn't exist so containerIsRunning returns false
		await reconcilePublish(vibezzzDir, 'cat/proj');

		const deploy = await readYaml<any>(join(vibezzzDir, 'deploy.yaml'), null);
		expect(deploy.publish.state).toBe('down');
		expect(deploy.publish.container_id).toBeNull();
		expect(deploy.publish.url).toBeNull();
	});
});

describe('publish — notifications', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-publish-notify-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		try {
			const { stopIdleTimer } = await import('../publish');
			stopIdleTimer();
		} catch { /* module may not be loaded */ }
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('lazy transition sends publish_succeeded notification', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
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
			},
			publish: {
				state: 'down',
				subdomain: 'my-lazy',
				url: null,
				image: 'test:latest',
				container_name: 'vibebox-my-lazy',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-my-lazy'
			}
		});
		await writeYaml(join(vibezzzDir, 'meta.yaml'), {
			name: 'proj',
			category: 'cat',
			origin: 'brain',
			created_at: new Date().toISOString(),
			project_stage: 'building'
		});

		const { applyPublishState, stopIdleTimer } = await import('../publish');
		await applyPublishState(vibezzzDir, 'cat/proj', 'proj', 'lazy');

		const { getRecentNotifications } = await import('../notifications');
		const notifications = getRecentNotifications();
		const publishNotif = notifications.find(
			(n) => n.event === 'publish_succeeded' && n.summary.includes('lazy')
		);
		expect(publishNotif).toBeTruthy();
		expect(publishNotif!.url).toBe('https://my-lazy.test.example.com');

		stopIdleTimer();
	});
});

describe('publish — startup reconciliation wiring', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-reconcile-publish-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		try {
			const { stopIdleTimer } = await import('../publish');
			stopIdleTimer();
		} catch { /* module may not be loaded */ }
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('reconcileOnStartup reconciles publish state for projects', async () => {
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
			project_stage: 'published'
		});
		await writeYaml(join(vibezzzDir, 'agents.yaml'), []);
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
			},
			publish: {
				state: 'up',
				subdomain: 'proj',
				url: 'https://proj.test.example.com',
				image: 'proj:latest',
				container_name: 'vibebox-proj',
				container_id: 'stale-id',
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-proj'
			}
		});

		const { reconcileOnStartup } = await import('../reconcile');
		await reconcileOnStartup();

		// The container doesn't exist, so publish should be marked down
		const deploy = await readYaml<any>(join(vibezzzDir, 'deploy.yaml'), null);
		expect(deploy.publish.state).toBe('down');
		expect(deploy.publish.container_id).toBeNull();
	});

	it('reconcileOnStartup populates lazy registry for lazy projects', async () => {
		const { writeYaml } = await import('../yaml');
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const execFileAsync = promisify(execFile);

		const projDir = join(tempDir, 'cat', 'lazy-proj');
		await mkdir(projDir, { recursive: true });
		await execFileAsync('git', ['init', projDir]);

		const vibezzzDir = join(projDir, '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		await writeYaml(join(vibezzzDir, 'meta.yaml'), {
			name: 'lazy-proj',
			category: 'cat',
			origin: 'brain',
			created_at: new Date().toISOString(),
			project_stage: 'published'
		});
		await writeYaml(join(vibezzzDir, 'agents.yaml'), []);
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
			},
			publish: {
				state: 'lazy',
				subdomain: 'lazy-proj',
				url: 'https://lazy-proj.test.example.com',
				image: 'lazy:latest',
				container_name: 'vibebox-lazy-proj',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-lazy-proj'
			}
		});

		const { reconcileOnStartup } = await import('../reconcile');
		await reconcileOnStartup();

		const { getLazyRegistry, isLazyHost, stopIdleTimer } = await import('../publish');
		expect(getLazyRegistry().has('lazy-proj')).toBe(true);
		expect(isLazyHost('lazy-proj.test.example.com')).toBe(true);
		stopIdleTimer();
	});
});

describe('publish — subdomain change while published', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-publish-subdomain-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		try {
			const { stopIdleTimer } = await import('../publish');
			stopIdleTimer();
		} catch { /* module may not be loaded */ }
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('changing subdomain while lazy clears old registry entry and resets state to down', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'lazy',
				subdomain: 'old-sub',
				url: 'https://old-sub.test.example.com',
				image: 'test:latest',
				container_name: 'vibebox-old-sub',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-old-sub'
			}
		});
		await writeYaml(join(vibezzzDir, 'meta.yaml'), {
			name: 'proj', category: 'cat', origin: 'brain',
			created_at: new Date().toISOString(), project_stage: 'published'
		});

		const { applyPublishState, updatePublishSettings, getLazyRegistry, isLazyHost, stopIdleTimer } =
			await import('../publish');

		// Put it into lazy state so the registry is populated
		await applyPublishState(vibezzzDir, 'cat/proj', 'proj', 'lazy');
		expect(getLazyRegistry().has('old-sub')).toBe(true);

		// Now change subdomain while lazy
		const result = await updatePublishSettings(vibezzzDir, 'proj', {
			subdomain: 'new-sub'
		});

		// Old registry entry should be gone
		expect(getLazyRegistry().has('old-sub')).toBe(false);
		expect(isLazyHost('old-sub.test.example.com')).toBe(false);

		// State should be reset to down (needs re-publish with new subdomain)
		expect(result.publish!.state).toBe('down');
		expect(result.publish!.subdomain).toBe('new-sub');
		expect(result.publish!.container_name).toBe('vibebox-new-sub');
		expect(result.publish!.caddy_route_id).toBe('vibebox-new-sub');
		expect(result.publish!.url).toBeNull();

		stopIdleTimer();
	});

	it('changing subdomain while up resets state to down and clears container_id', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'up',
				subdomain: 'old-app',
				url: 'https://old-app.test.example.com',
				image: 'test:latest',
				container_name: 'vibebox-old-app',
				container_id: 'container-abc',
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-old-app'
			}
		});

		const { updatePublishSettings } = await import('../publish');
		const result = await updatePublishSettings(vibezzzDir, 'proj', {
			subdomain: 'new-app'
		});

		expect(result.publish!.state).toBe('down');
		expect(result.publish!.container_id).toBeNull();
		expect(result.publish!.url).toBeNull();
		expect(result.publish!.subdomain).toBe('new-app');
		expect(result.publish!.container_name).toBe('vibebox-new-app');
		expect(result.publish!.caddy_route_id).toBe('vibebox-new-app');
	});

	it('changing subdomain while down does not reset state', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'down',
				subdomain: 'old-app',
				url: null,
				image: 'test:latest',
				container_name: 'vibebox-old-app',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-old-app'
			}
		});

		const { updatePublishSettings } = await import('../publish');
		const result = await updatePublishSettings(vibezzzDir, 'proj', {
			subdomain: 'new-app'
		});

		expect(result.publish!.state).toBe('down');
		expect(result.publish!.subdomain).toBe('new-app');
	});

	it('setting same subdomain is a no-op', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'lazy',
				subdomain: 'my-app',
				url: 'https://my-app.test.example.com',
				image: 'test:latest',
				container_name: 'vibebox-my-app',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-my-app'
			}
		});

		const { updatePublishSettings } = await import('../publish');
		const result = await updatePublishSettings(vibezzzDir, 'proj', {
			subdomain: 'my-app'
		});

		// State should remain lazy — not reset
		expect(result.publish!.state).toBe('lazy');
		expect(result.publish!.subdomain).toBe('my-app');
	});
});

describe('publish — lazy reconciliation stale metadata', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-publish-lazy-recon-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		try {
			const { stopIdleTimer } = await import('../publish');
			stopIdleTimer();
		} catch { /* module may not be loaded */ }
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('reconcilePublish clears stale container_id for lazy projects', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml, readYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'lazy',
				subdomain: 'stale-lazy',
				url: 'https://stale-lazy.test.example.com',
				image: 'test:latest',
				container_name: 'vibebox-stale-lazy',
				container_id: 'stale-container-id',
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-stale-lazy'
			}
		});

		const { reconcilePublish, getLazyRegistry, stopIdleTimer } = await import('../publish');
		await reconcilePublish(vibezzzDir, 'cat/proj');

		// Container doesn't exist, so container_id should be cleared
		const deploy = await readYaml<any>(join(vibezzzDir, 'deploy.yaml'), null);
		expect(deploy.publish.container_id).toBeNull();
		// But lazy registry should still be populated
		expect(getLazyRegistry().has('stale-lazy')).toBe(true);
		stopIdleTimer();
	});

	it('reconcilePublish preserves persisted last_request_at for lazy projects', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');

		const storedTimestamp = '2025-01-15T10:30:00.000Z';
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'lazy',
				subdomain: 'timed-app',
				url: 'https://timed-app.test.example.com',
				image: 'test:latest',
				container_name: 'vibebox-timed-app',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: storedTimestamp,
				caddy_route_id: 'vibebox-timed-app'
			}
		});

		const { reconcilePublish, getLazyRegistry, stopIdleTimer } = await import('../publish');
		await reconcilePublish(vibezzzDir, 'cat/proj');

		const entry = getLazyRegistry().get('timed-app');
		expect(entry).toBeTruthy();
		// Should use persisted timestamp, not Date.now()
		expect(entry!.lastRequestAt).toBe(new Date(storedTimestamp).getTime());
		stopIdleTimer();
	});

	it('reconcilePublish uses Date.now() when no last_request_at is persisted', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'lazy',
				subdomain: 'fresh-app',
				url: 'https://fresh-app.test.example.com',
				image: 'test:latest',
				container_name: 'vibebox-fresh-app',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-fresh-app'
			}
		});

		const before = Date.now();
		const { reconcilePublish, getLazyRegistry, stopIdleTimer } = await import('../publish');
		await reconcilePublish(vibezzzDir, 'cat/proj');
		const after = Date.now();

		const entry = getLazyRegistry().get('fresh-app');
		expect(entry).toBeTruthy();
		// Should be approximately Date.now() since no persisted value
		expect(entry!.lastRequestAt).toBeGreaterThanOrEqual(before);
		expect(entry!.lastRequestAt).toBeLessThanOrEqual(after);
		stopIdleTimer();
	});
});

describe('publish — lazy wake/proxy path', () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), 'vibebox-publish-wake-'));
		setBaseEnv({ PROJECTS_DIR: tempDir });
		mockSvelteEnv();
	});

	afterEach(async () => {
		try {
			const { stopIdleTimer } = await import('../publish');
			stopIdleTimer();
		} catch { /* module may not be loaded */ }
		await rm(tempDir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('wakeAndProxy returns null for non-lazy hostname', async () => {
		const { wakeAndProxy } = await import('../publish');
		const port = await wakeAndProxy('unknown.test.example.com');
		expect(port).toBeNull();
	});

	it('wakeAndProxy returns null for hostname on wrong domain', async () => {
		const { wakeAndProxy } = await import('../publish');
		const port = await wakeAndProxy('app.other-domain.com');
		expect(port).toBeNull();
	});

	it('wakeAndProxy updates lastRequestAt on each call', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'lazy',
				subdomain: 'wake-app',
				url: 'https://wake-app.test.example.com',
				image: 'test:latest',
				container_name: 'vibebox-wake-app',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: '2025-01-01T00:00:00.000Z',
				caddy_route_id: 'vibebox-wake-app'
			}
		});

		const { reconcilePublish, getLazyRegistry, wakeAndProxy, stopIdleTimer } =
			await import('../publish');
		await reconcilePublish(vibezzzDir, 'cat/proj');

		const entryBefore = getLazyRegistry().get('wake-app');
		expect(entryBefore).toBeTruthy();
		const oldTimestamp = entryBefore!.lastRequestAt;

		// wakeAndProxy will fail to start container (no docker) but should still update timestamp
		const before = Date.now();
		await wakeAndProxy('wake-app.test.example.com');
		const after = Date.now();

		const entryAfter = getLazyRegistry().get('wake-app');
		expect(entryAfter!.lastRequestAt).toBeGreaterThanOrEqual(before);
		expect(entryAfter!.lastRequestAt).toBeLessThanOrEqual(after);
		expect(entryAfter!.lastRequestAt).toBeGreaterThan(oldTimestamp);

		stopIdleTimer();
	});

	it('isLazyHost matches after reconcilePublish populates registry', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'lazy',
				subdomain: 'lazy-host',
				url: 'https://lazy-host.test.example.com',
				image: 'test:latest',
				container_name: 'vibebox-lazy-host',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: null,
				caddy_route_id: 'vibebox-lazy-host'
			}
		});

		const { reconcilePublish, isLazyHost, wakeAndProxy, stopIdleTimer } =
			await import('../publish');

		// Before reconciliation, host should not match
		expect(isLazyHost('lazy-host.test.example.com')).toBe(false);

		await reconcilePublish(vibezzzDir, 'cat/proj');

		// After reconciliation, host should match
		expect(isLazyHost('lazy-host.test.example.com')).toBe(true);
		// Non-matching host still returns false
		expect(isLazyHost('other-host.test.example.com')).toBe(false);

		// wakeAndProxy should recognize this host (returns null because no docker)
		const port = await wakeAndProxy('lazy-host.test.example.com');
		// Container start fails (no docker), returns null
		expect(port).toBeNull();

		stopIdleTimer();
	});

	it('checkIdleContainers respects persisted lastRequestAt across restart', async () => {
		const vibezzzDir = join(tempDir, 'cat', 'proj', '.vibezzz');
		await mkdir(vibezzzDir, { recursive: true });
		const { writeYaml } = await import('../yaml');

		// Set a timestamp from 10 minutes ago (well beyond 300s idle_timeout)
		const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
		await writeYaml(join(vibezzzDir, 'deploy.yaml'), {
			preview: {
				command: '', port: 3001, healthcheck_path: '/', pid: null,
				process_started_at: null, status: 'stopped', subdomain: '',
				url: null, public: true, last_ready_at: null
			},
			publish: {
				state: 'lazy',
				subdomain: 'idle-app',
				url: 'https://idle-app.test.example.com',
				image: 'test:latest',
				container_name: 'vibebox-idle-app',
				container_id: null,
				container_port: 3001,
				idle_timeout: 300,
				last_request_at: tenMinutesAgo,
				caddy_route_id: 'vibebox-idle-app'
			}
		});

		const { reconcilePublish, getLazyRegistry, checkIdleContainers, stopIdleTimer } =
			await import('../publish');
		await reconcilePublish(vibezzzDir, 'cat/proj');

		const entry = getLazyRegistry().get('idle-app');
		expect(entry).toBeTruthy();
		// Verify the old timestamp was restored (not Date.now())
		expect(entry!.lastRequestAt).toBe(new Date(tenMinutesAgo).getTime());

		// checkIdleContainers should recognize this as idle
		// (no running container, so it will just skip — but the idle detection itself works)
		await checkIdleContainers();

		// Entry should still be in registry (container wasn't running so nothing to stop)
		expect(getLazyRegistry().has('idle-app')).toBe(true);
		stopIdleTimer();
	});
});
