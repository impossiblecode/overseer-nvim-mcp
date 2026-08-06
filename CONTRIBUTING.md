# Contributing

## Setup

Requires **Node >= 22** and **pnpm** (the repo pins a version via `packageManager`,
so Corepack will pick it up automatically).

```
pnpm install
```

You'll also need **`lua-language-server`** on `PATH` (`brew install
lua-language-server`, or your package manager's equivalent) and **nvim**, both
for the integration tests and for `check:lua`'s VIMRUNTIME resolution.

## Commands

```
pnpm dev              # run the server from source (tsx)
pnpm build            # bundle to dist/ with tsdown
pnpm check            # biome: lint + format + import sorting (verify only)
pnpm check:fix        # biome: apply fixes
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run
pnpm test:watch       # vitest
pnpm gen:lua          # regenerate src/lua.gen.ts from src/lua/*.lua
pnpm gen:lua:verify   # check src/lua.gen.ts isn't stale (verify only)
pnpm check:lua        # stylua + lua-language-server over src/lua/ (verify only)
pnpm precommit        # the full gate: check + check:lua + gen:lua:verify + typecheck + test
```

A husky `pre-commit` hook runs `pnpm precommit` and **verifies**; it does not
rewrite the tree mid-commit. Any lint, format, lua, type, or test failure
blocks the commit; run `pnpm check:fix` to clear formatting, then commit again.

## Commit messages: Conventional Commits required

Releases are automated with
[release-please](https://github.com/googleapis/release-please), which derives the
next version and the changelog **entirely from commit messages**. A commit that
does not parse is silently omitted from the changelog, so this is not a style
preference.

```
feat: add overseer_run cwd option        -> minor bump, "Features"
fix: trim PTY padding before slicing     -> patch bump, "Bug Fixes"
docs: clarify $NVIM transport            -> no bump, "Documentation"
deps: bump @modelcontextprotocol/sdk     -> patch bump, "Dependencies"
chore: / test: / ci: / refactor:         -> no bump, hidden from changelog
```

Breaking changes take a `!` (`feat!: ...`) or a `BREAKING CHANGE:` footer. While
the package is pre-1.0, `bump-minor-pre-major` means breaking changes move the
**minor** version, not the major.

release-please owns `CHANGELOG.md`, `package.json`'s `version`, and
`.release-please-manifest.json`, so do not hand-edit any of the three. Merging
its release PR is what publishes to npm.

## Tests

Tests live in `src/__tests__/`, named after the module they cover. vitest globs
`*.test.ts` anywhere, so this needs no runner config.

The **integration** tests need a live nvim running overseer, and are split by
concern across `overseer.test.ts`, `overseer.tail.test.ts` and
`overseer.templates.test.ts`. They read `$NVIM` and **skip cleanly when it is
unset**, which is convenient but dangerous: a broken setup looks identical to
a green run. If you change anything in `src/lua/`, make sure they actually
execute.

Two ways to run them for real:

**From inside nvim.** Open a terminal buffer in nvim (`:terminal`) and run
`pnpm test` there. Nvim exports `$NVIM` to processes it spawns, so the tests
pick it up and drive your live editor. They create and dispose a handful of
short-lived tasks in your task list.

**Headless**, the same way CI runs them:

```
git clone --depth 1 --branch v2.1.0 https://github.com/stevearc/overseer.nvim /tmp/overseer
OVERSEER_PATH=/tmp/overseer nvim --headless -u ci/minimal_init.lua --listen /tmp/nvim-ci.sock &
NVIM=/tmp/nvim-ci.sock pnpm test
```

Those commands assume a POSIX shell. On Windows `$NVIM` is a named pipe, so
`--listen` wants a `\\.\pipe\...` name rather than a path under `/tmp`. The
server and the unit tests are platform agnostic: node:net takes a unix socket
and a named pipe through the same `path` option, and the tests pick the right
form per platform. CI builds and smoke-tests on Linux, macOS and Windows, but
only runs the integration suite on Linux and macOS, so Windows against a live
overseer is currently unverified rather than known good.

## Things that will bite you

**Do not add socket discovery.** No cwd hashing, `lsof`, or `pgrep`. `$NVIM` is
the entire transport. Both alternatives were tried and are structurally broken: a
cwd-hash scheme cannot tell a crashed instance's stale socket from a live one and
will unlink working sockets, and `pgrep` on macOS excludes the caller's own
ancestors, which is exactly the nvim instance that matters.

**Never interpolate user input into Lua source.** Arguments ride as msgpack
values and arrive in Lua as `...`. This is what stops a task name from becoming
code execution, and `src/rpc.test.ts` has a test asserting it.

**Trim trailing blanks before slicing terminal output.** Terminal buffers are
PTY grids padded with blank lines to the window height; slicing naively tails
the padding, not the output.

**CI pins the overseer version** (`OVERSEER_REF`). `src/lua/templates.lua` and
`src/lua/tail.lua` each reach into overseer internals:
`overseer.template` (no public template-listing API exists) and
`task.strategy.pending_output` (marked `---@field private`, but the only way to
read output from an RPC-started task). Both are commented at the call site. If
you bump the pin, expect those two first.

**The bundle must import nothing but `node:` builtins.** `deps.alwaysBundle` in
`tsdown.config.ts` uses prefix regexes on purpose: the SDK is imported by
subpath, and a bare package-name match silently leaves it external, dragging
back the express/hono/jose tree while the build still reports success. CI
asserts this directly.

## Non-goals

These were left out on purpose. Each has been considered; please open an issue
with a concrete use case before sending a PR that adds one.

- **Socket discovery of any kind.** See above. `$NVIM` is the whole transport.
- **Provider-specific template handling.** `overseer_list_templates` reports what
  overseer's providers return, verbatim. Filtering help-only entries means
  teaching this server one task runner's conventions, and it has to behave the
  same in a repo that has never heard of that runner.
- **Push notifications on task state change.** `Task:subscribe(event, cb)` would
  support it. Polling via `overseer_tail` is the default until something needs
  more.
- **Routing every command through overseer.** Short synchronous commands belong
  on the agent's own shell, where output comes back in-band. The boundary is
  documented in `overseer_run`'s description.
- **Cross-repo control**, i.e. driving an nvim running somewhere other than the
  one the client is inside. `$NVIM` only.
- **A library entry point.** This is a bin-only package: no `main`, `types`, or
  `exports`. `buildServer` is exported from `src/server.ts` for the tests.

## Pull requests

CI must be green: lint, typecheck, tests against live overseer on Node 22 and 24,
and a build that installs the packed tarball as a consumer would. Please keep
new behaviour covered by a test, especially anything touching `src/lua/`,
which is the only part that cannot be verified without a real overseer.
