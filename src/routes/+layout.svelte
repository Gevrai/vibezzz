<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';

	let { children } = $props();

	const navItems = [
		{ href: '/', label: 'Inbox', icon: '📥' },
		{ href: '/synthesis', label: 'Synthesis', icon: '🧠' },
		{ href: '/projects', label: 'Projects', icon: '📁' },
		{ href: '/monitor', label: 'Monitor', icon: '📡' }
	] as const;

	function isActive(href: string): boolean {
		if (href === '/') return page.url.pathname === '/';
		return page.url.pathname.startsWith(href);
	}
</script>

<svelte:head>
	<title>vibebox</title>
	<meta name="description" content="Personal async builder" />
</svelte:head>

<div class="flex min-h-screen flex-col bg-gray-950 text-gray-100">
	<main class="flex-1 overflow-y-auto p-4 pb-20 md:pb-4 md:pl-52">
		{@render children()}
	</main>

	<!-- Desktop sidebar -->
	<nav class="fixed top-0 left-0 hidden h-full w-48 flex-col gap-1 border-r border-gray-800 bg-gray-900 p-4 md:flex">
		<a href="/" class="mb-6 text-xl font-bold tracking-tight text-white">vibebox</a>
		{#each navItems as item}
			<a
				href={item.href}
				class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors
					{isActive(item.href) ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'}"
			>
				<span>{item.icon}</span>
				<span>{item.label}</span>
			</a>
		{/each}
	</nav>

	<!-- Mobile bottom bar -->
	<nav class="fixed inset-x-0 bottom-0 z-50 flex items-center justify-around border-t border-gray-800 bg-gray-900 md:hidden">
		{#each navItems as item}
			<a
				href={item.href}
				class="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors
					{isActive(item.href) ? 'text-white' : 'text-gray-500'}"
			>
				<span class="text-lg">{item.icon}</span>
				<span>{item.label}</span>
			</a>
		{/each}
	</nav>
</div>
