import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import { insideNvim } from "./nvim.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

/**
 * Returned in the initialize result; clients put it in the agent's system
 * prompt. Says when to reach for the server at all, which no single tool
 * description can.
 */
export const INSTRUCTIONS = `Long-running commands belong in overseer, not the shell.

Start dev servers, file watchers and --watch test runs with overseer_run. They
then appear in the user's own task list, the user can stop them from it, and
their process trees are torn down properly rather than orphaned when the session
ends. A command started in your shell tool has none of that, and the user cannot
see it at all.

Short commands that exit on their own stay on the shell: their output is
in-band there, which is what you want. Do not route a two-second build through
start-then-poll.

Before starting anything, call overseer_list_templates. If the repo declares a task
that matches, run it by name instead of reconstructing the command. If an entry
already has running_task_id, the user has it running; tail that rather than
starting a second one on top of it.

Use overseer_tail's wait_for to wait for a line to appear. Do not poll in a loop.

A raw cmd is a one-off: it lasts for this session and the user cannot run it
again without you. If the user wants a task that persists, and no runner entry
suits, register it directory-locally instead: require("overseer").
register_template in a .nvim.lua at the project root, scoped with
condition = { dir = vim.fn.getcwd() }. It needs vim.o.exrc = true, nvim will
prompt them to :trust the file, and it will NOT appear until nvim restarts,
because the provider list is memoized on runtimepath and a late
register_template is silently ignored. Do not read that absence as a failed edit
and do not retry it.

If overseer_list_templates comes back empty, or a task's output looks blank, the
causes are enumerated in the diagnose prompt; tell the user to run it rather
than guessing. Chief among them: the npm provider searches upward and prefers
the nearest package.json that has a lockfile, so in a monorepo you can silently
get the wrong package's scripts.

The task list is shared with the user. Tasks you started have origin "agent";
clean up only those.`;

/**
 * Build the server. When not inside nvim ($NVIM unset), register nothing:
 * the server exists but exposes no tools, so non-nvim sessions see nothing.
 * `onRegister` is a test seam for observing which tools were registered.
 */
export function buildServer(onRegister?: (name: string) => void): McpServer {
  const inside = insideNvim();
  const server = new McpServer(
    { name: "overseer", version: pkg.version },
    // Withheld outside nvim for the same reason the tools are: a session that
    // gets no tools should not be told how to use them.
    inside ? { instructions: INSTRUCTIONS } : undefined,
  );
  if (inside) {
    if (onRegister) {
      const orig = server.registerTool.bind(server);
      server.registerTool = (name: string, ...rest: unknown[]) => {
        onRegister(name);
        return orig(name, ...(rest as [never, never]));
      };
    }
    registerTools(server);
    // Prompts and resources are gated with the tools: outside nvim there is
    // nothing to describe and nothing to read.
    registerPrompts(server);
    registerResources(server);
  }
  return server;
}
