import { join, resolve } from 'node:path';
import { readdir, stat, lstat, access, realpath, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readYaml, writeYaml } from './yaml';
import { getConfig } from './config';
import { claimIdeaForPromotion, unclaimIdea } from './ideas';

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

/** Returns true only for real directories (not symlinks to directories). */
async function isRealDirectory(path: string): Promise<boolean> {
	try {
		const s = await lstat(path);
		return s.isDirectory() && !s.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Resolve symlinks and verify the real path stays inside the projects root.
 * Falls back to lexical `resolve()` when the path doesn't exist yet (e.g.
 * during promotion before `git init` creates the directory).
 *
 * Returns the resolved target path so callers can use it for subsequent I/O,
 * closing the TOCTOU window between validation and use.
 */
async function assertInsideProjectsDir(targetPath: string, projectsDir: string): Promise<string> {
	let resolvedTarget: string;
	let resolvedRoot: string;
	try {
		// Resolve symlinks for the deepest existing ancestor
		resolvedTarget = await realpath(targetPath);
	} catch {
		// Path doesn't exist yet — resolve its parent to catch symlinked parents
		const parent = resolve(targetPath, '..');
		try {
			const realParent = await realpath(parent);
			resolvedTarget = join(realParent, targetPath.split('/').pop()!);
		} catch {
			// Neither target nor parent exist; fall back to lexical resolve
			resolvedTarget = resolve(targetPath);
		}
	}
	try {
		resolvedRoot = await realpath(projectsDir);
	} catch {
		resolvedRoot = resolve(projectsDir);
	}
	if (!resolvedTarget.startsWith(resolvedRoot + '/')) {
		throw new Error('Invalid project path');
	}
	return resolvedTarget;
}

/**
 * Resolve the real path of an existing directory and verify it stays inside
 * the projects root. Unlike assertInsideProjectsDir, this requires the path
 * to exist and be a real directory (not a symlink).
 */
async function resolveAndVerifyDir(dir: string, projectsDir: string): Promise<string> {
	const s = await lstat(dir);
	if (!s.isDirectory() || s.isSymbolicLink()) {
		throw new Error('Invalid project path');
	}
	const resolved = await realpath(dir);
	let resolvedRoot: string;
	try {
		resolvedRoot = await realpath(projectsDir);
	} catch {
		resolvedRoot = resolve(projectsDir);
	}
	if (!resolved.startsWith(resolvedRoot + '/') && resolved !== resolvedRoot) {
		throw new Error('Invalid project path');
	}
	return resolved;
}

/**
 * Verify that the .vibezzz subdirectory inside a verified project path is a
 * real directory (not a symlink) whose resolved path stays inside the project.
 * Returns the verified real path, or null if .vibezzz doesn't exist.
 */
export async function verifyVibezzzDir(projectRealPath: string): Promise<string | null> {
	const vibezzzDir = join(projectRealPath, '.vibezzz');
	let s;
	try {
		s = await lstat(vibezzzDir);
	} catch {
		return null;
	}
	if (!s.isDirectory() || s.isSymbolicLink()) {
		return null;
	}
	const resolved = await realpath(vibezzzDir);
	if (!resolved.startsWith(projectRealPath + '/')) {
		return null;
	}
	return resolved;
}

/**
 * Ensure the .vibezzz subdirectory exists inside a verified project path.
 * Creates it if missing, then verifies it is a real directory contained within
 * the project. Throws on symlink hops or containment violations.
 */
async function ensureVibezzzDir(projectRealPath: string): Promise<string> {
	const vibezzzDir = join(projectRealPath, '.vibezzz');
	await mkdir(vibezzzDir, { recursive: true });
	const s = await lstat(vibezzzDir);
	if (!s.isDirectory() || s.isSymbolicLink()) {
		throw new Error('Invalid .vibezzz directory');
	}
	const resolved = await realpath(vibezzzDir);
	if (!resolved.startsWith(projectRealPath + '/')) {
		throw new Error('.vibezzz directory escapes project boundary');
	}
	return resolved;
}

const DEFAULT_SIGNALS: ProjectSignals = {
	preview_status: 'stopped',
	preview_url: null,
	publish_state: 'down',
	publish_url: null,
	agent_active: false,
	last_agent_status: null
};

async function readSignals(vibezzzDir: string): Promise<ProjectSignals> {
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

	let resolvedProjectsDir: string;
	try {
		resolvedProjectsDir = await realpath(projectsDir);
	} catch {
		return [];
	}

	let categories: string[];
	try {
		categories = await readdir(resolvedProjectsDir);
	} catch {
		return [];
	}

	for (const category of categories) {
		if (!isValidPathSegment(category)) continue;
		const categoryPath = join(resolvedProjectsDir, category);

		// Re-resolve and verify the category is still a real directory inside
		// the projects root to close the TOCTOU gap between the readdir above
		// and the readdir of its children below.
		let realCategoryPath: string;
		try {
			realCategoryPath = await resolveAndVerifyDir(categoryPath, resolvedProjectsDir);
		} catch {
			continue;
		}

		let entries: string[];
		try {
			entries = await readdir(realCategoryPath);
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!isValidPathSegment(entry)) continue;
			const projectPath = join(realCategoryPath, entry);

			// Re-resolve the project directory at point of use
			let realProjectPath: string;
			try {
				realProjectPath = await resolveAndVerifyDir(projectPath, resolvedProjectsDir);
			} catch {
				continue;
			}

			if (!await isGitRepo(realProjectPath)) continue;

			// Skip the vibezzz repo itself
			if (realProjectPath === vibezzzRepo) continue;

			const realVibezzzDir = await verifyVibezzzDir(realProjectPath);
			let meta: ProjectMeta | null = null;
			let signals: ProjectSignals;
			if (realVibezzzDir) {
				meta = await readYaml<ProjectMeta | null>(join(realVibezzzDir, 'meta.yaml'), null);
				signals = await readSignals(realVibezzzDir);
			} else {
				signals = { ...DEFAULT_SIGNALS };
			}

			const relPath = join(category, entry);
			if (meta) {
				projects.push({
					path: relPath,
					meta,
					signals
				});
			} else {
				// External project without vibebox metadata
				projects.push({
					path: relPath,
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

	let resolvedProjectsDir: string;
	try {
		resolvedProjectsDir = await realpath(projectsDir);
	} catch {
		resolvedProjectsDir = resolve(projectsDir);
	}

	for (const project of projects) {
		// Re-resolve the project path at point of use to avoid writing to a
		// path that was swapped for a symlink after scanProjects returned.
		const absPath = join(resolvedProjectsDir, project.path);
		let realAbsPath: string;
		try {
			realAbsPath = await resolveAndVerifyDir(absPath, resolvedProjectsDir);
		} catch {
			continue;
		}

		let realVibezzzDir: string;
		try {
			realVibezzzDir = await ensureVibezzzDir(realAbsPath);
		} catch {
			continue;
		}
		const metaPath = join(realVibezzzDir, 'meta.yaml');
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

// Per-destination lock to prevent concurrent promotions to the same path.
const _promoteLocks = new Map<string, Promise<void>>();

function withPromoteLock<T>(destPath: string, fn: () => Promise<T>): Promise<T> {
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const prev = _promoteLocks.get(destPath) ?? Promise.resolve();
	_promoteLocks.set(destPath, gate);
	return prev.then(async () => {
		try {
			return await fn();
		} finally {
			if (_promoteLocks.get(destPath) === gate) {
				_promoteLocks.delete(destPath);
			}
			release();
		}
	});
}

export async function promoteIdeaToProject(opts: PromoteOptions): Promise<ScannedProject> {
	const { projectsDir } = getConfig();

	// Defence-in-depth: reject unsafe path segments even if the caller forgot
	if (!isValidPathSegment(opts.category) || !isValidPathSegment(opts.name)) {
		throw new Error('Invalid project name or category');
	}

	const projectDir = join(projectsDir, opts.category, opts.name);

	// Initial containment check (symlink-safe)
	await assertInsideProjectsDir(projectDir, projectsDir);

	const relPath = join(opts.category, opts.name);

	// Serialize concurrent promotions targeting the same destination path
	return withPromoteLock(relPath, async () => {
		// Check if directory already exists
		if (await isDirectory(projectDir)) {
			throw new Error(`Project directory already exists: ${relPath}`);
		}

		// Atomically claim the idea — prevents concurrent promotes from
		// double-promoting the same idea into different projects.
		await claimIdeaForPromotion(opts.ideaId, relPath);

		// Bootstrap the project directory. If any step fails, roll back the
		// idea claim so it returns to 'raw' and isn't stranded as 'promoted'.
		let realProjectDir: string | undefined;
		let weCreatedProjectDir = false;
		try {
			// Create (or verify) the category directory, then re-resolve its
			// real path immediately before creating the project subdirectory.
			// This closes the TOCTOU window: we verify the parent is still a
			// real directory inside PROJECTS_DIR right before mkdir.
			const categoryDir = join(projectsDir, opts.category);
			await mkdir(categoryDir, { recursive: true });
			const realCategoryDir = await resolveAndVerifyDir(categoryDir, projectsDir);

			// Build all subsequent paths from the verified real parent
			realProjectDir = join(realCategoryDir, opts.name);
			await mkdir(realProjectDir); // atomic: throws EEXIST on race
			weCreatedProjectDir = true;

			const realVibezzzDir = await ensureVibezzzDir(realProjectDir);

			// Initialize git inside the already-created directory
			try {
				await execFileAsync('git', ['init', realProjectDir]);
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
			await writeYaml(join(realVibezzzDir, 'meta.yaml'), meta);

			// Create empty ideas.yaml
			await writeYaml(join(realVibezzzDir, 'ideas.yaml'), []);

			// Create empty agents.yaml
			await writeYaml(join(realVibezzzDir, 'agents.yaml'), []);

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
			await writeYaml(join(realVibezzzDir, 'deploy.yaml'), deploy);

			return { path: relPath, meta, signals: { ...DEFAULT_SIGNALS, preview_status: 'stopped', publish_state: 'down' } };
		} catch (bootstrapErr) {
			// Roll back: return idea to 'raw' and remove any partially created directory
			await unclaimIdea(opts.ideaId).catch(() => {});
			if (weCreatedProjectDir && realProjectDir) {
				await rm(realProjectDir, { recursive: true, force: true }).catch(() => {});
			}
			throw bootstrapErr;
		}
	});
}
