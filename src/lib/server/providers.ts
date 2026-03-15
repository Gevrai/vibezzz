/**
 * AI Provider abstraction for agent runs.
 *
 * Each provider wraps a CLI tool (claude, copilot) and spawns it as a
 * long-running subprocess in the project working directory.  The host
 * machine is expected to have the CLIs pre-authenticated — vibebox
 * never stores API keys.
 *
 * Providers use agent-capable CLI modes (not one-shot print modes) so
 * the AI can make file changes, run commands, and iterate autonomously.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Readable } from 'node:stream';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────

export type RunKind = 'bootstrap' | 'implement' | 'refine' | 'custom';
export type RunResult = 'ready_for_test' | 'building' | 'blocked' | 'failed';
export type ProviderName = 'claude' | 'copilot';

export interface AgentRunHandle {
	pid: number;
	startedAt: string;
	branch: string;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	stop(): Promise<void>;
	wait(): Promise<{
		exitCode: number;
		finishedAt: string;
		commitSha: string | null;
		result: RunResult;
	}>;
}

export interface StartRunInput {
	prompt: string;
	cwd: string;
	kind: RunKind;
}

export interface AIProvider {
	name: ProviderName;
	startRun(input: StartRunInput): Promise<AgentRunHandle>;
}

// ── Helpers ──────────────────────────────────────────────────────────

function nowISO(): string {
	return new Date().toISOString();
}

/** Determine a high-level result from a process exit code. */
function resultFromExit(exitCode: number): RunResult {
	return exitCode === 0 ? 'ready_for_test' : 'failed';
}

/** Read the current git branch in a project directory. */
export async function gitBranch(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
		return stdout.trim() || 'main';
	} catch {
		return 'main';
	}
}

/** Read the latest commit SHA in a project directory. */
export async function gitCommitSha(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
		const sha = stdout.trim();
		return sha || null;
	} catch {
		return null;
	}
}

/** Convert a Node.js Readable stream to a Web ReadableStream. */
function toWebStream(nodeStream: Readable | null): ReadableStream<Uint8Array> {
	if (!nodeStream) {
		return new ReadableStream({ start(c) { c.close(); } });
	}
	return new ReadableStream({
		start(controller) {
			nodeStream.on('data', (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk));
			});
			nodeStream.on('end', () => {
				try { controller.close(); } catch { /* already closed */ }
			});
			nodeStream.on('error', (err: Error) => {
				try { controller.error(err); } catch { /* already closed */ }
			});
		},
		cancel() {
			nodeStream.destroy();
		}
	});
}

/** Create an AgentRunHandle from a Node.js ChildProcess. */
function handleFromProcess(proc: ChildProcess, branch: string, cwd: string): AgentRunHandle {
	const startedAt = nowISO();
	const pid = proc.pid ?? 0;

	const exitPromise = new Promise<number>((resolve) => {
		proc.on('exit', (code) => resolve(code ?? 1));
		proc.on('error', () => resolve(1));
	});

	return {
		pid,
		startedAt,
		branch,

		stdout: toWebStream(proc.stdout),
		stderr: toWebStream(proc.stderr),

		async stop() {
			try {
				proc.kill('SIGTERM');
				const timer = setTimeout(() => {
					try { proc.kill('SIGKILL'); } catch { /* already gone */ }
				}, 5_000);
				await exitPromise;
				clearTimeout(timer);
			} catch {
				/* process already exited */
			}
		},

		async wait() {
			const exitCode = await exitPromise;
			const commitSha = await gitCommitSha(cwd);
			return {
				exitCode,
				finishedAt: nowISO(),
				commitSha,
				result: resultFromExit(exitCode)
			};
		}
	};
}

// ── Claude CLI Provider ──────────────────────────────────────────────

export class ClaudeProvider implements AIProvider {
	name: ProviderName = 'claude';

	async startRun(input: StartRunInput): Promise<AgentRunHandle> {
		const branch = await gitBranch(input.cwd);

		// Use agent mode: pass prompt as positional arg (not -p which is
		// one-shot print mode).  stdin is piped so the process can read
		// it but we close it immediately to signal non-interactive use.
		const proc = spawn('claude', ['--dangerously-skip-permissions', input.prompt], {
			cwd: input.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env }
		});

		// Close stdin to signal that the full prompt was the positional arg
		proc.stdin?.end();

		return handleFromProcess(proc, branch, input.cwd);
	}
}

// ── GitHub Copilot CLI Provider ──────────────────────────────────────

export class CopilotProvider implements AIProvider {
	name: ProviderName = 'copilot';

	async startRun(input: StartRunInput): Promise<AgentRunHandle> {
		const branch = await gitBranch(input.cwd);

		// Copilot CLI: pass prompt as positional argument for agent mode
		const proc = spawn('copilot-cli', [input.prompt], {
			cwd: input.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env }
		});

		proc.stdin?.end();

		return handleFromProcess(proc, branch, input.cwd);
	}
}

// ── Registry ─────────────────────────────────────────────────────────

const providers: Record<ProviderName, AIProvider> = {
	claude: new ClaudeProvider(),
	copilot: new CopilotProvider()
};

export function getProvider(name: ProviderName): AIProvider {
	const p = providers[name];
	if (!p) throw new Error(`Unknown provider: ${name}`);
	return p;
}

export function listProviders(): ProviderName[] {
	return Object.keys(providers) as ProviderName[];
}
