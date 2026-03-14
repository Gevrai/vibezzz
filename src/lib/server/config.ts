import { env } from '$env/dynamic/private';

export interface Config {
	port: number;
	bindHost: string;
	projectsDir: string;
	vibezzzRepo: string;
	defaultProvider: 'claude' | 'copilot';
	domain: string;
	caddyAdminUrl: string;
	containerRuntime: 'docker' | 'podman';
	exposeMode: 'tunnel' | 'direct';
	lazyIdleTimeout: number;
	notifyWebhookUrl: string | null;
	notifyWebhookBearerToken: string | null;
}

function required(name: string): string {
	const value = env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function optional(name: string, fallback: string): string {
	return env[name] || fallback;
}

function optionalNullable(name: string): string | null {
	return env[name] || null;
}

function intOr(name: string, fallback: number): number {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = parseInt(raw, 10);
	if (isNaN(parsed)) {
		throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
	}
	return parsed;
}

function loadConfig(): Config {
	return {
		port: intOr('PORT', 3000),
		bindHost: optional('BIND_HOST', '0.0.0.0'),
		projectsDir: required('PROJECTS_DIR'),
		vibezzzRepo: required('VIBEZZZ_REPO'),
		defaultProvider: optional('DEFAULT_PROVIDER', 'claude') as Config['defaultProvider'],
		domain: required('DOMAIN'),
		caddyAdminUrl: optional('CADDY_ADMIN_URL', 'http://localhost:2019'),
		containerRuntime: optional('CONTAINER_RUNTIME', 'docker') as Config['containerRuntime'],
		exposeMode: optional('EXPOSE_MODE', 'tunnel') as Config['exposeMode'],
		lazyIdleTimeout: intOr('LAZY_IDLE_TIMEOUT', 300),
		notifyWebhookUrl: optionalNullable('NOTIFY_WEBHOOK_URL'),
		notifyWebhookBearerToken: optionalNullable('NOTIFY_WEBHOOK_BEARER_TOKEN')
	};
}

let _config: Config | null = null;

export function getConfig(): Config {
	if (!_config) {
		_config = loadConfig();
	}
	return _config;
}
