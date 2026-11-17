#!/usr/bin/env node
/** Opt-in evaluator bridge: real Vitest collection -> unique absolute filenames.
 * Install as `npx` in a temporary PATH directory only for the evaluator process.
 * Every other invocation is delegated unchanged to this Node runtime's real npx.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const realNpx = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npx-cli.js');
if (!existsSync(realNpx)) throw new Error('Cannot locate the real npx for this Node runtime');
const listRequest = args.length === 3 && args[0] === '--no-install'
  && args[1] === 'vitest' && args[2] === 'list';

/** Preserve the child command's exit status; a missing executable is a failure. */
function status(result) {
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (!listRequest) {
  process.exitCode = status(spawnSync(process.execPath, [realNpx, ...args], { stdio: 'inherit' }));
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'mercor-vitest-list-'));
  try {
    const listing = join(scratch, 'tests.json');
    const result = spawnSync(process.execPath, [realNpx, ...args, `--json=${listing}`], {
      encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024,
    });
    if (result.stdout) process.stderr.write(result.stdout);
    const code = status(result);
    if (code !== 0) process.exitCode = code;
    else {
      const records = JSON.parse(readFileSync(listing, 'utf8'));
      if (!Array.isArray(records)) throw new Error('Vitest did not return a test-record array');
      const root = realpathSync(process.cwd());
      const files = new Set();
      for (const record of records) {
        if (!record || typeof record.file !== 'string' || typeof record.name !== 'string') {
          throw new Error('Invalid Vitest test record');
        }
        const file = realpathSync(resolve(root, record.file));
        const local = relative(root, file);
        if (local === '..' || local.startsWith('../') || isAbsolute(local)
          || !statSync(file).isFile() || !/\.[cm]?[jt]sx?$/.test(file)) {
          throw new Error('Vitest returned a file outside the expected repository scope');
        }
        files.add(file);
      }
      for (const file of [...files].sort()) process.stdout.write(`${file}\n`);
    }
  } catch (error) {
    process.stderr.write(`Evaluator discovery adapter failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
