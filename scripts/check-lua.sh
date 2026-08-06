#!/usr/bin/env bash
# Verify-only format + lint gate for src/lua.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v lua-language-server >/dev/null 2>&1 || {
  echo "check-lua: lua-language-server not on PATH (brew install lua-language-server)" >&2
  exit 1
}
command -v nvim >/dev/null 2>&1 || {
  echo "check-lua: nvim not on PATH; needed to resolve VIMRUNTIME for luals" >&2
  exit 1
}

# .luarc.json points workspace.library at .luals/nvim-runtime; refresh the
# symlink so the editor and this check read the same runtime defs.
runtime="$(nvim --clean --headless -c 'lua io.write(vim.env.VIMRUNTIME)' -c 'qa!' 2>/dev/null)"
[ -d "$runtime/lua" ] || { echo "check-lua: could not resolve VIMRUNTIME (got: $runtime)" >&2; exit 1; }
mkdir -p .luals
ln -sfn "$runtime/lua" .luals/nvim-runtime

pnpm exec stylua --check src/lua

# luals exit codes vary across versions, so parse the JSON report instead.
# Run from the repo root so .luarc.json is the workspace config.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
lua-language-server --check "$PWD" --checklevel=Warning \
  --check_out_path="$tmp/luals.json" --logpath="$tmp" >/dev/null
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const diags = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  const all = Object.entries(diags).flatMap(([file, list]) => list.map((d) => ({ file, ...d })));
  if (all.length) {
    for (const d of all) console.error(`${d.file}:${(d.range?.start?.line ?? 0) + 1}: ${d.message}`);
    process.exit(1);
  }
' "$tmp/luals.json"
echo "check-lua: clean"
