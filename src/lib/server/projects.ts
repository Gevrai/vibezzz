import { join, relative, resolve } from 'node:path';
import { readdir, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readYaml, writeYaml } from './yaml';
import { getConfig } from './config';
import { updateIdea, getIdea } from './ideas';

const execFileAsync = promisify(execFile);

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Returns true when `segment` is a safe single directory name (no traversal). */
export function isValidPathSegment(segment: string): boolean {
	if (!segment || segment === '.' || segment === '..') return false;
	return SAFE_SEGMENT_RE.test(segment);
}

export interface ProjectMeta {
	name: string;
	category: string;
	origin: 'brain' | 'external';
	created_at: string;
	idea_id: number | null;
	template: string | null;
	project_stage:
		| 'bootstrapping'
		| 'building'
		| 'preview_ready'
		| 'published'
		| 'paused';
	last_ready_at: string | null;
}

export interface DeployPreview {
	status: string;
	url: string | null;
}

export interface DeployPublish {
	state: string;
	url: string | null;
}

export interface AgentEntry {
	id?: string;
	status?: string;
	started_at?: string;
	finished_at?: string | null;
}

export interface ProjectSignals {
	preview_status: string | null;
	preview_url: string | null;
	publish_state: string | null;
	publish_url: string | null;
	agent_active: boolean;
	last_agent_status: string | null;
}

export interface ScannedProject {
	path: string;
	meta: ProjectMeta;
	signals: ProjectSignals;
}

async function isGitRepo(dir: string): Promise<boolean> {
	try {
		await access(join(dir, '.git'));
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

const DEFAULT_SIGNALS: ProjectSignals = {
	preview_status: 'stopped',
	preview_url: null,
	publish_state: 'down',
	publish_url: null,
	agent_active: false,
	last_agent_status: null
};

async function readSignals(projectAbsPath: string): Promise<ProjectSignals> {
	const vibezzzDir = join(projectAbsPath, '.vibezzz');
	const signals: ProjectSignals = { ...DEFAULT_SIGNALS };

	// Read deploy.yaml for preview/publish status
	const deploy = await readYaml<{ preview?: DeployPreview; publish?: DeployPublish } | null>(
		join(vibezzzDir, 'deploy.yaml'),
		null
	);
	if (deploy) {
		if (deploy.preview) {
			signals.preview_status = deploy.preview.status ?? 'stopped';
			signals.preview_url = deploy.preview.url ?? null;
		}
		if (deploy.publish) {
			signals.publish_state = deploy.publish.state ?? 'down';
			signals.publish_url = deploy.publish.url ?? null;
		}
	}

	// Read agents.yaml for agent activity
	const agents = await readYaml<AgentEntry[]>(join(vibezzzDir, 'agents.yaml'), []);
	if (agents.length > 0) {
		const last = agents[agents.length - 1];
		signals.last_agent_status = last.status ?? null;
		signals.agent_active = last.status === 'running';
	}

	return signals;
}

export async function scanProjects(): Promise<ScannedProject[]> {
	const { projectsDir, vibezzzRepo } = getConfig();
	const projects: ScannedProject[] = [];

	let categories: string[];
	try {
		categories = await readdir(projectsDir);
	} catch {
		return [];
	}

	for (const category of categories) {
		const categoryPath = join(projectsDir, category);
		if (!await isDirectory(categoryPath)) continue;

		let entries: string[];
		try {
			entries = await readdir(categoryPath);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const projectPath = join(categoryPath, entry);
			if (!await isDirectory(projectPath)) continue;
			if (!await isGitRepo(projectPath)) continue;

			// Skip the vibezzz repo itself
			if (projectPath === vibezzzRepo) continue;

			const metaPath = join(projectPath, '.vibezzz', 'meta.yaml');
			const meta = await readYaml<ProjectMeta | null>(metaPath, null);
			const signals = await readSignals(projectPath);

			if (meta) {
				projects.push({
					path: relative(projectsDir, projectPath),
					meta,
					signals
				});
			} else {
				// External project without vibebox metadata
				projects.push({
					path: relative(projectsDir, projectPath),
					meta: {
						name: entry,
						category,
						origin: 'external',
						created_at: new Date().toISOString(),
						idea_id: null,
						template: null,
						project_stage: 'paused',
						last_ready_at: null
					},
					signals
				});
			}
		}
	}

	return projects;
}

export async function resyncProjects(): Promise<ScannedProject[]> {
	const { projectsDir } = getConfig();
	const projects = await scanProjects();

	for (const project of projects) {
		const absPath = join(projectsDir, project.path);
		const metaPath = join(absPath, '.vibezzz', 'meta.yaml');
		const existing = await readYaml<ProjectMeta | null>(metaPath, null);

		if (!existing) {
			await writeYaml(metaPath, project.meta);
		}
	}

	return projects;
}

export interface PromoteOptions {
	ideaId: number;
	name: string;
	category: string;
	template?: string;
}

export async function promoteIdeaToProject(opts: PromoteOptions): Promise<ScannedProject> {
	const { projectsDir } = getConfig();

	// Defence-in-depth: reject unsafe path segments even if the caller forgot
	if (!isValidPathSegment(opts.category) || !isValidPathSegment(opts.name)) {
		throw new Error('Invalid project name or category');
	}

	const projectDir = join(projectsDir, opts.category, opts.name);

	// Ensure the resolved path stays inside PROJECTS_DIR
	const resolved = resolve(projectDir);
	if (!resolved.startsWith(resolve(projectsDir) + '/')) {
		throw new Error('Invalid project path');
	}

	const idea = await getIdea(opts.ideaId);

	if (!idea) {
		throw new Error(`Idea #${opts.ideaId} not found`);
	}
	if (idea.status !== 'raw') {
		throw new Error(`Idea #${opts.ideaId} is already ${idea.status}`);
	}

	const vibezzzDir = join(projectDir, '.vibezzz');
	const relPath = join(opts.category, opts.name);

	// Check if directory already exists
	if (await isDirectory(projectDir)) {
		throw new Error(`Project directory already exists: ${relPath}`);
	}

	// Initialize git
	try {
		await execFileAsync('git', ['init', projectDir]);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'git init failed';
		throw new Error(`git init failed: ${message}`);
	}

	// Create meta.yaml
	const meta: ProjectMeta = {
		name: opts.name,
		category: opts.category,
		origin: 'brain',
		created_at: new Date().toISOString(),
		idea_id: opts.ideaId,
		template: opts.template || null,
		project_stage: 'bootstrapping',
		last_ready_at: null
	};
	await writeYaml(join(vibezzzDir, 'meta.yaml'), meta);

	// Create empty ideas.yaml
	await writeYaml(join(vibezzzDir, 'ideas.yaml'), []);

	// Create empty agents.yaml
	await writeYaml(join(vibezzzDir, 'agents.yaml'), []);

	// Create starter deploy.yaml
	const deploy = {
		preview: {
			command: '',
			port: 3001,
			healthcheck_path: '/',
			pid: null,
			process_started_at: null,
			status: 'stopped',
			subdomain: `${opts.name}-preview`,
			url: null,
			public: true,
			last_ready_at: null
		},
		publish: {
			state: 'down',
			subdomain: opts.name,
			url: null,
			image: null,
			container_name: `vibebox-${opts.name}`,
			container_id: null,
			container_port: 3001,
			idle_timeout: 300,
			last_request_at: null,
			caddy_route_id: `vibebox-${opts.name}`
		},
		automation: {
			auto_start_agent: true,
			auto_start_preview: true,
			auto_notify_on_ready: true,
			auto_publish: false
		}
	};
	await writeYaml(join(vibezzzDir, 'deploy.yaml'), deploy);

	// Update the global idea to promoted
	await updateIdea(opts.ideaId, {
		status: 'promoted',
		project_path: relPath
	});

	return { path: relPath, meta, signals: { ...DEFAULT_SIGNALS, preview_status: 'stopped', publish_state: 'down' } };
}
