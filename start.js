// Production start wrapper for svelte-adapter-bun.
// Maps the BIND_HOST env contract to the HOST var the adapter reads.
if (process.env.BIND_HOST) {
	process.env.HOST = process.env.BIND_HOST;
}

await import('./build/index.js');
