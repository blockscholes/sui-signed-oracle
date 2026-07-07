#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Shelve unstaged edits to tracked files so formatting only touches the
# staged snapshot; otherwise a partially-staged file (`git add -p`) would get
# its unstaged hunks silently rewritten too, and the check below would be
# comparing the wrong thing. Untracked files are left alone: they can't be
# part of this commit, and sweeping them into the stash risks a pop conflict
# (e.g. build output directories).
stashed=0
if ! git diff --quiet; then
  git stash push --keep-index --quiet -m "pre-commit: shelve unstaged changes"
  stashed=1
fi
trap '[ "$stashed" -eq 0 ] || git stash pop --quiet' EXIT

pnpm -C ts format

if ! git diff --quiet; then
  echo "Formatter updated files. Review and stage those changes, then commit again."
  git diff --stat
  exit 1
fi

scripts/check.sh
