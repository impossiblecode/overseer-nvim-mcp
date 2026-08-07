#!/bin/sh
set -eu

cd "$(dirname "$0")/../.."
IMG=overseer-nvim-mcp:glama

if [ "${1:-}" != "--no-build" ]; then
  docker build -t "$IMG" -f ci/glama/Dockerfile .
fi

exec python3 - "$IMG" <<'EOF'
import json, os, subprocess, sys, time

img = sys.argv[1]
name = f"overseer-glama-smoke-{os.getpid()}"
proc = subprocess.Popen(
    ["docker", "run", "-i", "--rm", "--name", name, img],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)

requests = [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "glama-smoke", "version": "0.0.0"}}},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
        "name": "overseer_list_tasks", "arguments": {}}},
]
for req in requests:
    proc.stdin.write(json.dumps(req) + "\n")
proc.stdin.flush()

by_id, deadline = {}, time.monotonic() + 30
try:
    while {1, 2, 3} - by_id.keys():
        if time.monotonic() > deadline:
            sys.exit(f"timed out; got responses for {sorted(by_id)}")
        line = proc.stdout.readline()
        if not line:
            sys.exit(f"server exited early; got responses for {sorted(by_id)}")
        msg = json.loads(line)
        if "id" in msg:
            by_id[msg["id"]] = msg
finally:
    # killing the CLI alone leaves the container running
    subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL)
    proc.kill()

init = by_id[1]["result"]
assert init.get("instructions"), "initialize result carries no instructions"

tools = by_id[2]["result"]["tools"]
names = sorted(t["name"] for t in tools)
assert len(tools) == 7, f"expected 7 tools, got {len(tools)}: {names}"

call = by_id[3]["result"]
assert not call.get("isError"), f"overseer_list_tasks errored: {call}"

print("smoke OK: instructions present, 7 tools, live nvim answered:")
for n in names:
    print(f"  {n}")
EOF
