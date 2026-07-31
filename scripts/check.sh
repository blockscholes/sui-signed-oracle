#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

sh -n scripts/check.sh scripts/pre-commit.sh
pnpm -C ts format:check
pnpm -C ts lint
pnpm -C ts typecheck
pnpm -C ts test:unit
# --build-env pins dependency resolution to the environment Move.lock has pins for,
# regardless of whichever `sui client` env happens to be active locally (e.g. a
# contributor who last ran the e2e suite has "localnet" active, which has no pins).
sui move test --build-env testnet --lint --warnings-are-errors --gas-limit 100000000000 -p move/bs_oracle
sui move test --build-env testnet --lint --warnings-are-errors --gas-limit 100000000000 -p move/bs_sid
sui move test --build-env testnet --lint --warnings-are-errors --gas-limit 100000000000 -p move/example_consumer
# The test build compiles #[test_only] code too; only a plain build proves the
# production sources stand alone (e.g. no unused_field/unused_const behind a
# test-only demotion).
sui move build --build-env testnet --lint --warnings-are-errors -p move/bs_oracle
sui move build --build-env testnet --lint --warnings-are-errors -p move/bs_sid
sui move build --build-env testnet --lint --warnings-are-errors -p move/example_consumer
