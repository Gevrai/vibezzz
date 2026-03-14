<script lang="ts">
	let { data } = $props();
	let syncing = $state(false);

	const stageColors: Record<string, string> = {
		bootstrapping: 'bg-yellow-500/20 text-yellow-400',
		building: 'bg-orange-500/20 text-orange-400',
		preview_ready: 'bg-cyan-500/20 text-cyan-400',
		published: 'bg-green-500/20 text-green-400',
		paused: 'bg-gray-500/20 text-gray-400'
	};

	const originColors: Record<string, string> = {
		brain: 'bg-purple-500/20 text-purple-400',
		external: 'bg-gray-500/20 text-gray-400'
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

	async function resync() {
		syncing = true;
		try {
			const res = await fetch('/api/projects/resync', { method: 'POST' });
			if (res.ok) {
				window.location.reload();
			} else {
				alert('Resync failed');
			}
		} finally {
			syncing = false;
		}
	}
</script>

<div class="mx-auto max-w-3xl">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold">Projects</h1>
			<p class="mt-1 text-sm text-gray-400">{data.count} project{data.count !== 1 ? 's' : ''} across {data.categories.length} categor{data.categories.length !== 1 ? 'ies' : 'y'}</p>
		</div>
		<button
			onclick={resync}
			disabled={syncing}
			class="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-blue-500 hover:text-blue-400 disabled:opacity-40"
		>
			{syncing ? 'Syncing…' : '🔄 Resync'}
		</button>
	</div>

	{#if data.categories.length === 0}
		<div class="mt-12 text-center">
			<p class="text-gray-500">No projects found.</p>
			<p class="mt-1 text-sm text-gray-600">Promote an idea from the <a href="/" class="text-blue-400 hover:text-blue-300">Inbox</a> or click Resync to scan your projects directory.</p>
		</div>
	{:else}
		<div class="mt-6 space-y-6">
			{#each data.categories as category}
				<details open class="group">
					<summary class="cursor-pointer text-sm font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-300">
						{category}
						<span class="ml-1 text-xs font-normal text-gray-600">({data.grouped[category].length})</span>
					</summary>
					<div class="mt-2 space-y-2">
						{#each data.grouped[category] as project}
							<a
								href="/projects/{project.path}"
								class="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-gray-700"
							>
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0 flex-1">
										<h3 class="text-sm font-medium text-gray-100">{project.meta.name}</h3>
									</div>
									<div class="flex shrink-0 flex-wrap items-center gap-1.5">
										<span class="rounded-full px-2 py-0.5 text-xs font-medium {originColors[project.meta.origin] || ''}">
											{project.meta.origin}
										</span>
										<span class="rounded-full px-2 py-0.5 text-xs font-medium {stageColors[project.meta.project_stage] || ''}">
											{project.meta.project_stage.replace('_', ' ')}
										</span>
										{#if project.signals.agent_active}
											<span class="rounded-full bg-purple-500/20 px-2 py-0.5 text-xs font-medium text-purple-400">🤖</span>
										{/if}
										{#if project.signals.preview_status}
											<span class="rounded-full px-2 py-0.5 text-xs font-medium {previewColors[project.signals.preview_status] || 'bg-gray-500/20 text-gray-400'}">
												preview {project.signals.preview_status}
											</span>
										{/if}
										{#if project.signals.publish_state}
											<span class="rounded-full px-2 py-0.5 text-xs font-medium {publishColors[project.signals.publish_state] || 'bg-gray-500/20 text-gray-400'}">
												publish {project.signals.publish_state}
											</span>
										{/if}
									</div>
								</div>
								<div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
									<span>{project.path}</span>
									{#if project.meta.idea_id}
										<span>idea #{project.meta.idea_id}</span>
									{/if}
									{#if project.signals.preview_url}
										<span class="text-cyan-400" title={project.signals.preview_url}>🔗 {project.signals.preview_url}</span>
									{/if}
									{#if project.signals.publish_url}
										<span class="text-green-400" title={project.signals.publish_url}>🌐 {project.signals.publish_url}</span>
									{/if}
								</div>
							</a>
						{/each}
					</div>
				</details>
			{/each}
		</div>
	{/if}
</div>
