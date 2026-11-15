import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { expect, test } from "vitest";
import { registerPrompts } from "../prompts.ts";
import { it } from "./overseer.testkit.ts";

type PromptCb = (args: Record<string, string>) => Promise<{
  messages: { content: { text: string } }[];
}>;

type Entry = { description?: string; cb: PromptCb };

/** Capture registrations so a handler can be invoked without a transport. */
function capture(): Map<string, Entry> {
  const server = new McpServer({ name: "t", version: "0" });
  const found = new Map<string, Entry>();
  server.registerPrompt = ((name: string, config: { description?: string }, cb: PromptCb) => {
    found.set(name, { description: config.description, cb });
    return undefined as never;
  }) as never;
  registerPrompts(server);
  return found;
}

const render = async (name: string, args: Record<string, string> = {}) => {
  const entry = capture().get(name);
  if (!entry) throw new Error(`no prompt named ${name}`);
  return (await entry.cb(args)).messages[0]!.content.text;
};

test("registers the user-invocable prompts, each with a description", () => {
  const prompts = capture();
  expect([...prompts.keys()].sort()).toEqual(["diagnose", "directory_local_task"]);
  for (const [name, p] of prompts) {
    expect(p.description, `${name} has no description`).toBeTruthy();
  }
});

it("directory_local_task scaffolds the register_template recipe with the given command", async () => {
  const text = await render("directory_local_task", { name: "seed db", cmd: "psql < seed.sql" });
  expect(text).toContain("register_template");
  expect(text).toContain('"seed db"');
  // condition.dir is what stops the template following the user after a :cd,
  // so it must survive any edit to the snippet.
  expect(text).toContain("condition = { dir = vim.fn.getcwd() }");
  // The two things that make a correct setup look broken.
  expect(text).toMatch(/restart/i);
  expect(text).toMatch(/trust/i);
});

it("directory_local_task reports the live exrc state rather than assuming it", async () => {
  const text = await render("directory_local_task", { name: "x", cmd: "true" });
  // Whichever way it goes, it must commit to one and not hedge.
  const on = text.includes("`exrc` is already on");
  const off = text.includes("**`exrc` is currently off**");
  expect(on !== off, "prompt must state exrc as either on or off").toBe(true);
  if (off) expect(text).toContain("vim.o.exrc = true");
});

it("diagnose reports why each provider found nothing", async () => {
  const text = await render("diagnose");
  expect(text).toMatch(/templates found: \d+/);
  expect(text).toMatch(/exrc: (on|off)/);
  // The per-provider reasons are the whole point: without them the caller
  // cannot tell "no Makefile here" from "make is not installed".
  expect(text).toMatch(/- `npm`: \d+\/\d+ available/);
  expect(text).toMatch(/No .* found|not found/);
});

async function completeCwd(): Promise<(value: string) => Promise<string[]>> {
  const server = new McpServer({ name: "t", version: "0" });
  registerPrompts(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientSide);
  // a completer the SDK can't find drops the capability silently
  expect(client.getServerCapabilities()?.completions, "completions not advertised").toBeDefined();
  return async (value) =>
    (
      await client.complete({
        ref: { type: "ref/prompt", name: "diagnose" },
        argument: { name: "cwd", value },
      })
    ).completion.values;
}

it("diagnose completes cwd with the directories that are actually in play", async () => {
  const completer = await completeCwd();

  const all = await completer("");
  // nvim's cwd and the server's, deduped when they coincide: exactly the
  // pair the caller needs, since providers search both.
  expect(all.length).toBeGreaterThan(0);
  expect(new Set(all).size).toBe(all.length);
  expect(all.every((d) => d.startsWith("/"))).toBe(true);

  // Filters on what has been typed, and offers nothing rather than everything
  // when nothing matches.
  expect(await completer("/zzz-definitely-not-a-prefix")).toEqual([]);
  expect(await completer(all[0]!.slice(0, 4))).toContain(all[0]);
});

it("diagnose flags a searched dir that differs from nvim's cwd", async () => {
  const text = await render("diagnose", { cwd: "/tmp" });
  // Providers search nvim's cwd too, which is how another project's tasks show
  // up unexplained. The mismatch has to be visible.
  expect(text).toContain("differs from searched");
});
