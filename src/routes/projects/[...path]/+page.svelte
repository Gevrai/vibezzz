<script lang="ts">
	let { data } = $props();

	let activeTab = $state<'ideas' | 'runs' | 'access'>('runs');
	let runPrompt = $state('');
	let runProvider = $state(data.defaultProvider);
	let startingRun = $state(false);
	let stoppingRun = $state(false);
	let logLines = $state<string[]>([]);
	let logEventSource: EventSource | null = null;

	// Ideas state
	let newIdeaContent = $state('');
	let addingIdea = $state(false);

	// Access state
	let previewCommand = $state(data.deploy?.preview?.command ?? '');
	let previewPort = $state(data.deploy?.preview?.port ?? 3001);
	let previewSubdomain = $state(data.deploy?.preview?.subdomain ?? '');
	let savingDeploy = $state(false);
	let startingPreview = $state(false);
	let stoppingPreview = $state(false);

	// Publish state
	let publishImage = $state(data.deploy?.publish?.image ?? '');
	let publishSubdomain = $state(data.deploy?.publish?.subdomain ?? '');
	let publishState = $state<'up' | 'down' | 'lazy'>((data.deploy?.publish?.state as 'up' | 'down' | 'lazy') ?? 'down');
	let publishingAction = $state(false);
	let savingPublish = $state(false);

	// Re-sync local state when data changes (e.g. after navigation)
	$effect(() => {
		previewCommand = data.deploy?.preview?.command ?? '';
		previewPort = data.deploy?.preview?.port ?? 3001;
		previewSubdomain = data.deploy?.preview?.subdomain ?? '';
		publishImage = data.deploy?.publish?.image ?? '';
		publishSubdomain = data.deploy?.publish?.subdomain ?? '';
		publishState = (data.deploy?.publish?.state as 'up' | 'down' | 'lazy') ?? 'down';
	});

	const stageColors: Record<string, string> = {
		bootstrapping: 'bg-yellow-500/20 text-yellow-400',
		building: 'bg-orange-500/20 text-orange-400',
		preview_ready: 'bg-cyan-500/20 text-cyan-400',
		published: 'bg-green-500/20 text-green-400',
		paused: 'bg-gray-500/20 text-gray-400'
	};

	const statusColors: Record<string, string> = {
		running: 'bg-purple-500/20 text-purple-400',
		done: 'bg-green-500/20 text-green-400',
		failed: 'bg-red-500/20 text-red-400',
		stopped: 'bg-gray-500/20 text-gray-400'
	};

	const previewColors: Record<string, string> = {
		ready: 'bg-cyan-500/20 text-cyan-400',
		starting: 'bg-yellow-500/20 text-yellow-400',
		stopped: 'bg-gray-500/20 text-gray-400',
		failed: 'bg-red-500/20 text-red-400'
	};

	const publishStateColors: Record<string, string> = {
		up: 'bg-green-500/20 text-green-400',
		lazy: 'bg-amber-500/20 text-amber-400',
		down: 'bg-gray-500/20 text-gray-400'
	};

	const resultColors: Record<string, string> = {
		ready_for_test: 'text-green-400',
		building: 'text-orange-400',
		blocked: 'text-yellow-400',
		failed: 'text-red-400'
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

	async function startRun() {
		if (!runPrompt.trim() || startingRun) return;
		startingRun = true;
		try {
			const resp = await fetch(`/api/projects/${data.path}/runs`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: runPrompt.trim(), provider: runProvider })
			});
			if (resp.ok) {
				runPrompt = '';
				location.reload();
			}
		} finally {
			startingRun = false;
		}
	}

	async function stopRunAction() {
		if (!data.activeRun || stoppingRun) return;
		stoppingRun = true;
		try {
			await fetch(`/api/projects/${data.path}/runs/${data.activeRun.id}/stop`, {
				method: 'POST'
			});
			location.reload();
		} finally {
			stoppingRun = false;
		}
	}

	function connectLogs() {
		if (!data.activeRun) return;
		logLines = [];
		logEventSource?.close();
		logEventSource = new EventSource(
			`/api/projects/${data.path}/runs/${data.activeRun.id}/logs`
		);
		logEventSource.onmessage = (e) => {
			const text = JSON.parse(e.data);
			if (text === '[DONE]') {
				logEventSource?.close();
				location.reload();
				return;
			}
			logLines = [...logLines, text];
		};
		logEventSource.onerror = () => {
			logEventSource?.close();
		};
	}

	$effect(() => {
		if (activeTab === 'runs' && data.activeRun) {
			connectLogs();
		}
		return () => logEventSource?.close();
	});

	// Ideas actions
	async function addIdea() {
		if (!newIdeaContent.trim() || addingIdea) return;
		addingIdea = true;
		try {
			const resp = await fetch(`/api/projects/${data.path}/ideas`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: newIdeaContent.trim() })
			});
			if (resp.ok) {
				newIdeaContent = '';
				location.reload();
			}
		} finally {
			addingIdea = false;
		}
	}

	async function markImplemented(ideaId: number) {
		await fetch(`/api/projects/${data.path}/ideas/${ideaId}/implement`, {
			method: 'POST'
		});
		location.reload();
	}

	async function runFromIdea(ideaId: number) {
		await fetch(`/api/projects/${data.path}/ideas/${ideaId}/run`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: runProvider })
		});
		location.reload();
	}

	let promotingRunId = $state<number | null>(null);

	async function promoteToPreview(runId: number) {
		if (promotingRunId) return;
		promotingRunId = runId;
		try {
			await saveDeployConfig();
			await fetch(`/api/projects/${data.path}/preview/start`, { method: 'POST' });
			location.reload();
		} finally {
			promotingRunId = null;
		}
	}

	// Access actions
	async function saveDeployConfig() {
		savingDeploy = true;
		try {
			await fetch(`/api/projects/${data.path}/deploy`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					preview_command: previewCommand,
					preview_port: previewPort,
					preview_subdomain: previewSubdomain
				})
			});
		} finally {
			savingDeploy = false;
		}
	}

	async function startPreviewAction() {
		startingPreview = true;
		try {
			await saveDeployConfig();
			await fetch(`/api/projects/${data.path}/preview/start`, { method: 'POST' });
			location.reload();
		} finally {
			startingPreview = false;
		}
	}

	async function stopPreviewAction() {
		stoppingPreview = true;
		try {
			await fetch(`/api/projects/${data.path}/preview/stop`, { method: 'POST' });
			location.reload();
		} finally {
			stoppingPreview = false;
		}
	}

	// Publish actions
	async function savePublishConfig() {
		savingPublish = true;
		try {
			await fetch(`/api/projects/${data.path}/publish`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					image: publishImage,
					subdomain: publishSubdomain
				})
			});
		} finally {
			savingPublish = false;
		}
	}

	async function publishAction() {
		publishingAction = true;
		try {
			await savePublishConfig();
			await fetch(`/api/projects/${data.path}/publish`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ state: publishState })
			});
			location.reload();
		} finally {
			publishingAction = false;
		}
	}

	async function unpublishAction() {
		publishingAction = true;
		try {
			await fetch(`/api/projects/${data.path}/publish`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ state: 'down' })
			});
			location.reload();
		} finally {
			publishingAction = false;
		}
	}
</script>

<div class="mx-auto max-w-2xl">
	<div class="mb-4">
		<a href="/projects" class="text-sm text-gray-500 hover:text-gray-400">← Projects</a>
	</div>

	<!-- Header -->
	<div class="flex items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold">{data.meta.name}</h1>
			<p class="mt-1 text-sm text-gray-400">{data.path}</p>
		</div>
		<span class="rounded-full px-2.5 py-1 text-xs font-medium {stageColors[data.meta.project_stage] || 'bg-gray-700 text-gray-300'}">
			{data.meta.project_stage.replace('_', ' ')}
		</span>
	</div>

	<!-- Signal badges -->
	<div class="mt-4 flex flex-wrap gap-2">
		{#if data.signals.agent_active}
			<span class="rounded-full bg-purple-500/20 px-2.5 py-1 text-xs font-medium text-purple-400">🤖 agent running</span>
		{:else if data.signals.last_agent_status}
			<span class="rounded-full bg-gray-500/20 px-2.5 py-1 text-xs font-medium text-gray-400">agent {data.signals.last_agent_status}</span>
		{:else}
			<span class="rounded-full bg-gray-500/20 px-2.5 py-1 text-xs font-medium text-gray-400">agent idle</span>
		{/if}

		<span class="rounded-full px-2.5 py-1 text-xs font-medium {previewColors[data.signals.preview_status ?? 'stopped'] || 'bg-gray-500/20 text-gray-400'}">
			preview {data.signals.preview_status ?? 'stopped'}
		</span>

		{#if data.signals.preview_url}
			<a href={data.signals.preview_url} target="_blank" rel="noopener noreferrer" class="text-xs text-cyan-400 hover:text-cyan-300">🔗 Preview</a>
		{/if}
		{#if data.signals.publish_url}
			<a href={data.signals.publish_url} target="_blank" rel="noopener noreferrer" class="text-xs text-green-400 hover:text-green-300">🌐 Public</a>
		{/if}
	</div>

	<!-- Tabs -->
	<div class="mt-6 flex gap-1 border-b border-gray-800">
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'ideas' ? 'border-b-2 border-cyan-400 text-cyan-400' : 'text-gray-400 hover:text-gray-300'}"
			onclick={() => activeTab = 'ideas'}
		>
			💡 Ideas
		</button>
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'runs' ? 'border-b-2 border-cyan-400 text-cyan-400' : 'text-gray-400 hover:text-gray-300'}"
			onclick={() => activeTab = 'runs'}
		>
			🤖 Runs
		</button>
		<button
			class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'access' ? 'border-b-2 border-cyan-400 text-cyan-400' : 'text-gray-400 hover:text-gray-300'}"
			onclick={() => activeTab = 'access'}
		>
			🔑 Access
		</button>
	</div>

	<!-- Tab content -->
	<div class="mt-4 space-y-4">
		<!-- IDEAS TAB -->
		{#if activeTab === 'ideas'}
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<h3 class="mb-3 text-sm font-semibold text-gray-300">Add Project Idea</h3>
				<div class="flex gap-2">
					<textarea
						bind:value={newIdeaContent}
						placeholder="Describe an idea for this project…"
						rows="2"
						class="flex-1 resize-none rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none"
					></textarea>
					<button
						onclick={addIdea}
						disabled={addingIdea || !newIdeaContent.trim()}
						class="self-end rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
					>
						{addingIdea ? '…' : 'Add'}
					</button>
				</div>
			</div>

			{#if data.ideas.length === 0}
				<p class="text-center text-sm text-gray-600">No project ideas yet.</p>
			{:else}
				{#each data.ideas as idea}
					<div class="rounded-lg border border-gray-800 bg-gray-900 p-3">
						<div class="flex items-start justify-between gap-2">
							<p class="text-sm text-gray-200">{idea.content}</p>
							<span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium {idea.status === 'implemented' ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'}">
								{idea.status}
							</span>
						</div>
						<div class="mt-2 flex items-center gap-3 text-xs text-gray-500">
							<span>#{idea.id}</span>
							<span>{new Date(idea.created_at).toLocaleDateString()}</span>
							{#if idea.git_tag}
								<span class="text-green-400">{idea.git_tag}</span>
							{/if}
						</div>
						{#if idea.status === 'raw'}
							<div class="mt-2 flex gap-2">
								<button
									onclick={() => runFromIdea(idea.id)}
									class="rounded bg-purple-600/80 px-3 py-1 text-xs font-medium text-white hover:bg-purple-500"
								>
									🤖 Run Agent
								</button>
								<button
									onclick={() => markImplemented(idea.id)}
									class="rounded bg-green-600/80 px-3 py-1 text-xs font-medium text-white hover:bg-green-500"
								>
									✅ Mark Implemented
								</button>
							</div>
						{/if}
					</div>
				{/each}
			{/if}

		<!-- RUNS TAB -->
		{:else if activeTab === 'runs'}
			<!-- Active run -->
			{#if data.activeRun}
				<div class="rounded-lg border border-purple-800 bg-purple-900/20 p-4">
					<div class="flex items-center justify-between">
						<div>
							<span class="text-sm font-semibold text-purple-400">🤖 Running</span>
							<span class="ml-2 text-xs text-gray-400">{data.activeRun.provider}</span>
							<span class="ml-2 text-xs text-gray-500">{elapsed(data.activeRun.started_at)}</span>
						</div>
						<button
							onclick={stopRunAction}
							disabled={stoppingRun}
							class="rounded bg-red-600/80 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
						>
							{stoppingRun ? 'Stopping…' : '⬛ Stop'}
						</button>
					</div>
					<p class="mt-2 text-xs text-gray-400">{data.activeRun.summary}</p>

					<!-- Live logs -->
					{#if logLines.length > 0}
						<div class="mt-3 max-h-64 overflow-y-auto rounded bg-black p-2 font-mono text-xs text-green-400">
							{#each logLines as line}
								<div class="whitespace-pre-wrap">{line}</div>
							{/each}
						</div>
					{:else}
						<p class="mt-3 text-xs text-gray-600">Waiting for output…</p>
					{/if}
				</div>
			{/if}

			<!-- Start new run -->
			{#if !data.activeRun}
				<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
					<h3 class="mb-3 text-sm font-semibold text-gray-300">Start Agent Run</h3>
					<div class="space-y-3">
						<div class="flex gap-2">
							<select
								bind:value={runProvider}
								class="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white"
							>
								{#each data.providers as p}
									<option value={p}>{p}</option>
								{/each}
							</select>
						</div>
						<textarea
							bind:value={runPrompt}
							placeholder="What should the agent do?"
							rows="3"
							class="w-full resize-none rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none"
						></textarea>
						<button
							onclick={startRun}
							disabled={startingRun || !runPrompt.trim()}
							class="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
						>
							{startingRun ? 'Starting…' : '🚀 Start Run'}
						</button>
					</div>
				</div>
			{/if}

			<!-- Run history -->
			{#if data.runs.length > 0}
				<h3 class="text-sm font-semibold text-gray-400">Run History</h3>
				{#each data.runs as run}
					<div class="rounded-lg border border-gray-800 bg-gray-900 p-3">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2">
								<span class="rounded-full px-2 py-0.5 text-xs font-medium {statusColors[run.status] || 'bg-gray-500/20 text-gray-400'}">
									{run.status}
								</span>
								<span class="text-xs text-gray-400">{run.provider}</span>
								{#if run.result}
									<span class="text-xs {resultColors[run.result] || 'text-gray-500'}">→ {run.result.replace('_', ' ')}</span>
								{/if}
							</div>
							<span class="text-xs text-gray-500">#{run.id}</span>
						</div>
						<p class="mt-1 text-xs text-gray-400">{run.summary}</p>
						<div class="mt-1 flex items-center gap-3 text-xs text-gray-500">
							<span>{new Date(run.started_at).toLocaleString()}</span>
							{#if run.exit_code !== null}
								<span>exit: {run.exit_code}</span>
							{/if}
							{#if run.commit_sha}
								<span class="font-mono">{run.commit_sha.slice(0, 7)}</span>
							{/if}
							{#if run.branch}
								<span>{run.branch}</span>
							{/if}
							{#if run.log_url}
								<a
									href={run.log_url}
									target="_blank"
									rel="noopener noreferrer"
									class="text-cyan-400 hover:text-cyan-300"
								>📄 Log</a>
							{/if}
						</div>
						{#if run.result === 'ready_for_test' && !data.activeRun}
							<div class="mt-2">
								<button
									onclick={() => promoteToPreview(run.id)}
									disabled={promotingRunId === run.id}
									class="rounded bg-cyan-600/80 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
								>
									{promotingRunId === run.id ? 'Starting…' : '🚀 Promote to Preview'}
								</button>
							</div>
						{/if}
					</div>
				{/each}
			{/if}

		<!-- ACCESS TAB -->
		{:else if activeTab === 'access'}
			<!-- Preview section -->
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<div class="flex items-center justify-between">
					<h3 class="text-sm font-semibold text-gray-300">Preview</h3>
					<span class="rounded-full px-2 py-0.5 text-xs font-medium {previewColors[data.deploy?.preview?.status ?? 'stopped'] || 'bg-gray-500/20 text-gray-400'}">
						{data.deploy?.preview?.status ?? 'stopped'}
					</span>
				</div>

				{#if data.previewHealthy}
					<p class="mt-1 text-xs text-green-400">✅ Healthcheck passing</p>
				{:else if data.deploy?.preview?.status === 'ready'}
					<p class="mt-1 text-xs text-yellow-400">⚠ Healthcheck failing</p>
				{/if}

				{#if data.deploy?.preview?.url}
					<a
						href={data.deploy.preview.url}
						target="_blank"
						rel="noopener noreferrer"
						class="mt-2 inline-block text-sm text-cyan-400 hover:text-cyan-300"
					>
						🔗 {data.deploy.preview.url}
					</a>
				{/if}

				<div class="mt-3 space-y-2">
					<div>
						<label for="preview-cmd" class="text-xs text-gray-500">Command</label>
						<input
							id="preview-cmd"
							type="text"
							bind:value={previewCommand}
							placeholder="bun run dev -- --host 0.0.0.0 --port 3001"
							class="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none"
						/>
					</div>
					<div class="flex gap-2">
						<div class="flex-1">
							<label for="preview-port" class="text-xs text-gray-500">Port</label>
							<input
								id="preview-port"
								type="number"
								bind:value={previewPort}
								class="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white focus:border-cyan-500 focus:outline-none"
							/>
						</div>
						<div class="flex-1">
							<label for="preview-subdomain" class="text-xs text-gray-500">Subdomain</label>
							<input
								id="preview-subdomain"
								type="text"
								bind:value={previewSubdomain}
								class="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white focus:border-cyan-500 focus:outline-none"
							/>
						</div>
					</div>
				</div>

				<div class="mt-3 flex flex-wrap gap-2">
					<button
						onclick={saveDeployConfig}
						disabled={savingDeploy}
						class="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-600 disabled:opacity-50"
					>
						{savingDeploy ? 'Saving…' : '💾 Save Config'}
					</button>

					{#if data.deploy?.preview?.status === 'ready' || data.deploy?.preview?.status === 'starting'}
						<button
							onclick={stopPreviewAction}
							disabled={stoppingPreview}
							class="rounded bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
						>
							{stoppingPreview ? 'Stopping…' : '⬛ Stop Preview'}
						</button>
						<button
							onclick={startPreviewAction}
							disabled={startingPreview}
							class="rounded bg-yellow-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-500 disabled:opacity-50"
						>
							{startingPreview ? 'Restarting…' : '🔄 Restart Preview'}
						</button>
					{:else}
						<button
							onclick={startPreviewAction}
							disabled={startingPreview || !previewCommand.trim()}
							class="rounded bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
						>
							{startingPreview ? 'Starting…' : '▶ Start Preview'}
						</button>
					{/if}

					{#if data.deploy?.preview?.url}
						<a
							href={data.deploy.preview.url}
							target="_blank"
							rel="noopener noreferrer"
							class="rounded bg-cyan-600/50 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-500/50"
						>
							🔗 Open Preview
						</a>
					{/if}
				</div>
			</div>

			<!-- Publish section -->
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<div class="flex items-center justify-between">
					<h3 class="text-sm font-semibold text-gray-300">Publish</h3>
					<span class="rounded-full px-2 py-0.5 text-xs font-medium {publishStateColors[data.deploy?.publish?.state ?? 'down'] || 'bg-gray-500/20 text-gray-400'}">
						{data.deploy?.publish?.state ?? 'down'}
					</span>
				</div>

				<p class="mt-1 text-xs text-gray-500">
					Publish keeps your project accessible at a stable public URL beyond the temporary preview.
				</p>

				{#if data.deploy?.publish?.url}
					<a
						href={data.deploy.publish.url}
						target="_blank"
						rel="noopener noreferrer"
						class="mt-2 inline-block text-sm text-green-400 hover:text-green-300"
					>
						🌐 {data.deploy.publish.url}
					</a>
				{/if}

				<div class="mt-3 space-y-2">
					<div>
						<label for="publish-image" class="text-xs text-gray-500">Container Image</label>
						<input
							id="publish-image"
							type="text"
							bind:value={publishImage}
							placeholder="e.g. my-app:latest or ghcr.io/user/app:v1"
							class="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
						/>
					</div>
					<div class="flex gap-2">
						<div class="flex-1">
							<label for="publish-subdomain" class="text-xs text-gray-500">Subdomain</label>
							<input
								id="publish-subdomain"
								type="text"
								bind:value={publishSubdomain}
								placeholder="my-project"
								class="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
							/>
						</div>
						<div class="flex-1">
							<label for="publish-state" class="text-xs text-gray-500">State</label>
							<select
								id="publish-state"
								bind:value={publishState}
								class="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white focus:border-green-500 focus:outline-none"
							>
								<option value="up">up — always running</option>
								<option value="lazy">lazy — starts on first request</option>
								<option value="down">down — stopped</option>
							</select>
						</div>
					</div>
				</div>

				<div class="mt-3 flex flex-wrap gap-2">
					<button
						onclick={savePublishConfig}
						disabled={savingPublish}
						class="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-600 disabled:opacity-50"
					>
						{savingPublish ? 'Saving…' : '💾 Save Config'}
					</button>

					{#if data.deploy?.publish?.state === 'up' || data.deploy?.publish?.state === 'lazy'}
						<button
							onclick={unpublishAction}
							disabled={publishingAction}
							class="rounded bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
						>
							{publishingAction ? 'Unpublishing…' : '⬛ Unpublish'}
						</button>
						<button
							onclick={publishAction}
							disabled={publishingAction || !publishImage.trim()}
							class="rounded bg-yellow-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-500 disabled:opacity-50"
						>
							{publishingAction ? 'Updating…' : '🔄 Update Publish'}
						</button>
					{:else}
						<button
							onclick={publishAction}
							disabled={publishingAction || !publishImage.trim() || !publishSubdomain.trim() || publishState === 'down'}
							class="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
						>
							{publishingAction ? 'Publishing…' : '🚀 Publish'}
						</button>
					{/if}
				</div>

				{#if data.deploy?.publish?.container_id}
					<p class="mt-2 text-xs text-gray-500">
						Container: <span class="font-mono">{data.deploy.publish.container_id.slice(0, 12)}</span>
					</p>
				{/if}
			</div>

			<!-- Project details -->
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<h3 class="text-sm font-semibold text-gray-300">Project Details</h3>
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
		{/if}
	</div>
</div>
