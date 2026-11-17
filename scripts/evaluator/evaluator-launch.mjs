#!/usr/bin/env node
/** WSL/Linux opt-in launcher. Scope the npx adapter to one evaluator process. */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node evaluator-launch.mjs <evaluator command> [arguments...]');
// The evaluator intentionally strips PATH entries under the operator home.
const directory = mkdtempSync('/tmp/mercor-evaluator-bin-');
try {
  const adapter = join(directory, 'npx');
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'evaluator-npx.mjs'), adapter);
  chmodSync(adapter, 0o755);
  const child = spawnSync(command, args, {
    stdio: 'inherit', env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
