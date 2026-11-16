import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, expect } from "vitest";
import { listTasks, run } from "../overseer.ts";
import { it, nodeCmd, stayAlive, trackTasks } from "./overseer.testkit.ts";

// The SDK client rejects resultType "task", so the 2026 side speaks raw
// JSON-RPC over the stdio transport.

const track = trackTasks();

const TSX_CLI = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../../bin/overseer-nvim-mcp.ts", import.meta.url));
const TASKS = "io.modelcontextprotocol/tasks";

type Message = { id?: number | string; result?: Record<string, unknown>; error?: unknown };

const transports: StdioClientTransport[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.close()));
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function spawnServer(): StdioClientTransport {
  const env = getDefaultEnvironment();
  env.NVIM = process.env.NVIM!;
  const t = new StdioClientTransport({ command: process.execPath, args: [TSX_CLI, BIN], env });
  transports.push(t);
  return t;
}

async function rawSession(extensions: Record<string, object>) {
  const transport = spawnServer();
  const pending = new Map<number | string, (m: Message) => void>();
  transport.onmessage = (m) => {
    const msg = m as Message;
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  };
  await transport.start();
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "wire-test", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": { extensions },
  };
  let next = 0;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Message>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      void transport.send({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } });
    });
  return request;
}

it("a 2026 client that declares tasks gets a task, then the outcome via tasks/get", async () => {
  const { id } = await run({ cmd: nodeCmd(stayAlive), name: "mcp wire task", settleMs: 0 });
  track(id);
  const request = await rawSession({ [TASKS]: {} });

  const discover = await request("server/discover", {});
  const caps = discover.result?.capabilities as { extensions?: Record<string, unknown> };
  expect(caps.extensions?.[TASKS]).toBeDefined();

  const call = await request("tools/call", {
    name: "overseer_wait",
    arguments: { task: id, match: "listening on port \\d+" },
  });
  expect(call.result).toMatchObject({ resultType: "task", status: "working" });
  const taskId = call.result?.taskId as string;
  // Claude Code refuses anything else as a malformed task handle
  expect(taskId).toMatch(/^[\x21-\x7e]{1,128}$/);
  expect(typeof call.result?.pollIntervalMs).toBe("number");
  // the only start-time text Claude Code shows the model
  const meta = call.result?._meta as Record<string, { modelImmediateResponse?: string }>;
  expect(meta["com.anthropic/agent-task"]?.modelImmediateResponse).toContain(`task ${id}`);

  const got = await request("tasks/get", { taskId });
  expect(got.result).toMatchObject({ resultType: "complete", taskId, status: "working" });

  const cancelled = await request("tasks/cancel", { taskId });
  expect(cancelled.error).toBeUndefined();
  const after = await request("tasks/get", { taskId });
  expect(after.result).toMatchObject({ status: "cancelled" });
}, 20000);

const text = (m: Message) => (m.result?.content as { text: string }[] | undefined)?.[0]?.text ?? "";
const resultText = (m: Message) =>
  (m.result?.result as { content: { text: string }[] } | undefined)?.content[0]?.text ?? "";

it("overseer_run with wait returns a task that ends when the task is stopped", async () => {
  const request = await rawSession({ [TASKS]: {} });
  const call = await request("tools/call", {
    name: "overseer_run",
    arguments: { cmd: nodeCmd(stayAlive), name: "mcp wire run follow", wait: true, settle_ms: 0 },
  });
  expect(call.result).toMatchObject({ resultType: "task", status: "working" });
  const meta = call.result?._meta as Record<string, { modelImmediateResponse: string }>;
  const note = meta["com.anthropic/agent-task"]!.modelImmediateResponse;
  const id = Number(/overseer task (\d+)/.exec(note)?.[1]);
  track(id);
  const taskId = call.result?.taskId as string;
  expect((await request("tasks/get", { taskId })).result).toMatchObject({ status: "working" });

  await request("tools/call", { name: "overseer_stop", arguments: { task: id } });
  const done = await request("tasks/get", { taskId });
  expect(done.result).toMatchObject({ status: "completed" });
  expect(resultText(done)).toContain("waited=stopped");
}, 20000);

it("overseer_restart with wait ends the earlier task as restarted by the agent and follows anew", async () => {
  const request = await rawSession({ [TASKS]: {} });
  const first = await request("tools/call", {
    name: "overseer_run",
    arguments: {
      cmd: nodeCmd(stayAlive),
      name: "mcp wire restart follow",
      wait: true,
      settle_ms: 0,
    },
  });
  const meta = first.result?._meta as Record<string, { modelImmediateResponse: string }>;
  const id = Number(
    /overseer task (\d+)/.exec(meta["com.anthropic/agent-task"]!.modelImmediateResponse)?.[1],
  );
  track(id);

  const second = await request("tools/call", {
    name: "overseer_restart",
    arguments: { task: id, wait: true },
  });
  expect(second.result).toMatchObject({ resultType: "task" });

  const old = await request("tasks/get", { taskId: first.result?.taskId as string });
  expect(resultText(old)).toContain("waited=restarted");
  expect(resultText(old)).toContain("overseer_restart");
  const fresh = await request("tasks/get", { taskId: second.result?.taskId as string });
  expect(fresh.result).toMatchObject({ status: "working" });
}, 20000);

it("overseer_run with wait on a task that exits during settle_ms returns the result, no task", async () => {
  const request = await rawSession({ [TASKS]: {} });
  const call = await request("tools/call", {
    name: "overseer_run",
    arguments: {
      cmd: nodeCmd("process.exit(0)"),
      name: "mcp wire run quick",
      wait: true,
      settle_ms: 3000,
    },
  });
  expect(call.result?.resultType).toBe("complete");
  expect(text(call)).toContain("exit_code=0");
  const id = Number(/"id": (\d+)/.exec(text(call))?.[1] ?? /task (\d+)/.exec(text(call))?.[1]);
  if (id) track(id);
}, 20000);

it("overseer_run with wait on a client without tasks returns the CLI command", async () => {
  const request = await rawSession({});
  const call = await request("tools/call", {
    name: "overseer_run",
    arguments: { cmd: nodeCmd(stayAlive), name: "mcp wire run no-ext", wait: true, settle_ms: 0 },
  });
  expect(call.result?.resultType).toBe("complete");
  const id = Number(/ wait (\d+)/.exec(text(call))?.[1]);
  expect(id).toBeGreaterThan(0);
  track(id);
}, 20000);

it("overseer_run rejects a bad match before starting anything", async () => {
  const request = await rawSession({ [TASKS]: {} });
  for (const [label, match] of [
    ["invalid", "("],
    ["too long", "x".repeat(200)],
  ] as const) {
    const name = `mcp wire bad match ${label}`;
    const call = await request("tools/call", {
      name: "overseer_run",
      arguments: { cmd: nodeCmd(stayAlive), name, match, settle_ms: 0 },
    });
    expect(call.result?.isError, label).toBe(true);
    const leftover = (await listTasks()).filter((t) => t.name === name);
    for (const t of leftover) track(t.id);
    expect(leftover, label).toEqual([]);
  }
}, 20000);

it("a 2026 client without the extension gets the CLI command", async () => {
  const { id } = await run({ cmd: nodeCmd(stayAlive), name: "mcp wire no-ext", settleMs: 0 });
  track(id);
  const request = await rawSession({});
  const call = await request("tools/call", { name: "overseer_wait", arguments: { task: id } });
  expect(call.result?.resultType).toBe("complete");
  const text = (call.result!.content as { text: string }[])[0]!.text;
  expect(text).toContain(` wait ${id}`);
}, 20000);

it("a legacy client gets the CLI command too", async () => {
  const { id } = await run({ cmd: nodeCmd(stayAlive), name: "mcp wire legacy", settleMs: 0 });
  track(id);
  const client = new Client({ name: "wire-test", version: "0" });
  clients.push(client);
  await client.connect(spawnServer());
  expect(client.getProtocolEra()).toBe("legacy");
  const res = await client.callTool({ name: "overseer_wait", arguments: { task: id } });
  const text = (res.content as { text: string }[])[0]!.text;
  expect(text).toContain(` wait ${id}`);
  expect(res.isError).toBeFalsy();
}, 20000);
