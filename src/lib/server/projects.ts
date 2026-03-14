import { join, relative } from 'node:path';
import { readdir, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readYaml, writeYaml } from './yaml';
import { getConfig } from './config';
import { updateIdea, getIdea } from './ideas';

const execFileAsync = promisify(execFile);

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

export interface ScannedProject {
	path: string;
	meta: ProjectMeta;
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

			if (meta) {
				projects.push({
					path: relative(projectsDir, projectPath),
					meta
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
					}
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
	const idea = await getIdea(opts.ideaId);

	if (!idea) {
		throw new Error(`Idea #${opts.ideaId} not found`);
	}
	if (idea.status !== 'raw') {
		throw new Error(`Idea #${opts.ideaId} is already ${idea.status}`);
	}

	const projectDir = join(projectsDir, opts.category, opts.name);
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
			command: null,
			port: null,
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

	return { path: relPath, meta };
}
