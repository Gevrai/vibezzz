import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config', () => {
	const originalEnv = { ...process.env };

	function setEnv(overrides: Record<string, string>) {
		// Set minimum required env vars
		const defaults: Record<string, string> = {
			PROJECTS_DIR: '/home/test/projects',
			VIBEZZZ_REPO: '/home/test/projects/vibezzz',
			DOMAIN: 'test.example.com'
		};
		Object.assign(process.env, defaults, overrides);
	}

	beforeEach(() => {
		// Reset module cache so config is re-evaluated
		vi.resetModules();
	});

	afterEach(() => {
		// Restore original env
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
	});

	it('loads required values from env', async () => {
		setEnv({});

		// Mock SvelteKit's $env/dynamic/private
		vi.doMock('$env/dynamic/private', () => ({
			env: process.env
		}));

		const { getConfig } = await import('../config.js');
		const config = getConfig();

		expect(config.projectsDir).toBe('/home/test/projects');
		expect(config.vibezzzRepo).toBe('/home/test/projects/vibezzz');
		expect(config.domain).toBe('test.example.com');
	});

	it('applies defaults for optional values', async () => {
		setEnv({});

		vi.doMock('$env/dynamic/private', () => ({
			env: process.env
		}));

		const { getConfig } = await import('../config.js');
		const config = getConfig();

		expect(config.port).toBe(3000);
		expect(config.bindHost).toBe('0.0.0.0');
		expect(config.defaultProvider).toBe('claude');
		expect(config.caddyAdminUrl).toBe('http://localhost:2019');
		expect(config.containerRuntime).toBe('docker');
		expect(config.exposeMode).toBe('tunnel');
		expect(config.lazyIdleTimeout).toBe(300);
		expect(config.notifyWebhookUrl).toBeNull();
		expect(config.notifyWebhookBearerToken).toBeNull();
	});

	it('throws for missing required env vars', async () => {
		vi.doMock('$env/dynamic/private', () => ({
			env: {}
		}));

		const { getConfig } = await import('../config.js');
		expect(() => getConfig()).toThrow('Missing required environment variable: PROJECTS_DIR');
	});

	it('parses integer values', async () => {
		setEnv({ PORT: '8080', LAZY_IDLE_TIMEOUT: '600' });

		vi.doMock('$env/dynamic/private', () => ({
			env: process.env
		}));

		const { getConfig } = await import('../config.js');
		const config = getConfig();

		expect(config.port).toBe(8080);
		expect(config.lazyIdleTimeout).toBe(600);
	});

	it('throws for invalid integer values', async () => {
		setEnv({ PORT: 'abc' });

		vi.doMock('$env/dynamic/private', () => ({
			env: process.env
		}));

		const { getConfig } = await import('../config.js');
		expect(() => getConfig()).toThrow('Environment variable PORT must be an integer');
	});

	it('reads webhook config when set', async () => {
		setEnv({
			NOTIFY_WEBHOOK_URL: 'https://ntfy.example.com/vibebox',
			NOTIFY_WEBHOOK_BEARER_TOKEN: 'secret123'
		});

		vi.doMock('$env/dynamic/private', () => ({
			env: process.env
		}));

		const { getConfig } = await import('../config.js');
		const config = getConfig();

		expect(config.notifyWebhookUrl).toBe('https://ntfy.example.com/vibebox');
		expect(config.notifyWebhookBearerToken).toBe('secret123');
	});
});
