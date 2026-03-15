/**
 * Synthesis API endpoint.
 * Sends raw ideas to a provider for triage/synthesis.
 * Output is ephemeral — not persisted.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listIdeas } from '$lib/server/ideas';
import { getProvider, type ProviderName, listProviders } from '$lib/server/providers';
import { getConfig } from '$lib/server/config';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const providerName: ProviderName = body.provider ?? getConfig().defaultProvider;

	if (!listProviders().includes(providerName)) {
		throw error(400, `Unknown provider: ${providerName}`);
	}

	const ideas = await listIdeas();
	const rawIdeas = ideas.filter((i) => i.status === 'raw');

	if (rawIdeas.length === 0) {
		return json({ result: 'No raw ideas to synthesize.' });
	}

	const ideasText = rawIdeas
		.map((i) => `- [#${i.id}] ${i.content}`)
		.join('\n');

	const prompt = `You are an idea triage assistant. Review these raw project ideas and provide:
1. A ranked summary (most promising first)
2. Which ideas could be combined
3. Quick feasibility notes for each

Ideas:
${ideasText}

Respond concisely with a structured ranking.`;

	try {
		const provider = getProvider(providerName);
		// Use a temporary directory for synthesis (not a real project)
		const handle = await provider.startRun({
			prompt,
			cwd: getConfig().vibezzzRepo,
			kind: 'custom'
		});

		// Collect output
		const chunks: string[] = [];
		const decoder = new TextDecoder();

		const readStream = async (stream: ReadableStream<Uint8Array>) => {
			const reader = stream.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(decoder.decode(value, { stream: true }));
				}
			} finally {
				reader.releaseLock();
			}
		};

		// Read both streams, wait for process
		await Promise.all([
			readStream(handle.stdout),
			readStream(handle.stderr),
			handle.wait()
		]);

		return json({ result: chunks.join('') });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Synthesis failed';
		throw error(500, message);
	}
};
