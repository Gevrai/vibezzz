/**
 * Agent run manager.
 *
 * Manages the lifecycle of AI agent runs: starting, stopping, log capture,
 * YAML persistence, and live streaming.  Keeps in-memory state for active
 * runs so the UI can show live status and stream logs.
 */

import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { readYaml, writeYaml } from './yaml.js';
import { getProvider, type ProviderName, type RunKind, type RunResult } from './providers.js';
import { getConfig } from './config.js';
import { notify } from './notifications.js';

// ── Types ────────────────────────────────────────────────────────────

export interface AgentRunEntry {
	id: number;
	provider: ProviderName;
	kind: RunKind;
	summary: string;
	started_at: string;
	finished_at: string | null;
	status: 'running' | 'done' | 'failed' | 'stopped';
	pid: number | null;
	process_started_at: string | null;
	cwd: string;
	idea_id: number | null;
	log_path: string;
	exit_code: number | null;
	branch: string;
	commit_sha: string | null;
	result: RunResult | null;
	preview_url: string | null;
}

export interface ActiveRun {
	entry: AgentRunEntry;
	projectPath: string;
	stop: () => Promise<void>;
	/** Resolves when the run process exits. */
	done: Promise<void>;
}

export interface StartRunOptions {
	projectPath: string;
	projectAbsPath: string;
	vibezzzDir: string;
	provider?: ProviderName;
	kind?: RunKind;
	prompt: string;
	ideaId?: number | null;
}

// ── In-memory active-run tracking ────────────────────────────────────

const activeRuns = new Map<string, ActiveRun>();

/** Key for active runs: "<projectPath>". Only one run per project at a time. */
function runKey(projectPath: string): string {
	return projectPath;
}

export function getActiveRun(projectPath: string): ActiveRun | undefined {
	return activeRuns.get(runKey(projectPath));
}

export function getAllActiveRuns(): ActiveRun[] {
	return [...activeRuns.values()];
}

// ── YAML persistence ─────────────────────────────────────────────────

async function readAgentsYaml(vibezzzDir: string): Promise<AgentRunEntry[]> {
	return readYaml<AgentRunEntry[]>(join(vibezzzDir, 'agents.yaml'), []);
}

async function writeAgentsYaml(vibezzzDir: string, entries: AgentRunEntry[]): Promise<void> {
	await writeYaml(join(vibezzzDir, 'agents.yaml'), entries);
}

function nextId(entries: AgentRunEntry[]): number {
	if (entries.length === 0) return 1;
	return Math.max(...entries.map((e) => e.id)) + 1;
}

// ── Log file management ──────────────────────────────────────────────

async function ensureLogsDir(vibezzzDir: string): Promise<string> {
	const logsDir = join(vibezzzDir, 'logs');
	await mkdir(logsDir, { recursive: true });
	return logsDir;
}

/**
 * Pipe a ReadableStream to a file while also broadcasting lines to
 * any live subscribers. Returns a promise that resolves when the
 * stream ends.
 */
async function pipeStreamToFile(
	stream: ReadableStream<Uint8Array>,
	filePath: string,
	subscribers: Set<(chunk: string) => void>
): Promise<void> {
	const writer = createWriteStream(filePath, { flags: 'a' });
	const reader = stream.getReader();
	const decoder = new TextDecoder();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			writer.write(Buffer.from(value));
			const text = decoder.decode(value, { stream: true });
			for (const sub of subscribers) {
				try {
					sub(text);
				} catch {
					/* subscriber disconnected */
				}
			}
		}
	} finally {
		reader.releaseLock();
		await new Promise<void>((resolve) => writer.end(resolve));
	}
}

// ── Log streaming for live UI ────────────────────────────────────────

/** Per-run subscriber sets for live log streaming. */
const logSubscribers = new Map<string, Set<(chunk: string) => void>>();

function getOrCreateSubs(key: string): Set<(chunk: string) => void> {
	let subs = logSubscribers.get(key);
	if (!subs) {
		subs = new Set();
		logSubscribers.set(key, subs);
	}
	return subs;
}

/**
 * Subscribe to live log output for an active run.
 * Returns an unsubscribe function.
 */
export function subscribeLogs(
	projectPath: string,
	callback: (chunk: string) => void
): () => void {
	const key = runKey(projectPath);
	const subs = getOrCreateSubs(key);
	subs.add(callback);
	return () => {
		subs.delete(callback);
		if (subs.size === 0) logSubscribers.delete(key);
	};
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start a new agent run for a project.
 */
export async function startRun(opts: StartRunOptions): Promise<AgentRunEntry> {
	const key = runKey(opts.projectPath);

	// Only one run per project at a time
	if (activeRuns.has(key)) {
		throw new Error('A run is already active for this project');
	}

	const config = getConfig();
	const providerName = opts.provider ?? config.defaultProvider;
	const provider = getProvider(providerName);

	const entries = await readAgentsYaml(opts.vibezzzDir);
	const id = nextId(entries);

	const logsDir = await ensureLogsDir(opts.vibezzzDir);
	const logPath = join('.vibezzz', 'logs', `${id}.log`);
	const absLogPath = join(opts.projectAbsPath, logPath);

	// Start the provider process
	const handle = await provider.startRun({
		prompt: opts.prompt,
		cwd: opts.projectAbsPath,
		kind: opts.kind ?? 'implement'
	});

	const entry: AgentRunEntry = {
		id,
		provider: providerName,
		kind: opts.kind ?? 'implement',
		summary: opts.prompt.slice(0, 200),
		started_at: handle.startedAt,
		finished_at: null,
		status: 'running',
		pid: handle.pid,
		process_started_at: handle.startedAt,
		cwd: opts.projectAbsPath,
		idea_id: opts.ideaId ?? null,
		log_path: logPath,
		exit_code: null,
		branch: handle.branch,
		commit_sha: null,
		result: null,
		preview_url: null
	};

	// Persist the running entry
	entries.push(entry);
	await writeAgentsYaml(opts.vibezzzDir, entries);

	// Set up log streaming
	const subs = getOrCreateSubs(key);

	// Pipe both stdout and stderr to the log file
	const stdoutDone = pipeStreamToFile(handle.stdout, absLogPath, subs);
	const stderrDone = pipeStreamToFile(handle.stderr, absLogPath, subs);

	// Mutable flag for stop coordination — set before the completion handler
	// can check it, referenced by both stopRun and the done closure.
	let wasStopped = false;

	// Create a completion promise
	const done = (async () => {
		try {
			const result = await handle.wait();

			// Wait for streams to flush
			await Promise.allSettled([stdoutDone, stderrDone]);

			// If the run was explicitly stopped, don't overwrite the stopped status
			if (wasStopped) return;

			// Update YAML entry
			const currentEntries = await readAgentsYaml(opts.vibezzzDir);
			const idx = currentEntries.findIndex((e) => e.id === id);
			if (idx !== -1) {
				currentEntries[idx].status = result.exitCode === 0 ? 'done' : 'failed';
				currentEntries[idx].finished_at = result.finishedAt;
				currentEntries[idx].exit_code = result.exitCode;
				currentEntries[idx].result = result.result;
				currentEntries[idx].commit_sha = result.commitSha;
				await writeAgentsYaml(opts.vibezzzDir, currentEntries);
			}

			// Update local entry
			entry.status = result.exitCode === 0 ? 'done' : 'failed';
			entry.finished_at = result.finishedAt;
			entry.exit_code = result.exitCode;
			entry.result = result.result;
			entry.commit_sha = result.commitSha;

			// Handle automation: auto-preview and notifications
			const deployYaml = await readYaml<{ automation?: { auto_start_preview?: boolean; auto_notify_on_ready?: boolean } } | null>(
				join(opts.vibezzzDir, 'deploy.yaml'),
				null
			);
			const automation = deployYaml?.automation;

			// Spec: run completes with ready_for_test + auto_start_preview
			// → start preview (preview.ts handles auto_notify_on_ready)
			if (result.result === 'ready_for_test' && automation?.auto_start_preview) {
				try {
					const { startPreview } = await import('./preview.js');
					await startPreview(opts.projectPath, opts.projectAbsPath, opts.vibezzzDir);
				} catch (err) {
					console.warn(
						`[agents] auto_start_preview failed for ${opts.projectPath}: ${(err as Error).message}`
					);
				}
			}

			// Spec: only notify on failure for automation/bootstrap runs
			const isAutomated = opts.kind === 'bootstrap';
			if (result.result === 'failed' && isAutomated) {
				await notify(
					'run_failed',
					opts.projectPath,
					`Agent run failed for ${opts.projectPath} (exit code ${result.exitCode})`
				);
			}
		} finally {
			activeRuns.delete(key);
			logSubscribers.delete(key);
		}
	})();

	const activeRun: ActiveRun = {
		entry,
		projectPath: opts.projectPath,
		stop: async () => {
			wasStopped = true;
			await handle.stop();
		},
		done
	};

	activeRuns.set(key, activeRun);

	return entry;
}

/**
 * Stop an active run for a project.
 */
export async function stopRun(
	projectPath: string,
	vibezzzDir: string
): Promise<AgentRunEntry | null> {
	const key = runKey(projectPath);
	const active = activeRuns.get(key);
	if (!active) return null;

	// active.stop() sets the wasStopped flag internally so the completion
	// handler won't overwrite the status back to 'failed'.
	await active.stop();

	// Persist the stopped status in YAML
	const entries = await readAgentsYaml(vibezzzDir);
	const idx = entries.findIndex((e) => e.id === active.entry.id);
	if (idx !== -1) {
		entries[idx].status = 'stopped';
		entries[idx].finished_at = new Date().toISOString();
		await writeAgentsYaml(vibezzzDir, entries);
		return entries[idx];
	}

	return active.entry;
}

/**
 * Get run history for a project.
 */
export async function getRunHistory(vibezzzDir: string): Promise<AgentRunEntry[]> {
	return readAgentsYaml(vibezzzDir);
}

/**
 * Read the full log file for a completed run.
 */
export async function readRunLog(projectAbsPath: string, logPath: string): Promise<string> {
	const absPath = join(projectAbsPath, logPath);
	try {
		return await readFile(absPath, 'utf-8');
	} catch {
		return '';
	}
}

/**
 * Rehydrate a surviving active run into the in-memory map after restart.
 * We don't have a ChildProcess handle, so we provide PID-based stop and
 * poll-based completion tracking.
 */
export function rehydrateRun(
	projectPath: string,
	entry: AgentRunEntry,
	vibezzzDir: string
): void {
	const key = runKey(projectPath);
	if (activeRuns.has(key)) return;

	const pid = entry.pid;

	let doneResolve: () => void;
	const done = new Promise<void>((resolve) => {
		doneResolve = resolve;
	});

	// Poll for process exit every 5 seconds
	const pollInterval = setInterval(async () => {
		let alive = false;
		if (pid) {
			try {
				process.kill(pid, 0);
				alive = true;
			} catch {
				alive = false;
			}
		}
		if (!alive) {
			clearInterval(pollInterval);

			// Update YAML entry
			const entries = await readAgentsYaml(vibezzzDir);
			const idx = entries.findIndex((e) => e.id === entry.id);
			if (idx !== -1 && entries[idx].status === 'running') {
				entries[idx].status = 'failed';
				entries[idx].finished_at = new Date().toISOString();
				entries[idx].result = 'failed';
				await writeAgentsYaml(vibezzzDir, entries);
			}

			activeRuns.delete(key);
			logSubscribers.delete(key);
			doneResolve();
		}
	}, 5_000);

	// Tail the log file for live streaming
	const absLogPath = join(entry.cwd, entry.log_path);
	const subs = getOrCreateSubs(key);

	let lastSize = 0;
	const tailInterval = setInterval(async () => {
		try {
			const { stat } = await import('node:fs/promises');
			const st = await stat(absLogPath);
			if (st.size > lastSize) {
				const { createReadStream } = await import('node:fs');
				const stream = createReadStream(absLogPath, {
					start: lastSize,
					encoding: 'utf-8'
				});
				let chunk = '';
				for await (const data of stream) {
					chunk += data;
				}
				if (chunk) {
					for (const sub of subs) {
						try {
							sub(chunk);
						} catch { /* subscriber disconnected */ }
					}
				}
				lastSize = st.size;
			}
		} catch { /* log file not available yet */ }
	}, 1_000);

	const activeRun: ActiveRun = {
		entry,
		projectPath,
		stop: async () => {
			clearInterval(pollInterval);
			clearInterval(tailInterval);
			if (pid) {
				try {
					process.kill(pid, 'SIGTERM');
				} catch { /* already dead */ }
			}
		},
		done
	};

	activeRuns.set(key, activeRun);
}
