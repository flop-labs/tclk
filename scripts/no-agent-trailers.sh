#!/usr/bin/env bash
#
# Reads commit-message text on stdin and fails if it carries an agent session link.
#
# Why: a coding-agent session URL is a private artifact. It says nothing to a reader of the
# history, it is not resolvable by anyone outside the account that made it, and once the
# repository is public it is permanent — a rewrite is cheap today and impossible after the
# first clone. This repository's history was squashed once to remove them; the point of this
# script is that it does not have to happen twice.
#
# One definition, two callers: `.githooks/commit-msg` pipes a message being written into it,
# and the `commit-messages` job in `.github/workflows/ci.yml` pipes every commit in a pull
# request through it. A second copy of the pattern would drift from the first.
#
# To catch another trailer, add an alternative to PATTERN — nothing else changes.
set -euo pipefail

PATTERN='claude\.ai/code/session|^[[:space:]]*Claude-Session:'

message=$(cat)

if printf '%s\n' "$message" | grep -qE "$PATTERN"; then
  {
    echo "commit message carries an agent session link:"
    echo
    printf '%s\n' "$message" | grep -nE "$PATTERN" | sed 's/^/    /'
    echo
    echo "Remove the line. These are private URLs that mean nothing to a reader of a public"
    echo "history, and they cannot be taken back once pushed and cloned."
    echo
    echo "Pattern lives in scripts/no-agent-trailers.sh."
  } >&2
  exit 1
fi
