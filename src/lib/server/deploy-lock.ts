/**
 * Serialization lock for deploy.yaml mutations.
 *
 * Shared across preview and publish modules so all writers go through
 * the same per-directory queue and never clobber each other.
 */

const deployLocks = new Map<string, Promise<void>>();

export async function withDeployLock<T>(vibezzzDir: string, fn: () => Promise<T>): Promise<T> {
	const prev = deployLocks.get(vibezzzDir) ?? Promise.resolve();
	let release: () => void;
	const next = new Promise<void>((r) => { release = r; });
	deployLocks.set(vibezzzDir, next);

	await prev;
	try {
		return await fn();
	} finally {
		release!();
		if (deployLocks.get(vibezzzDir) === next) {
			deployLocks.delete(vibezzzDir);
		}
	}
}

/**
 * Global lock for subdomain claim operations.
 *
 * Per-project deploy locks are insufficient for subdomain uniqueness because
 * two different projects can each hold their own lock, both check the same
 * subdomain as free, and both persist. This global lock serializes all
 * subdomain-claiming operations across projects.
 */
let subdomainClaimQueue = Promise.resolve();

export async function withSubdomainClaimLock<T>(fn: () => Promise<T>): Promise<T> {
	let release: () => void;
	const next = new Promise<void>((r) => { release = r; });
	const prev = subdomainClaimQueue;
	subdomainClaimQueue = next;

	await prev;
	try {
		return await fn();
	} finally {
		release!();
	}
}
