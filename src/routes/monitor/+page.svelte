<script lang="ts">
	let { data } = $props();

	const statusColors: Record<string, string> = {
		running: 'bg-purple-500/20 text-purple-400',
		done: 'bg-green-500/20 text-green-400',
		failed: 'bg-red-500/20 text-red-400',
		stopped: 'bg-gray-500/20 text-gray-400',
		ready: 'bg-cyan-500/20 text-cyan-400',
		starting: 'bg-yellow-500/20 text-yellow-400'
	};

	function elapsed(started: string): string {
		const ms = Date.now() - new Date(started).getTime();
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${s % 60}s`;
		const h = Math.floor(m / 60);
		return `${h}h ${m % 60}m`;
	}
</script>

<div class="mx-auto max-w-2xl">
	<h1 class="text-2xl font-bold">📡 Monitor</h1>
	<p class="mt-1 text-sm text-gray-400">Global overview of running agents, previews, and recent activity.</p>

	<div class="mt-6 space-y-6">
		<!-- Active agent runs -->
		<section>
			<h2 class="mb-3 text-sm font-semibold text-gray-300">
				🤖 Running Agents
				{#if data.activeRuns.length > 0}
					<span class="ml-1 text-purple-400">({data.activeRuns.length})</span>
				{/if}
			</h2>
			{#if data.activeRuns.length === 0}
				<p class="text-sm text-gray-600">No agents currently running.</p>
			{:else}
				{#each data.activeRuns as run}
					<div class="mb-2 rounded-lg border border-purple-800 bg-purple-900/20 p-3">
						<div class="flex items-center justify-between">
							<a href="/projects/{run.projectPath}" class="text-sm font-medium text-purple-400 hover:text-purple-300">
								{run.projectPath}
							</a>
							<span class="text-xs text-gray-500">{elapsed(run.started_at)}</span>
						</div>
						<p class="mt-1 text-xs text-gray-400">{run.summary}</p>
						<span class="text-xs text-gray-500">{run.provider} · #{run.id}</span>
					</div>
				{/each}
			{/if}
		</section>

		<!-- Active previews -->
		<section>
			<h2 class="mb-3 text-sm font-semibold text-gray-300">
				👁 Active Previews
				{#if data.activePreviews.length > 0}
					<span class="ml-1 text-cyan-400">({data.activePreviews.length})</span>
				{/if}
			</h2>
			{#if data.activePreviews.length === 0}
				<p class="text-sm text-gray-600">No previews currently running.</p>
			{:else}
				{#each data.activePreviews as preview}
					<div class="mb-2 rounded-lg border border-gray-800 bg-gray-900 p-3">
						<div class="flex items-center justify-between">
							<a href="/projects/{preview.projectPath}" class="text-sm font-medium text-cyan-400 hover:text-cyan-300">
								{preview.projectPath}
							</a>
							<span class="rounded-full px-2 py-0.5 text-xs font-medium {statusColors[preview.status] || 'bg-gray-500/20 text-gray-400'}">
								{preview.status}
							</span>
						</div>
						{#if preview.url}
							<a href={preview.url} target="_blank" rel="noopener noreferrer" class="mt-1 text-xs text-cyan-400 hover:text-cyan-300">
								🔗 {preview.url}
							</a>
						{/if}
					</div>
				{/each}
			{/if}
		</section>

		<!-- Recent completed runs -->
		<section>
			<h2 class="mb-3 text-sm font-semibold text-gray-300">📜 Recent Completed Runs</h2>
			{#if data.recentRuns.length === 0}
				<p class="text-sm text-gray-600">No completed runs yet.</p>
			{:else}
				{#each data.recentRuns as run}
					<div class="mb-2 rounded-lg border border-gray-800 bg-gray-900 p-3">
						<div class="flex items-center justify-between">
							<a href="/projects/{run.projectPath}" class="text-sm text-gray-300 hover:text-white">
								{run.projectPath}
							</a>
							<span class="rounded-full px-2 py-0.5 text-xs font-medium {statusColors[run.status] || 'bg-gray-500/20 text-gray-400'}">
								{run.status}
							</span>
						</div>
						<p class="mt-1 text-xs text-gray-400">{run.summary}</p>
						<div class="mt-1 flex gap-2 text-xs text-gray-500">
							<span>{run.provider}</span>
							{#if run.result}
								<span>→ {run.result}</span>
							{/if}
							<span>{new Date(run.started_at).toLocaleString()}</span>
						</div>
					</div>
				{/each}
			{/if}
		</section>

		<!-- Recent notifications -->
		<section>
			<h2 class="mb-3 text-sm font-semibold text-gray-300">🔔 Recent Notifications</h2>
			{#if data.notifications.length === 0}
				<p class="text-sm text-gray-600">No notifications yet.</p>
			{:else}
				{#each data.notifications as notif}
					<div class="mb-2 rounded-lg border border-gray-800 bg-gray-900 p-3">
						<div class="flex items-center justify-between">
							<span class="text-sm text-gray-300">{notif.summary}</span>
							<span class="text-xs text-gray-500">{notif.event}</span>
						</div>
						<div class="mt-1 flex gap-2 text-xs text-gray-500">
							<span>{notif.project}</span>
							<span>{new Date(notif.timestamp).toLocaleString()}</span>
						</div>
						{#if notif.url}
							<a href={notif.url} target="_blank" rel="noopener noreferrer" class="mt-1 text-xs text-cyan-400 hover:text-cyan-300">
								🔗 {notif.url}
							</a>
						{/if}
					</div>
				{/each}
			{/if}
		</section>
	</div>
</div>
