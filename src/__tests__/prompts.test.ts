import { getCompleter } from "@modelcontextprotocol/sdk/server/completable.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, test } from "vitest";
import { registerPrompts } from "../prompts.js";
import { it } from "./overseer.testkit.js";

type PromptCb = (args: Record<string, string>) => Promise<{
  messages: { content: { text: string } }[];
}>;

/** Whatever getCompleter accepts, without reaching into the SDK's internals. */
type Schema = Parameters<typeof getCompleter>[0];
type Entry = { description?: string; argsSchema: Record<string, Schema>; cb: PromptCb };

/** Capture registrations so a handler can be invoked without a transport. */
function capture(): Map<string, Entry> {
  const server = new McpServer({ name: "t", version: "0" });
  const found = new Map<string, Entry>();
  server.registerPrompt = ((
    name: string,
    config: { description?: string; argsSchema?: Record<string, Schema> },
    cb: PromptCb,
  ) => {
    found.set(name, { description: config.description, argsSchema: config.argsSchema ?? {}, cb });
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

it("diagnose completes cwd with the directories that are actually in play", async () => {
  const completer = getCompleter(capture().get("diagnose")!.argsSchema.cwd);
  expect(completer, "cwd argument is not completable").toBeDefined();

  const all = (await completer!("")) as string[];
  // nvim's cwd and the server's, deduped when they coincide: exactly the
  // pair the caller needs, since providers search both.
  expect(all.length).toBeGreaterThan(0);
  expect(new Set(all).size).toBe(all.length);
  expect(all.every((d) => d.startsWith("/"))).toBe(true);

  // Filters on what has been typed, and offers nothing rather than everything
  // when nothing matches.
  expect(await completer!("/zzz-definitely-not-a-prefix")).toEqual([]);
  expect(await completer!(all[0]!.slice(0, 4))).toContain(all[0]);
});

it("diagnose flags a searched dir that differs from nvim's cwd", async () => {
  const text = await render("diagnose", { cwd: "/tmp" });
  // Providers search nvim's cwd too, which is how another project's tasks show
  // up unexplained. The mismatch has to be visible.
  expect(text).toContain("differs from searched");
});
