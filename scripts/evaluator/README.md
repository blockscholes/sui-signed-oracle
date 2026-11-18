# Optional evaluator discovery adapter

From the repository root, wrap the evaluator command with:

```sh
node scripts/evaluator/evaluator-launch.mjs <collector-command> <arguments...>
```

The adapter changes only the format of the real `vitest list` output for this
child process. It validates and emits existing absolute test-file paths, and
preserves collection errors. Normal pnpm, test and CI commands are unchanged.

The evaluation/ pytest project executes all three existing Move builds and unit
suites using the pinned Sui CLI. Keep the disposable localnet alive for the entire
evaluation, including the TypeScript E2E suite, with the launcher below.
Native coverage summaries remain under `.evaluator-artifacts/move/`. Python
adapter files are excluded from Python coverage; native Move instruction coverage
is retained separately from the evaluator's TypeScript coverage percentage.

For a self-contained local run, use:

```sh
python3 scripts/evaluator/run-with-localnet.py --sui-binary /path/to/sui-1.74.1 -- node scripts/evaluator/evaluator-launch.mjs <evaluator-command> <args...>
```

The launcher owns a fresh localnet home and a temporary Sui PATH shim for the
entire command. It binds RPC/faucet to loopback, keeps existing services intact,
does not read an operator keystore, and cleans up its own processes and keys.
The ignored repository marker contains only the public local RPC and version;
its contents are stable across runs and do not contain a temporary home path.
