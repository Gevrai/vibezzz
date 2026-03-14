/**
 * Post-build: inject env-contract guard into the production entrypoint
 * so `build/index.js` can never be started without required env vars
 * or without honouring the BIND_HOST contract — even when executed
 * directly instead of via `bun run start`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { REQUIRED_ENV } from './env-schema.js';

const ENTRY = 'build/index.js';
const MARKER = 'env-contract guard';

const guard = `// --- ${MARKER} (injected by postbuild.js) ---
{
  const _REQ = ${JSON.stringify(REQUIRED_ENV)};
  const _missing = _REQ.filter((n) => !process.env[n]);
  if (_missing.length > 0) {
    throw new Error("Missing required environment variable(s): " + _missing.join(", "));
  }
  // Map BIND_HOST → HOST so the Bun adapter binds to the correct interface.
  if (!process.env.HOST) {
    process.env.HOST = process.env.BIND_HOST;
  }
  // Validate PORT when explicitly set.
  const _port = process.env.PORT;
  if (_port != null && _port !== "") {
    if (!/^\\d+$/.test(_port)) {
      throw new Error("PORT must be a valid integer (1\\u201365535), got: " + _port);
    }
    const _p = Number(_port);
    if (_p < 1 || _p > 65535) {
      throw new Error("PORT must be a valid integer (1\\u201365535), got: " + _port);
    }
  }
}
// --- end ${MARKER} ---
`;

const original = readFileSync(ENTRY, 'utf8');

if (original.includes(MARKER)) {
	console.log('postbuild: env-contract guard already present, skipping.');
	process.exit(0);
}

writeFileSync(ENTRY, guard + original);
console.log('postbuild: injected env-contract guard into ' + ENTRY);
