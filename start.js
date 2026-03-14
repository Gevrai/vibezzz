// Production start wrapper for svelte-adapter-bun.
// Validates env via shared boot config, then maps BIND_HOST → HOST
// for the adapter.
import { loadBootConfig } from './boot-env.js';

const boot = loadBootConfig();
process.env.HOST = boot.host;

await import('./build/index.js');
