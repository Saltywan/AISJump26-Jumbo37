#!/usr/bin/env bash
# Fail loudly if the vendored kit at packages/kit/ has drifted from its own
# VERSION stamp, or from the research repo that produced it.
#
#   packages/kit/check-version.sh [path-to-JumpAIS]
#
# Two independent things can go wrong, and this checks both:
#
#   1. INTERNAL drift: someone hand-edited a vendored file (or VERSION itself)
#      without re-running kit/sync-to-app.sh. Detected by recomputing each
#      file's hash and comparing to the one VERSION recorded. This needs
#      nothing but this repo, so it always runs.
#
#   2. UPSTREAM drift: the research repo has moved on since this copy was
#      vendored. Detected by comparing VERSION's source-commit against the
#      research repo's current HEAD, and by re-hashing the research repo's
#      own files. This needs a checkout of ../JumpAIS (or an explicit path,
#      or $JUMPAIS_SOURCE_REPO) — a deployment won't have that lying around,
#      so its absence is reported, not treated as a failure.
set -euo pipefail

KIT=$(cd "$(dirname "$0")" && pwd)
VERSION_FILE="$KIT/VERSION"
FAIL=0

[ -f "$VERSION_FILE" ] || { echo "FAIL: $VERSION_FILE does not exist"; exit 1; }

sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

# field NAME: pull "NAME: value" (colon may have extra padding) out of VERSION
field() { grep -E "^$1:" "$VERSION_FILE" | head -1 | sed -E "s/^$1:[[:space:]]*//"; }
hash_field() { field "$1" | sed 's/^sha256://'; }

echo "== internal check: vendored files vs. $VERSION_FILE =="

declare -a VENDORED=(
  "lib/shell.js:shell.js"
  "lib/shell.css:shell.css"
  "prompts/shell-rules.th.txt:shell-rules.th.txt"
  "prompts/poc-original.th.txt:poc-original.th.txt"
  "checks/check.mjs:check.mjs"
  "generate.py:generate.py"
)

for pair in "${VENDORED[@]}"; do
  relpath=${pair%%:*}
  key=${pair##*:}
  path="$KIT/$relpath"
  expected=$(hash_field "$key")
  if [ -z "$expected" ]; then
    echo "FAIL: VERSION has no hash recorded for $key"
    FAIL=1
    continue
  fi
  if [ ! -f "$path" ]; then
    echo "FAIL: $relpath is listed in VERSION but missing from the vendored copy"
    FAIL=1
    continue
  fi
  actual=$(sha256_of "$path")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $relpath does not match its VERSION hash"
    echo "      VERSION says: $expected"
    echo "      actual file:  $actual"
    echo "      -> hand-edited, or vendored without re-running kit/sync-to-app.sh"
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  echo "ok: every vendored file matches its recorded hash"
fi

echo
echo "== upstream check: VERSION vs. the research repo =="

SRC_ARG=${1:-${JUMPAIS_SOURCE_REPO:-$KIT/../../../JumpAIS}}
if SRC=$(cd "$SRC_ARG" 2>/dev/null && pwd) && [ -d "$SRC/kit" ]; then
  echo "source : $SRC/kit"

  SRC_COMMIT=$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo "")
  PINNED_COMMIT=$(field "source-commit")
  if [ -z "$SRC_COMMIT" ]; then
    echo "note: $SRC is not a git checkout (or git is unavailable) — skipping commit comparison"
  elif [ "$SRC_COMMIT" != "$PINNED_COMMIT" ]; then
    echo "FAIL: source repo has moved on"
    echo "      VERSION pins:  $PINNED_COMMIT"
    echo "      source is now: $SRC_COMMIT"
    FAIL=1
  else
    echo "ok: source-commit matches the research repo's HEAD"
  fi

  # Content-level check too: catches drift even when the pinned commit still
  # matches but the working tree used to vendor it was dirty, or vice versa.
  for pair in "${VENDORED[@]}"; do
    relpath=${pair%%:*}
    key=${pair##*:}
    # Every vendored path maps the same way, so map it once. The previous
    # version listed lib/, prompts/ and checks/ explicitly and had no branch
    # for generate.py: srcpath kept whatever the last iteration set, so
    # generate.py was compared against check.mjs's file and reported as
    # differing forever, even when the two copies were byte-identical. A
    # staleness check that cries wolf is one people learn to ignore.
    srcpath="$SRC/kit/$relpath"
    if [ -f "$srcpath" ]; then
      src_hash=$(sha256_of "$srcpath")
      vendored_hash=$(hash_field "$key")
      if [ "$src_hash" != "$vendored_hash" ]; then
        echo "FAIL: $relpath differs from the research repo's current copy"
        echo "      -> run kit/sync-to-app.sh in $SRC to pick up the change"
        FAIL=1
      fi
    else
      echo "note: $srcpath not found in source repo — skipping"
    fi
  done
else
  echo "note: research repo not found at '$SRC_ARG' (set \$JUMPAIS_SOURCE_REPO or pass a path)"
  echo "      skipping upstream check — this is expected in a deployment that"
  echo "      only has this repo checked out"
fi

echo
if [ "$FAIL" -ne 0 ]; then
  echo "STALE: the vendored kit needs attention (see FAIL lines above)"
  exit 1
fi
echo "OK: vendored kit is internally consistent$( [ -n "${SRC:-}" ] && echo " and matches the research repo" )"
