#!/usr/bin/env bash
# Runs awesome-lint, and explains the one error it reports that is not true.
#
# awesome-lint resolves the repository's remote itself, in its github rule
# (node_modules/awesome-lint/rules/github.js), roughly:
#
#   branch=$(git branch --show-current)
#   if [ -n "$branch" ]; then git config --get "branch.${branch}.remote"
#   else                      git config --default origin --get clone.defaultRemoteName
#   fi
#
# `git config --get branch.<name>.remote` exits 1 when the branch has no
# upstream. execa throws on a nonzero exit, the rule's catch fires, and it
# reports "Awesome list must reside in a valid git repository" — at someone
# standing in a perfectly valid git repository. So `npm run validate`, the
# command contributing.md tells every contributor to run before opening a
# pull request, fails on any freshly created local branch until it is pushed
# with -u. The first branch a first-time contributor makes is exactly that
# branch, and the message sends them to look at the wrong thing entirely.
#
# CI cannot hit it: actions/checkout leaves a detached HEAD, so
# `git branch --show-current` is empty and the else branch resolves origin.
# Verified against awesome-lint 2.3.0 in all four states — default branch,
# new local branch, that branch after setting the remote, and detached HEAD.
#
# This makes the message survivable and nothing more. It changes no git
# config, suppresses no error, and passes awesome-lint's exit status through
# unchanged: if the lint fails, the run still fails.

set -uo pipefail

TARGET="${1:-README.md}"

# Checked before the run, reported after it, so the explanation lands next to
# the error rather than scrolling off above it. The condition is exact: a
# non-empty branch name with no configured remote is precisely the input that
# sends the rule down its throwing path.
#
# It is also only half the condition. The note is printed only when the lint
# actually failed — a script written to stop CI telling you the wrong thing
# has no business printing a twelve-line warning under a green run.
branch="$(git branch --show-current 2>/dev/null)"
missing_upstream=false
if [ -n "$branch" ] && ! git config --get "branch.${branch}.remote" >/dev/null 2>&1; then
  missing_upstream=true
fi

npx --no-install awesome-lint "$TARGET"
status=$?

if [ "$missing_upstream" = true ] && [ "$status" -ne 0 ]; then
  cat >&2 <<EOF

==> If you saw "Awesome list must reside in a valid git repository":

    Your repository is fine. The current branch has no upstream remote
    configured, and awesome-lint reports that as an invalid repository. CI
    never hits this, because it builds from a detached HEAD.

    Any one of these clears it:

      git push -u origin ${branch}
      git branch --set-upstream-to=origin/main
      git config branch.${branch}.remote origin

    Nothing has been changed for you — pick the one you want.
EOF
fi

exit "$status"
