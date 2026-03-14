import { parse, stringify } from 'yaml';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Read and parse a YAML file.
 * Returns the default value if the file does not exist.
 */
export async function readYaml<T>(filePath: string, defaultValue: T): Promise<T> {
	try {
		const content = await readFile(filePath, 'utf-8');
		const parsed = parse(content);
		return (parsed ?? defaultValue) as T;
	} catch (err: unknown) {
		if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
			return defaultValue;
		}
		throw err;
	}
}

/**
 * Atomically write data to a YAML file.
 * Writes to a temporary file in the same directory, then renames over the target.
 */
export async function writeYaml(filePath: string, data: unknown): Promise<void> {
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });

	const tmpName = join(dir, `.tmp-${randomBytes(8).toString('hex')}.yaml`);
	const content = stringify(data, { lineWidth: 0 });

	await writeFile(tmpName, content, 'utf-8');
	await rename(tmpName, filePath);
}
