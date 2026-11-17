# Optional evaluator discovery adapter

From the repository root, wrap the evaluator command with:

```sh
node scripts/evaluator/evaluator-launch.mjs <collector-command> <arguments...>
```

The adapter changes only the format of the real `vitest list` output for this
child process. It validates and emits existing absolute test-file paths, and
preserves collection errors. Normal pnpm, test and CI commands are unchanged.

The full Vitest run still needs the CI-documented Sui localnet and pinned CLI.
Move build/tests remain separate; use the existing `scripts/check.sh` with that
toolchain. This adapter does not claim to add native Move discovery or coverage.
