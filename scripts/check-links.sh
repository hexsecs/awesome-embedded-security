#!/usr/bin/env bash
# Runs markdown-link-check over the repository's markdown, retrying the whole
# pass on failure.
#
# The external hosts this list links to intermittently drop connections
# ("Status: 0  Error: socket hang up"). It rotates between hosts run to run and
# is not reproducible, so it cannot be fixed by ignoring specific URLs.
# markdown-link-check itself only retries HTTP 429 (retryOn429/retryCount), and
# a dropped connection never reaches a status code, so a whole-pass retry is
# the only mechanism available.
#
# Retries only help because the check is a pure read: a link that is genuinely
# dead fails on every attempt, so this suppresses flakes without suppressing
# real breakage.

set -uo pipefail

CONFIG="${CONFIG:-.github/workflows/markdown.links.config.json}"
ATTEMPTS="${ATTEMPTS:-3}"
DELAY="${DELAY:-20}"

files=()
while IFS= read -r f; do files+=("$f"); done < <(
  git ls-files '*.md' | grep -v '^node_modules/'
)

if [ ${#files[@]} -eq 0 ]; then
  echo "No markdown files found." >&2
  exit 1
fi

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "==> Link check attempt ${attempt}/${ATTEMPTS}"
  if npx --no-install markdown-link-check --quiet --config "$CONFIG" "${files[@]}"; then
    echo "==> Links OK (attempt ${attempt})"
    exit 0
  fi
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    echo "==> Attempt ${attempt} failed; retrying in ${DELAY}s" >&2
    sleep "$DELAY"
  fi
done

echo "==> Link check failed after ${ATTEMPTS} attempts" >&2
exit 1
