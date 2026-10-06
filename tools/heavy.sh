#!/bin/bash
# heavy.sh <command...> — run a heavy command through a machine-wide queue.
#
# Several agent sessions share this machine with the owner. GPU tests, renders, headed
# browser runs, builds and wide vitest runs each saturate it; six at once make it crawl.
# This is a counting semaphore over a fixed directory, so every session and every git
# worktree shares one queue: at most LOOM_HEAVY_SLOTS (default 2) heavy commands run at a
# time, the rest wait in line.
#
#   tools/heavy.sh pnpm vitest run src/foo.gpu.test.ts --maxWorkers=1 --minWorkers=1
#   tools/heavy.sh pnpm build
#   tools/heavy.sh node --import ./src/tooling/alias-hooks.ts src/projects/x/render.ts
#
# A slot is a directory holding the owner's PID; a slot whose PID is gone is reclaimed, so
# a killed command never blocks the queue.
set -u
if [ "$#" -eq 0 ]; then echo "usage: tools/heavy.sh <command...>" >&2; exit 2; fi
QUEUE="${LOOM_HEAVY_DIR:-/tmp/loom-heavy-queue}"
SLOTS="${LOOM_HEAVY_SLOTS:-2}"
mkdir -p "$QUEUE"
slot=""
release() { [ -n "$slot" ] && rm -rf "$slot"; }
trap release EXIT
trap 'release; exit 130' INT TERM
waited=0
while [ -z "$slot" ]; do
  i=1
  while [ "$i" -le "$SLOTS" ]; do
    candidate="$QUEUE/slot-$i"
    if mkdir "$candidate" 2>/dev/null; then
      echo $$ > "$candidate/pid"
      slot="$candidate"
      break
    fi
    holder=$(cat "$candidate/pid" 2>/dev/null || echo "")
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$candidate"   # the holder died; take the slot on the next pass
      continue
    fi
    i=$((i + 1))
  done
  if [ -z "$slot" ]; then
    [ "$waited" -eq 0 ] && echo "heavy.sh: all $SLOTS slots busy, waiting in line…" >&2
    sleep 5
    waited=$((waited + 5))
  fi
done
[ "$waited" -gt 0 ] && echo "heavy.sh: got a slot after ${waited}s" >&2
"$@"
status=$?
release
slot=""
exit $status
