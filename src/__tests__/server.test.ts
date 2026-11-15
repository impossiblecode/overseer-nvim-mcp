import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "vitest";
import { buildServer, INSTRUCTIONS, nodeCommand } from "../server.js";

// What the client actually receives. The private field is the only
// observable short of a full transport handshake.
const instructionsOf = (s: McpServer) =>
  (s.server as unknown as { _instructions?: string })._instructions;

function withNvim<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.NVIM;
  try {
    if (value === undefined) delete process.env.NVIM;
    else process.env.NVIM = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NVIM;
    else process.env.NVIM = saved;
  }
}

test("ships instructions to the client when inside nvim", () => {
  const server = withNvim("/tmp/fake-nvim.sock", () => buildServer());
  expect(instructionsOf(server)).toBe(INSTRUCTIONS);
});

test("withholds instructions when $NVIM is unset, since there are no tools", () => {
  const server = withNvim(undefined, () => buildServer());
  expect(instructionsOf(server)).toBeUndefined();
});

test("instructions state when to use the server, not how each tool works", () => {
  // The lifetime boundary is the one thing no individual tool description is in
  // a position to say, so it must survive any future edit to this text.
  expect(INSTRUCTIONS).toMatch(/overseer_run/);
  expect(INSTRUCTIONS).toMatch(/shell/i);
  expect(INSTRUCTIONS).toMatch(/wait_for/);
  expect(INSTRUCTIONS).toMatch(/origin/);
});

// The only place the model can learn the wait CLI exists.
test("instructions point at the wait subcommand, and say to background it", () => {
  expect(INSTRUCTIONS).toMatch(/wait <task>/);
  expect(INSTRUCTIONS).toMatch(/background/i);
  expect(INSTRUCTIONS).toMatch(/--match/);
  expect(INSTRUCTIONS).toMatch(/--lines/);
});

// INSTRUCTIONS is built once at startup, so the node it names has to survive a
// node upgrade while the server runs.
describe("nodeCommand", () => {
  const resolved = "/opt/node/versions/vN/bin/node";
  const onDisk = (paths: string[]) => (p: string) => paths.includes(p);

  test("returns the PATH entry, not the path it resolves to", () => {
    const isExec = onDisk(["/usr/local/bin/node"]);
    expect(nodeCommand("node", resolved, "/nope:/usr/local/bin:/usr/bin", isExec)).toBe(
      "/usr/local/bin/node",
    );
  });

  test("keeps an absolute argv0 as given", () => {
    expect(nodeCommand("/usr/local/bin/node", resolved, "", () => false)).toBe(
      "/usr/local/bin/node",
    );
  });

  test("falls back to execPath when PATH has no match", () => {
    expect(nodeCommand("node", resolved, "/usr/bin", () => false)).toBe(resolved);
  });
});

// Prompts are a user surface: clients render them as slash commands and never
// offer them to the model. So anything an *agent* needs in order not to fail has
// to be here, where it can actually see it. This was found the hard way: an
// agent told a user a persistent task was impossible, because the only place
// that said otherwise was a prompt it could not reach.
test("instructions carry the agent-failure knowledge that prompts cannot reach", () => {
  // The persistent-vs-transient distinction. Without it, "most repos declare no
  // templates, pass cmd" reads as the whole answer.
  expect(INSTRUCTIONS).toMatch(/register_template/);
  expect(INSTRUCTIONS).toMatch(/\.nvim\.lua/);
  expect(INSTRUCTIONS).toMatch(/exrc/);

  // The silent-ignore trap: an agent that reads the absence as a failed edit
  // will retry forever, because there is no error to catch.
  expect(INSTRUCTIONS).toMatch(/restart/i);
  expect(INSTRUCTIONS).toMatch(/memoized/);
  expect(INSTRUCTIONS).toMatch(/failed edit/);

  // And a pointer to the diagnostics, since an empty list is where the agent
  // gets stuck first.
  expect(INSTRUCTIONS).toMatch(/diagnose/);
});

test("registers zero tools when $NVIM is unset", () => {
  const saved = process.env.NVIM;
  try {
    delete process.env.NVIM;
    const names: string[] = [];
    const server = buildServer((n) => names.push(n));
    expect(names).toEqual([]);
    expect(server).toBeDefined();
  } finally {
    if (saved !== undefined) process.env.NVIM = saved;
  }
});

test("registers tools when $NVIM is set", () => {
  const saved = process.env.NVIM;
  try {
    process.env.NVIM = "/tmp/fake-nvim.sock";
    const names: string[] = [];
    buildServer((n) => names.push(n));
    expect(names.length).toBe(7);
  } finally {
    if (saved === undefined) delete process.env.NVIM;
    else process.env.NVIM = saved;
  }
});

// Same private-field story as instructionsOf above.
const toolsOf = (s: McpServer) =>
  (
    s as unknown as {
      _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }>;
    }
  )._registeredTools;

// Annotation-aware clients (codex among them) auto-approve tools marked
// read-only and prompt for the rest. Both directions matter: a missing hint
// costs a needless prompt, but a wrong hint on a mutating tool silently
// removes a user consent gate.
test("read-only tools carry readOnlyHint; mutating tools never do", () => {
  const tools = withNvim("/tmp/fake-nvim.sock", () => toolsOf(buildServer()));
  for (const name of ["overseer_list_tasks", "overseer_list_templates", "overseer_tail"]) {
    expect(tools[name]?.annotations?.readOnlyHint, name).toBe(true);
  }
  for (const name of ["overseer_run", "overseer_stop", "overseer_restart", "overseer_dispose"]) {
    expect(tools[name]?.annotations?.readOnlyHint, name).toBeUndefined();
  }
});
