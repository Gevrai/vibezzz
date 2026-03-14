<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let content = $state('');
	let showPromote = $state<number | null>(null);
	let promoteName = $state('');
	let promoteCategory = $state('');
	let promoting = $state(false);

	const statusColors: Record<string, string> = {
		raw: 'bg-amber-500/20 text-amber-400',
		promoted: 'bg-blue-500/20 text-blue-400',
		implemented: 'bg-green-500/20 text-green-400'
	};

	async function promote(ideaId: number) {
		if (!promoteName.trim() || !promoteCategory.trim()) return;
		promoting = true;
		try {
			const res = await fetch(`/api/ideas/${ideaId}/promote`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: promoteName.trim(), category: promoteCategory.trim() })
			});
			if (res.ok) {
				window.location.reload();
			} else {
				const err = await res.json();
				alert(err.error || 'Promotion failed');
			}
		} finally {
			promoting = false;
		}
	}
</script>

<div class="mx-auto max-w-2xl">
	<h1 class="text-2xl font-bold">Inbox</h1>
	<p class="mt-1 text-sm text-gray-400">Capture ideas from anywhere. Promote the good ones to projects.</p>

	<!-- Idea capture form -->
	<form method="POST" action="?/create" use:enhance={() => {
		return async ({ update }) => {
			content = '';
			await update();
		};
	}} class="mt-4">
		<div class="flex gap-2">
			<textarea
				name="content"
				bind:value={content}
				placeholder="What's the idea?"
				rows="2"
				class="flex-1 resize-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
			></textarea>
			<button
				type="submit"
				disabled={!content.trim()}
				class="self-end rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
			>
				Add
			</button>
		</div>
		{#if form?.error}
			<p class="mt-1 text-sm text-red-400">{form.error}</p>
		{/if}
	</form>

	<!-- API shortcut hint -->
	<details class="mt-3">
		<summary class="cursor-pointer text-xs text-gray-500 hover:text-gray-400">API capture shortcut</summary>
		<code class="mt-1 block rounded bg-gray-900 px-3 py-2 text-xs text-gray-400">
			{`curl -X POST /api/ideas -H 'Content-Type: application/json' -d '{"content":"your idea"}'`}
		</code>
	</details>

	<!-- Ideas list -->
	<div class="mt-6 space-y-3">
		{#each data.ideas as idea (idea.id)}
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0 flex-1">
						<p class="text-sm text-gray-100">{idea.content}</p>
						<div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
							<span class="rounded-full px-2 py-0.5 text-xs font-medium {statusColors[idea.status] || 'bg-gray-700 text-gray-300'}">
								{idea.status}
							</span>
							<span>#{idea.id}</span>
							<span>{new Date(idea.created_at).toLocaleDateString()}</span>
							{#if idea.project_path}
								<a href="/projects/{idea.project_path}" class="text-blue-400 hover:text-blue-300">
									→ {idea.project_path}
								</a>
							{/if}
						</div>
					</div>

					{#if idea.status === 'raw'}
						<button
							onclick={() => {
								showPromote = showPromote === idea.id ? null : idea.id;
								promoteName = '';
								promoteCategory = '';
							}}
							class="shrink-0 rounded-md border border-gray-700 px-3 py-1 text-xs text-gray-300 transition-colors hover:border-blue-500 hover:text-blue-400"
						>
							Promote
						</button>
					{/if}
				</div>

				{#if showPromote === idea.id}
					<div class="mt-3 flex flex-wrap gap-2 border-t border-gray-800 pt-3">
						<input
							bind:value={promoteCategory}
							placeholder="Category (e.g. js)"
							class="w-28 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
						/>
						<input
							bind:value={promoteName}
							placeholder="Project name"
							class="flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
						/>
						<button
							onclick={() => promote(idea.id)}
							disabled={promoting || !promoteName.trim() || !promoteCategory.trim()}
							class="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
						>
							{promoting ? 'Creating…' : 'Create Project'}
						</button>
					</div>
				{/if}
			</div>
		{:else}
			<p class="text-center text-sm text-gray-500">No ideas yet. Start typing above!</p>
		{/each}
	</div>
</div>
