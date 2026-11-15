#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { closeRpc } from "../src/nvim.ts";
import { buildServer } from "../src/server.ts";
import { runWait } from "../src/wait.ts";

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

// not serveStdio(buildServer): the factory gets a request context, which
// buildServer would take as onRegister
serveStdio(() => buildServer());

// the open nvim socket keeps the process alive after the client hangs up
function shutdown(): void {
  closeRpc();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
