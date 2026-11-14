#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeRpc } from "../src/nvim.js";
import { buildServer } from "../src/server.js";
import { runWait } from "../src/wait.js";

// `wait <task>` is the CLI; anything else starts the server.
if (process.argv[2] === "wait") {
  process.exit(
    await runWait(
      process.argv.slice(3),
      (s) => process.stdout.write(`${s}\n`),
      (s) => process.stderr.write(`${s}\n`),
    ),
  );
}

await buildServer().connect(new StdioServerTransport());

// The SDK transport only watches stdin 'data', so it never notices the client
// hanging up, and an open nvim socket would keep the process alive forever.
function shutdown(): void {
  closeRpc();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
