<script lang="ts">
	let { data } = $props();

	const stageColors: Record<string, string> = {
		bootstrapping: 'bg-yellow-500/20 text-yellow-400',
		building: 'bg-orange-500/20 text-orange-400',
		preview_ready: 'bg-cyan-500/20 text-cyan-400',
		published: 'bg-green-500/20 text-green-400',
		paused: 'bg-gray-500/20 text-gray-400'
	};

	const previewColors: Record<string, string> = {
		ready: 'bg-cyan-500/20 text-cyan-400',
		starting: 'bg-yellow-500/20 text-yellow-400',
		stopped: 'bg-gray-500/20 text-gray-400',
		error: 'bg-red-500/20 text-red-400'
	};

	const publishColors: Record<string, string> = {
		up: 'bg-green-500/20 text-green-400',
		lazy: 'bg-yellow-500/20 text-yellow-400',
		down: 'bg-gray-500/20 text-gray-400'
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
		<!-- Signal badges -->
		<div class="flex flex-wrap gap-2">
			{#if data.signals.agent_active}
				<span class="rounded-full bg-purple-500/20 px-2.5 py-1 text-xs font-medium text-purple-400">🤖 agent running</span>
			{:else if data.signals.last_agent_status}
				<span class="rounded-full bg-gray-500/20 px-2.5 py-1 text-xs font-medium text-gray-400">agent {data.signals.last_agent_status}</span>
			{/if}

			{#if data.signals.preview_status}
				<span class="rounded-full px-2.5 py-1 text-xs font-medium {previewColors[data.signals.preview_status] || 'bg-gray-500/20 text-gray-400'}">
					preview {data.signals.preview_status}
				</span>
			{/if}

			{#if data.signals.publish_state}
				<span class="rounded-full px-2.5 py-1 text-xs font-medium {publishColors[data.signals.publish_state] || 'bg-gray-500/20 text-gray-400'}">
					publish {data.signals.publish_state}
				</span>
			{/if}
		</div>

		<!-- URLs -->
		{#if data.signals.preview_url || data.signals.publish_url}
			<div class="flex flex-wrap gap-3 text-sm">
				{#if data.signals.preview_url}
					<a href={data.signals.preview_url} target="_blank" rel="noopener noreferrer"
						class="text-cyan-400 hover:text-cyan-300">🔗 Preview</a>
				{/if}
				{#if data.signals.publish_url}
					<a href={data.signals.publish_url} target="_blank" rel="noopener noreferrer"
						class="text-green-400 hover:text-green-300">🌐 Public</a>
				{/if}
			</div>
		{/if}

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
