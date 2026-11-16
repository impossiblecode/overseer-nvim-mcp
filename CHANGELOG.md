# Changelog

## [1.0.0-beta.1](https://github.com/impossiblecode/overseer-nvim-mcp/compare/v1.0.0-beta.0...v1.0.0-beta.1) (2026-11-16)


### Features

* follow overseer tasks to the end as MCP tasks from overseer_run and overseer_restart ([4175c3a](https://github.com/impossiblecode/overseer-nvim-mcp/commit/4175c3a78e4eef7187ed268485c23d0f671e6301))


### Documentation

* replace figurative idioms with what actually happens ([04e398d](https://github.com/impossiblecode/overseer-nvim-mcp/commit/04e398d2fe9cbb1b0ea3d5acba3ad72ecb310ee6))

## [1.0.0-beta.0](https://github.com/impossiblecode/overseer-nvim-mcp/compare/v0.3.1...v1.0.0-beta.0) (2026-11-15)


### ⚠ BREAKING CHANGES

* serve the 2026-07-28 MCP revision on SDK v2 and require Node >= 24

### Features

* serve the 2026-07-28 MCP revision on SDK v2 and require Node &gt;= 24 ([5caf78c](https://github.com/impossiblecode/overseer-nvim-mcp/commit/5caf78c60040958a5e4502b4a9c30ff1d9c2fe74))

## [0.3.1](https://github.com/impossiblecode/overseer-nvim-mcp/compare/v0.3.0...v0.3.1) (2026-11-15)


### Bug Fixes

* name --lines in the wait usage in instructions ([dca022e](https://github.com/impossiblecode/overseer-nvim-mcp/commit/dca022e9353b5bc47e29a65c347622f2c57fd4ac))

## [0.3.0](https://github.com/impossiblecode/overseer-nvim-mcp/compare/v0.2.3...v0.3.0) (2026-11-14)


### Features

* auto-dispose finished tasks and add the wait subcommand ([b38f306](https://github.com/impossiblecode/overseer-nvim-mcp/commit/b38f306c7de79d4f4c79d61c25c802598c1c0482))


### Bug Fixes

* **deps:** bump bundled MCP SDK, zod and fast-uri to clear security advisories ([6c978de](https://github.com/impossiblecode/overseer-nvim-mcp/commit/6c978deba19d9097ffa4baa35de8a9b74bf67a6e))
* **run:** report tasks that cannot start and resolve a relative cmd[0] against cwd ([b38f306](https://github.com/impossiblecode/overseer-nvim-mcp/commit/b38f306c7de79d4f4c79d61c25c802598c1c0482))
* **server:** advertise the node path as launched, not the resolved install dir ([b38f306](https://github.com/impossiblecode/overseer-nvim-mcp/commit/b38f306c7de79d4f4c79d61c25c802598c1c0482))

## [0.2.3](https://github.com/impossiblecode/overseer-nvim-mcp/compare/v0.2.2...v0.2.3) (2026-08-11)


### Bug Fixes

* **deps:** bump bundled fast-uri to 3.1.5 (GHSA-7p8r-x3mc-p8w7) ([9c75250](https://github.com/impossiblecode/overseer-nvim-mcp/commit/9c75250ef76550d54394a7daf0bbd172f1fb244e))

## [0.2.2](https://github.com/impossiblecode/overseer-nvim-mcp/compare/v0.2.1...v0.2.2) (2026-08-11)


### Bug Fixes

* **bin:** exit when the client disconnects ([7b71847](https://github.com/impossiblecode/overseer-nvim-mcp/commit/7b71847d33e0084f267daf17712f4d520cd2f449))
* **rpc:** reject calls immediately once nvim is gone ([e68a54a](https://github.com/impossiblecode/overseer-nvim-mcp/commit/e68a54aaf008326cb0483bbbf2ea784c592ebcc5))
* **rpc:** report socket errors as nvim no longer running ([100c587](https://github.com/impossiblecode/overseer-nvim-mcp/commit/100c587330600e34103e0b8ff2a0e89161893ef5))
* **tail:** stop a backtracking wait_for pattern from hanging the server ([5e35c9a](https://github.com/impossiblecode/overseer-nvim-mcp/commit/5e35c9a8a7f4ec5feb6b258a96e4e77fea42216e))

## [0.2.1](https://github.com/impossiblecode/overseer-nvim-mcp/compare/v0.2.0...v0.2.1) (2026-08-07)


### Bug Fixes

* trim tail's default to 10 lines and describe schema params ([1a1d0d5](https://github.com/impossiblecode/overseer-nvim-mcp/commit/1a1d0d5deee18a82a0e6b40d4dc57bec23a67972))

## [0.2.0](https://github.com/impossiblecode/overseer-nvim-mcp/compare/v0.1.1...v0.2.0) (2026-08-07)


### Features

* publish releases to the official MCP registry ([3f2841a](https://github.com/impossiblecode/overseer-nvim-mcp/commit/3f2841aad3f35747f00feb479a2c38f455cf4bc9))

## [0.1.1](https://github.com/impossiblecode/overseer-nvim-mcp/compare/v0.1.0...v0.1.1) (2026-08-06)


### Bug Fixes

* **gen-lua:** stop needs: parsing at the first statement, error on preludes with no code ([04216fa](https://github.com/impossiblecode/overseer-nvim-mcp/commit/04216faaa0aa575914dae8436ba3a95c0907f603))

## 0.1.0 (2026-08-06)


### Features

* MCP server for overseer.nvim task control ([6b9a021](https://github.com/impossiblecode/overseer-nvim-mcp/commit/6b9a021c97549b587557a4bc26bda417a8c5d756))
