# Security

## Reporting a vulnerability

Report privately, never in a public issue. Two channels:

- GitHub's private vulnerability reporting: the Security tab of this
  repository, then "Report a vulnerability".
- Email: ma@mxconsulting.net.

This is a solo-maintained project. Expect an acknowledgement within a week,
and a fix or a clear assessment as fast as severity warrants. You will be
credited in the release notes unless you ask not to be.

## Supported versions

The package is pre-1.0. Only the latest published release receives fixes;
there are no maintenance branches.

## What counts as a vulnerability here

The attack surface is small on purpose, and reports that breach it are
taken seriously:

- The server listens on nothing. Its only transport is `$NVIM`, the RPC
  socket of the Neovim instance the MCP client already runs inside. With
  `$NVIM` unset it registers no tools at all.
- No user input ever becomes Lua source. Task names, commands, params and
  directories ride as msgpack arguments and arrive in Lua as `...`;
  `src/rpc.test.ts` asserts this with a hostile payload. Anything that gets a
  string interpolated into `nvim_exec_lua` code is a vulnerability, full stop.
- Commands started through `overseer_run` execute with the privileges of your
  Neovim process. That is the tool's purpose, not a bypass: the MCP client's
  permission prompts are the boundary there.

## Bundled dependencies

The published artifact is a single file with no runtime dependencies; the MCP
SDK and everything under it are bundled at build time. The consequence: a CVE
in a bundled dependency is fixed by a rebuild and republish of this package,
not by `npm update` on your side. If a scanner flags a dependency of ours,
report it here so a release can pick up the patched version.
