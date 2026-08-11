#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeRpc } from "../src/nvim.js";
import { buildServer } from "../src/server.js";

await buildServer().connect(new StdioServerTransport());

// The SDK transport only watches stdin 'data', so it never notices the client
// hanging up, and an open nvim socket would keep the process alive forever.
function shutdown(): void {
  closeRpc();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
