import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as overseer from "./overseer.js";

/**
 * User-invoked prompts, shown by clients as slash commands. Not callable by
 * the model; generated per invocation, so they can read live editor state.
 */

const reply = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

// Built with repeat: three literal backticks inside a template literal here
// would terminate it early.
const FENCE = "`".repeat(3);
const fence = (lang: string, body: string) => [`${FENCE}${lang}`, body, FENCE].join("\n");

function localTaskSnippet(name: string, cmd: string): string {
  const argv = JSON.stringify(cmd.split(/\s+/).filter(Boolean))
    .replace(/^\[/, "{ ")
    .replace(/\]$/, " }")
    .replace(/"/g, '"');
  return fence(
    "lua",
    `-- .nvim.lua, in the project root
require("overseer").register_template({
  name = ${JSON.stringify(name)},
  -- Scopes the template to this directory, so it does not follow you after :cd
  condition = { dir = vim.fn.getcwd() },
  builder = function()
    return { cmd = ${argv} }
  end,
})`,
  );
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "directory_local_task",
    {
      title: "Add a directory-local overseer task",
      description:
        "Define a persistent task for this project without any task runner: no npm script, " +
        "Makefile or Taskfile. Uses overseer's own register_template via a .nvim.lua that stays " +
        "out of version control if you want it to.",
      argsSchema: {
        name: z.string().describe("Name the task will appear under in the task list"),
        cmd: z.string().describe("Shell command to run, e.g. 'psql < seed.sql'"),
      },
    },
    async ({ name, cmd }) => {
      const d = await overseer.diagnose().catch(() => null);
      const parts: string[] = [
        `Add a directory-local overseer task called ${JSON.stringify(name)} running \`${cmd}\`.`,
        "",
        "This is overseer's own `exrc` recipe (`:h overseer`, recipes section), which needs no task " +
          "runner and no provider:",
        "",
        localTaskSnippet(name, cmd),
      ];

      if (d && !d.exrc) {
        parts.push(
          "",
          "**`exrc` is currently off**, so nvim will not read that file. It needs this in " +
            "init.lua first:",
          "",
          fence("lua", "vim.o.exrc = true"),
        );
      } else if (d) {
        parts.push("", "`exrc` is already on, so nvim will read the file at startup.");
      }

      if (d?.has_nvim_lua) {
        parts.push(
          "",
          "A `.nvim.lua` already exists here; append to it rather than overwriting it.",
        );
      }

      parts.push(
        "",
        "Two things that make this look broken when it is not:",
        "",
        "- **It will not appear until nvim restarts.** Overseer memoizes its provider list on " +
          "`runtimepath`, so a `register_template` after any template listing is silently " +
          "ignored, with no error and no task.",
        "- **nvim will ask you to `:trust` the file** on first load, and again whenever its " +
          "contents change.",
        "",
        "Decide whether to commit `.nvim.lua` or add it to `.gitignore`; overseer does not care " +
          "either way.",
      );

      return reply(parts.join("\n"));
    },
  );

  server.registerPrompt(
    "diagnose",
    {
      title: "Diagnose overseer task discovery",
      description:
        "Work out why overseer is not showing the tasks you expect, or why a task's output " +
        "looks empty. Reports what each provider actually tried and why it found nothing.",
      argsSchema: {
        // "I was looking at the wrong directory" is the most common thing this
        // prompt discovers; offering nvim's cwd and the client's up front
        // pre-empts the diagnosis.
        cwd: completable(
          z.string().optional().describe("Directory to inspect; defaults to the server's"),
          async (value) => {
            const nvim = await overseer.nvimCwd().catch(() => null);
            const candidates = [...new Set([nvim, process.cwd()].filter((d) => d !== null))];
            return candidates.filter((d) => d.startsWith(value ?? ""));
          },
        ),
      },
    },
    async ({ cwd }) => {
      const d = await overseer.diagnose(cwd || undefined);

      const providerLines = d.providers.length
        ? d.providers.map((p) => {
            const why = p.message ? ` - ${p.message}` : "";
            const cached = p.from_cache ? " (cached)" : "";
            return `- \`${p.name}\`: ${p.available}/${p.total} available${cached}${why}`;
          })
        : ["- (no providers reported)"];

      const parts = [
        "Here is the live state of overseer's task discovery. Explain what it means and what " +
          "to do next.",
        "",
        `- searched: \`${d.dir}\``,
        `- nvim cwd: \`${d.nvim_cwd}\`${d.dir === d.nvim_cwd ? "" : " (differs from searched)"}`,
        `- templates found: ${d.templates}`,
        `- tasks running: ${d.tasks_running}`,
        `- exrc: ${d.exrc ? "on" : "off"}`,
        `- .nvim.lua present: ${d.has_nvim_lua ? "yes" : "no"}`,
        d.timed_out ? "- **the listing timed out**, so the above is incomplete" : null,
        "",
        "Per provider, and the reason each one contributed nothing:",
        "",
        ...providerLines,
        "",
        "Known causes, in the order they actually bite:",
        "",
        '1. **The provider\'s binary is missing.** A provider reporting `Command "X" not found` ' +
          "is not broken; overseer will not offer tasks it has no way to run. Likewise " +
          "`No <file> found` just means that runner has nothing to read here.",
        "2. **npm searches upward and prefers the nearest package.json _with a lockfile_.** In a " +
          "nested directory this silently resolves to the parent project instead, so you see the " +
          "wrong repo's scripts and none of your own.",
        "3. **A `register_template` after any listing is ignored**, because the provider list is " +
          "memoized on `runtimepath`. Re-sourcing `.nvim.lua` by hand does nothing. Restart nvim.",
        "4. **`condition.dir` scopes a template to a directory tree.** If it was registered with " +
          "a different path (or a symlinked one, which macOS `/tmp` is), it will never match.",
        "5. **Results can be cached.** A provider marked `(cached)` above did not re-run; " +
          "overseer clears its cache on `BufWritePost`, so saving the task file refreshes it.",
        "6. **A template with a `condition.filetype` is never visible here.** Overseer matches " +
          "filetype against the focused buffer's, and this server supplies none: " +
          "an agent has no current file, and inheriting whichever buffer you last clicked would " +
          "make the same call resolve differently each time. Such a template still works from " +
          "the overseer picker in nvim; it just cannot be listed or run through MCP.",
        "",
        "If instead the problem is a task whose **output looks empty**: output from a task " +
          "started over RPC lives in the strategy's pending buffer rather than a terminal " +
          "buffer until the overseer panel is opened. `overseer_tail` reads both, so prefer it " +
          "over inspecting the buffer directly.",
      ].filter((line) => line !== null);

      return reply(parts.join("\n"));
    },
  );
}
