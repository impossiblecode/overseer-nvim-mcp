import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { listTasks, run, waitForTask } from "../overseer.ts";
import { it, nodeCmd, stayAlive, trackTasks } from "./overseer.testkit.ts";

const track = trackTasks();

const TSX_CLI = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../../bin/overseer-nvim-mcp.ts", import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

it("waitForTask returns once the task exits, reporting its exit code", async () => {
  const { id } = await run({
    cmd: nodeCmd('console.log("done here"); process.exit(3)'),
    name: "mcp wait exit",
    settleMs: 0,
  });
  track(id);
  const res = await waitForTask(id, { timeoutMs: 10_000 });
  expect(res.waited).toBe("exited");
  expect(res.exit_code).toBe(3);
  expect(res.lines.join("\n")).toContain("done here");
});

it("waitForTask returns as soon as a line matches, without waiting for exit", async () => {
  const { id } = await run({
    cmd: nodeCmd(`console.log("server ready"); ${stayAlive}`),
    name: "mcp wait match",
    settleMs: 0,
  });
  track(id);
  const res = await waitForTask(id, { match: "server ready", timeoutMs: 10_000 });
  expect(res.waited).toBe("matched");
  expect(res.exit_code).toBeUndefined();
});

it("waitForTask reports a timeout rather than hanging", async () => {
  const { id } = await run({ cmd: nodeCmd(stayAlive), name: "mcp wait timeout", settleMs: 0 });
  track(id);
  const res = await waitForTask(id, { match: "never appears", timeoutMs: 300 });
  expect(res.waited).toBe("timeout");
});

it("the wait CLI exits with the task's own exit code and prints its output", async () => {
  const { id } = await run({
    cmd: nodeCmd('console.log("cli saw this"); process.exit(4)'),
    name: "mcp wait cli",
    settleMs: 0,
  });
  track(id);
  const { code, stdout } = await runCli(["wait", String(id)]);
  expect(code).toBe(4);
  expect(stdout).toContain("cli saw this");
  expect(stdout).toContain("exit_code=4");
});

it("the wait CLI exits 125 and says so when the selector matches nothing", async () => {
  const { code, stderr } = await runCli(["wait", "no such task anywhere"]);
  expect(code).toBe(125);
  expect(stderr).toMatch(/no task matched/);
});

// wait polls every 250ms and the shortest dispose_timeout is 1s, so wait sees
// the exit first. Breaks if the poll interval grows or dispose goes sub-second.
it("auto-disposal cannot take a finished task's output from a wait in flight", async () => {
  const { id } = await run({
    cmd: nodeCmd('setTimeout(() => { console.log("late output"); process.exit(5); }, 600)'),
    name: "mcp wait vs dispose",
    settleMs: 0,
    disposeTimeout: 1,
  });
  track(id);

  const res = await waitForTask(id, { timeoutMs: 10_000 });
  expect(res.waited).toBe("exited");
  expect(res.exit_code).toBe(5);
  expect(res.lines.join("\n")).toContain("late output");

  const deadline = Date.now() + 8000;
  let gone = false;
  while (Date.now() < deadline && !gone) {
    gone = !(await listTasks()).some((t) => t.id === id);
    if (!gone) await new Promise((r) => setTimeout(r, 100));
  }
  expect(gone).toBe(true);
});
