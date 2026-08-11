# Changelog

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
