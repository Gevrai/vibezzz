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
