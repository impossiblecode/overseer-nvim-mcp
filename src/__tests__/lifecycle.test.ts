import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { it } from "./overseer.testkit.js";

const TSX_CLI = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../../bin/overseer-nvim-mcp.ts", import.meta.url));

function send(child: ChildProcess, msg: object): void {
  child.stdin!.write(`${JSON.stringify(msg)}\n`);
}

function responseWithId(child: ChildProcess, id: number): Promise<unknown> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.id === id) {
        rl.close();
        resolve(msg);
      }
    });
  });
}

it("server exits when the client hangs up, even with the nvim socket open", async () => {
  const child = spawn(process.execPath, [TSX_CLI, BIN], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lifecycle-test", version: "0" },
      },
    });
    await responseWithId(child, 1);
    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

    // getRpc connects lazily, so a real tool call is what opens the nvim socket.
    send(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "overseer_list_tasks", arguments: {} },
    });
    await responseWithId(child, 2);

    child.stdin!.end();
    const exited = Promise.race([
      once(child, "exit").then(([code]) => code),
      new Promise((r) => setTimeout(() => r("still running"), 4000)),
    ]);
    expect(await exited).toBe(0);
  } finally {
    child.kill("SIGKILL");
  }
}, 20000);
