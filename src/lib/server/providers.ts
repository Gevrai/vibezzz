/**
 * AI Provider abstraction for agent runs.
 *
 * Each provider wraps a CLI tool (claude, copilot) and spawns it as a
 * subprocess in the project working directory.  The host machine is expected
 * to have the CLIs pre-authenticated — vibebox never stores API keys.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

// ── Types ────────────────────────────────────────────────────────────

export type RunKind = 'bootstrap' | 'implement' | 'refine' | 'custom';
export type RunResult = 'ready_for_test' | 'building' | 'blocked' | 'failed';
export type ProviderName = 'claude' | 'copilot';

export interface AgentRunHandle {
	pid: number;
	startedAt: string;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	stop(): Promise<void>;
	wait(): Promise<{
		exitCode: number;
		finishedAt: string;
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
function handleFromProcess(proc: ChildProcess): AgentRunHandle {
	const startedAt = nowISO();
	const pid = proc.pid ?? 0;

	const exitPromise = new Promise<number>((resolve) => {
		proc.on('exit', (code) => resolve(code ?? 1));
		proc.on('error', () => resolve(1));
	});

	return {
		pid,
		startedAt,

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
			return {
				exitCode,
				finishedAt: nowISO(),
				result: resultFromExit(exitCode)
			};
		}
	};
}

// ── Claude CLI Provider ──────────────────────────────────────────────

export class ClaudeProvider implements AIProvider {
	name: ProviderName = 'claude';

	async startRun(input: StartRunInput): Promise<AgentRunHandle> {
		const proc = spawn('claude', ['--dangerously-skip-permissions', '-p', input.prompt], {
			cwd: input.cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env }
		});

		return handleFromProcess(proc);
	}
}

// ── GitHub Copilot CLI Provider ──────────────────────────────────────

export class CopilotProvider implements AIProvider {
	name: ProviderName = 'copilot';

	async startRun(input: StartRunInput): Promise<AgentRunHandle> {
		const proc = spawn('copilot-cli', ['-p', input.prompt], {
			cwd: input.cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env }
		});

		return handleFromProcess(proc);
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
