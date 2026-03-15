<script lang="ts">
	let { data } = $props();

	let provider = $state(data.defaultProvider);
	let synthesizing = $state(false);
	let result = $state('');
	let synthesisError = $state('');

	async function synthesize() {
		if (synthesizing) return;
		synthesizing = true;
		result = '';
		synthesisError = '';

		try {
			const resp = await fetch('/api/synthesis', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider })
			});
			const body = await resp.json();
			if (resp.ok) {
				result = body.result;
			} else {
				synthesisError = body.message || 'Synthesis failed';
			}
		} catch (err) {
			synthesisError = 'Network error';
		} finally {
			synthesizing = false;
		}
	}
</script>

<div class="mx-auto max-w-2xl">
	<h1 class="text-2xl font-bold">🧠 Synthesis</h1>
	<p class="mt-1 text-sm text-gray-400">
		Summarize and triage raw ideas using an AI provider.
		Output is ephemeral — not persisted.
	</p>

	<div class="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
		<div class="flex items-center gap-3">
			<select
				bind:value={provider}
				class="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white"
			>
				{#each data.providers as p}
					<option value={p}>{p}</option>
				{/each}
			</select>

			<button
				onclick={synthesize}
				disabled={synthesizing || data.rawIdeaCount === 0}
				class="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
			>
				{#if synthesizing}
					Synthesizing…
				{:else}
					🧠 Synthesize ({data.rawIdeaCount} raw ideas)
				{/if}
			</button>
		</div>

		{#if data.rawIdeaCount === 0}
			<p class="mt-3 text-sm text-gray-600">No raw ideas to synthesize. Add ideas from the Inbox first.</p>
		{/if}
	</div>

	{#if synthesisError}
		<div class="mt-4 rounded-lg border border-red-800 bg-red-900/20 p-4">
			<p class="text-sm text-red-400">{synthesisError}</p>
		</div>
	{/if}

	{#if result}
		<div class="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
			<h3 class="mb-2 text-sm font-semibold text-gray-300">Synthesis Result</h3>
			<div class="whitespace-pre-wrap text-sm text-gray-300">{result}</div>
		</div>
	{/if}
</div>
