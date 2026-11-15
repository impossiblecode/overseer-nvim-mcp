import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, test } from "vitest";
import { it } from "./overseer.testkit.js";

const TSX_CLI = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../../bin/overseer-nvim-mcp.ts", import.meta.url));

// pinned, so a server that can't speak 2026 fails instead of falling back to 2025
const ERAS = [
  { era: "legacy", options: {} },
  { era: "modern", options: { versionNegotiation: { mode: { pin: "2026-07-28" } } } },
] as const;

const TOOLS = [
  "overseer_dispose",
  "overseer_list_tasks",
  "overseer_list_templates",
  "overseer_restart",
  "overseer_run",
  "overseer_stop",
  "overseer_tail",
];

const open: Client[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

async function connect(options: object, nvim: string | undefined): Promise<Client> {
  // the default env has no NVIM
  const env = getDefaultEnvironment();
  if (nvim) env.NVIM = nvim;
  const client = new Client({ name: "handshake-test", version: "0" }, options);
  open.push(client);
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [TSX_CLI, BIN], env }),
  );
  return client;
}

describe.each(ERAS)("$era opening", ({ era, options }) => {
  it("serves the tools, prompts, resources and instructions inside nvim", async () => {
    const client = await connect(options, process.env.NVIM);
    expect(client.getProtocolEra()).toBe(era);
    expect(client.getInstructions()).toContain("overseer_run");

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(TOOLS);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["diagnose", "directory_local_task"]);
    expect((await client.listResources()).resources.map((r) => r.uri)).toContain(
      "overseer://tasks",
    );

    const listed = await client.callTool({ name: "overseer_list_tasks", arguments: {} });
    expect(listed.isError).toBeFalsy();
  }, 20000);

  test("advertises nothing and withholds instructions when $NVIM is unset", async () => {
    const client = await connect(options, undefined);
    expect(client.getProtocolEra()).toBe(era);
    expect(client.getInstructions()).toBeUndefined();

    const caps = client.getServerCapabilities() ?? {};
    expect(caps.tools).toBeUndefined();
    expect(caps.prompts).toBeUndefined();
    expect(caps.resources).toBeUndefined();
    // listTools() returns [] without asking when the capability is missing
    await expect(client.request({ method: "tools/list", params: {} })).rejects.toMatchObject({
      code: -32601,
    });
  }, 20000);
});
