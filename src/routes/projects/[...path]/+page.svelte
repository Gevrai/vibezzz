<script lang="ts">
	let { data } = $props();

	const stageColors: Record<string, string> = {
		bootstrapping: 'bg-yellow-500/20 text-yellow-400',
		building: 'bg-orange-500/20 text-orange-400',
		preview_ready: 'bg-cyan-500/20 text-cyan-400',
		published: 'bg-green-500/20 text-green-400',
		paused: 'bg-gray-500/20 text-gray-400'
	};
</script>

<div class="mx-auto max-w-2xl">
	<div class="mb-4">
		<a href="/projects" class="text-sm text-gray-500 hover:text-gray-400">← Projects</a>
	</div>

	<div class="flex items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold">{data.meta.name}</h1>
			<p class="mt-1 text-sm text-gray-400">{data.path}</p>
		</div>
		<span class="rounded-full px-2.5 py-1 text-xs font-medium {stageColors[data.meta.project_stage] || 'bg-gray-700 text-gray-300'}">
			{data.meta.project_stage.replace('_', ' ')}
		</span>
	</div>

	<div class="mt-6 space-y-4">
		<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
			<h2 class="text-sm font-semibold text-gray-300">Details</h2>
			<dl class="mt-3 space-y-2 text-sm">
				<div class="flex justify-between">
					<dt class="text-gray-500">Origin</dt>
					<dd class="text-gray-300">{data.meta.origin}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-gray-500">Category</dt>
					<dd class="text-gray-300">{data.meta.category}</dd>
				</div>
				{#if data.meta.idea_id}
					<div class="flex justify-between">
						<dt class="text-gray-500">Idea</dt>
						<dd class="text-gray-300">#{data.meta.idea_id}</dd>
					</div>
				{/if}
				{#if data.meta.template}
					<div class="flex justify-between">
						<dt class="text-gray-500">Template</dt>
						<dd class="text-gray-300">{data.meta.template}</dd>
					</div>
				{/if}
				<div class="flex justify-between">
					<dt class="text-gray-500">Created</dt>
					<dd class="text-gray-300">{new Date(data.meta.created_at).toLocaleDateString()}</dd>
				</div>
			</dl>
		</div>

		<p class="text-center text-sm text-gray-600">Ideas, runs, and access tabs coming soon.</p>
	</div>
</div>
