#!/bin/sh
set -eu

SOCK=/tmp/nvim.sock
rm -f "$SOCK"

nvim --headless -u /app/ci/minimal_init.lua --listen "$SOCK" \
  < /dev/null > /tmp/nvim.log 2>&1 &

# usually up in ~400ms; poll instead of guessing a sleep
i=0
while [ ! -S "$SOCK" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "headless nvim never created its socket" >&2
    cat /tmp/nvim.log >&2
    exit 1
  fi
  sleep 0.1
done

export NVIM="$SOCK"
exec "$@"
