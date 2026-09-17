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
#
# The retry works so well that it hides its own evidence: a host that fails
# attempt 1 and passes attempt 2, month after month, is invisible, and the
# ignorePatterns list in markdown.links.config.json was curated from memory
# because there was nothing else to curate it from. So each attempt's output
# is kept and summarised into REPORT_DIR/report.json — which URLs failed, on
# which attempt, and whether a later attempt got them. The summary is written
# on success too; the recovered-on-retry case is the whole point.
#
# Nothing below is allowed to change this script's behaviour or exit status:
# it gates merges, and a broken summariser must never turn a green link check
# red. Run scripts/link-flake.js aggregate over several reports to turn the
# noise into an ignorePatterns argument.

set -uo pipefail

CONFIG="${CONFIG:-.github/workflows/markdown.links.config.json}"
ATTEMPTS="${ATTEMPTS:-3}"
DELAY="${DELAY:-20}"
REPORT_DIR="${REPORT_DIR:-.link-check}"

files=()
while IFS= read -r f; do files+=("$f"); done < <(
  git ls-files '*.md' | grep -v '^node_modules/'
)

if [ ${#files[@]} -eq 0 ]; then
  echo "No markdown files found." >&2
  exit 1
fi

mkdir -p "$REPORT_DIR"
# Only this run's own files, so a stale attempt-3 log from a previous run
# cannot be read back as part of this one.
rm -f "${REPORT_DIR}"/attempt-*.log "${REPORT_DIR}/report.json"

summarize() {
  node scripts/link-flake.js summarize \
    --dir "$REPORT_DIR" --attempts "$ATTEMPTS" --outcome "$1" ||
    echo "==> Could not write the flake summary (link check result unaffected)" >&2
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "==> Link check attempt ${attempt}/${ATTEMPTS}"
  # tee keeps the output on stdout exactly as before; pipefail is what makes
  # the pipeline report markdown-link-check's status rather than tee's.
  if npx --no-install markdown-link-check --quiet --config "$CONFIG" "${files[@]}" 2>&1 |
    tee "${REPORT_DIR}/attempt-${attempt}.log"; then
    echo "==> Links OK (attempt ${attempt})"
    if [ "$attempt" -gt 1 ]; then summarize recovered; else summarize clean; fi
    exit 0
  fi
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    echo "==> Attempt ${attempt} failed; retrying in ${DELAY}s" >&2
    sleep "$DELAY"
  fi
done

summarize failed
echo "==> Link check failed after ${ATTEMPTS} attempts" >&2
exit 1
