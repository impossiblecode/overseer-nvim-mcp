import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["bin/overseer-nvim-mcp.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  clean: true,
  dts: false,

  // Prefix regexes: the SDK is imported by subpath, and a bare-name match
  // leaves it external while the build still passes.
  deps: {
    alwaysBundle: [/^@modelcontextprotocol\/sdk(\/|$)/, /^@msgpack\/msgpack(\/|$)/, /^zod(\/|$)/],
  },
});
