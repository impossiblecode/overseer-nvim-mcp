import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as overseer from "./overseer.js";

const selector = z.union([z.number().int(), z.string().min(1)]);

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function guard(fn: () => Promise<string>): Promise<ToolResult> {
  return fn().then(
    (text) => ({ content: [{ type: "text" as const, text }] }),
    (e: unknown) => ({
      content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
      isError: true,
    }),
  );
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * Render a tail as a status header plus the raw lines. Plain text because the
 * output is the payload; JSON-escaping every newline helps nobody. Exported
 * for tests.
 */
export function formatTail(res: overseer.TailResult): string {
  const header = [
    `status=${res.status}`,
    res.exit_code === undefined ? null : `exit_code=${res.exit_code}`,
    `total=${res.total}`,
    res.lines.length > 0 ? `from=${res.from}` : null,
    res.waited === undefined ? null : `waited=${res.waited}`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  return res.lines.length > 0 ? `${header}\n${res.lines.join("\n")}` : header;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "overseer_list_tasks",
    {
      title: "List overseer tasks",
      description:
        "List running and completed overseer.nvim tasks (id, name, status), newest first. " +
        "`origin` is 'agent' for tasks this server started and 'user' for the ones they started " +
        "themselves; only clean up your own.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => json(await overseer.listTasks())),
  );

  server.registerTool(
    "overseer_list_templates",
    {
      title: "List runnable overseer templates",
      description:
        "List task templates overseer discovers in a directory (npm scripts, go-task, make, just, " +
        "VS Code tasks, etc). An empty list is normal (many repos declare nothing runnable); use " +
        "overseer_run with a raw cmd instead. " +
        "Each entry has `provider` (which task runner it came from) and `desc`, which is null when " +
        "that provider supplies no descriptions (npm and make never do, go-task and just usually " +
        "do), so a null desc means there is nothing to read, not that something was withheld. " +
        "Entries that have a description are listed first. " +
        "`params` lists arguments a template takes, with `required` marking those that overseer_run " +
        "will reject the call without. `running_task_id` is present when a task of that name is " +
        "already running, which is your signal not to start a second one. " +
        "Pass `filter` to match a substring against name and desc; worth doing in a large " +
        "monorepo, where this can return well over eighty entries.",
      inputSchema: { cwd: z.string().optional(), filter: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    (args) => guard(async () => json(await overseer.listTemplates(args.cwd, args.filter))),
  );

  server.registerTool(
    "overseer_tail",
    {
      title: "Tail overseer task output",
      description:
        "Return a task's live output, preceded by a status line. `task` is a numeric id or a " +
        "case-insensitive name substring; omit it for the most recent task. " +
        "The status line reports `status`, `exit_code` once the task has exited, and `total` " +
        "(lines available so far), so you never need a separate overseer_list_tasks to find out " +
        "whether what you are tailing is still alive. " +
        "Pass the previous `total` back as `since` to get only what is new instead of re-reading " +
        "the same lines; `from` tells you where the returned block actually starts, and a `from` " +
        "greater than `since` + 1 means output scrolled past between calls. " +
        "Set `wait_for` to a regular expression to block until a matching line appears; use it " +
        "instead of polling repeatedly. It returns as soon as it matches, or when the task exits, " +
        "or at `timeout_ms` (default 15000, max 120000), and reports which of the three happened " +
        "as `waited`, so a timeout is never mistaken for success.",
      inputSchema: {
        task: selector.optional(),
        lines: z.number().int().positive().optional(),
        since: z.number().int().nonnegative().optional(),
        wait_for: z.string().optional(),
        timeout_ms: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(async () => {
        const res = await overseer.tail(args.task ?? null, {
          lines: args.lines,
          since: args.since,
          waitFor: args.wait_for,
          timeoutMs: args.timeout_ms,
        });
        return formatTail(res);
      }),
  );

  server.registerTool(
    "overseer_run",
    {
      title: "Run a command as an overseer task",
      description:
        "Start a long-running command as an overseer task, so it appears in the user's task list, " +
        "can be stopped from it, and inherits proper process-group teardown. " +
        "Use for commands that DO NOT exit on their own: dev servers, file watchers, --watch test " +
        "runs, log tails. For short commands that terminate by themselves, use Bash instead: you need " +
        "their output in-band, and round-tripping a fast build through start-then-poll is worse. " +
        "Pass exactly one of `template` or `cmd`. Prefer `template` (a name from overseer_list_templates) " +
        "when one matches what you want; it runs the repo's own definition under the name the user " +
        "already sees in their task list. Most repos declare no templates, in which case pass `cmd` " +
        "as an argv array, which works anywhere. Note a `cmd` is a one-off, though: gone when the " +
        "session ends, and the user cannot run it again without you. If they want it to persist, it " +
        "belongs in a directory-local template instead of being re-passed as `cmd` every time; " +
        "the server instructions describe how. `cmd` does not go through a shell, so for pipes, " +
        'globs, `&&` or env prefixes pass an explicit wrapper: ["sh", "-c", "..."]. ' +
        "Returns once the task has produced output or exited, up to `settle_ms` (default 1500, " +
        "0 to return immediately), so a command that dies on startup reports its failure here " +
        "rather than looking identical to a healthy one until some later tail. " +
        "Templates that declare `params` need them supplied here; pass `params` as an object of " +
        "name to value. A missing required param comes back as an error naming what it wanted " +
        "rather than a prompt opening in the editor.",
      inputSchema: {
        cmd: z.array(z.string()).optional(),
        template: z.string().optional(),
        name: z.string().optional(),
        cwd: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        settle_ms: z.number().int().nonnegative().optional(),
      },
      annotations: { destructiveHint: false },
    },
    (args) => guard(async () => json(await overseer.run({ ...args, settleMs: args.settle_ms }))),
  );

  server.registerTool(
    "overseer_restart",
    {
      title: "Restart an overseer task",
      description:
        "Restart a task by id or name substring (stops it first if running). " +
        "A name matching more than one task is an error listing the candidates; pass a numeric " +
        "id instead. Running tasks the user started are refused unless `force` is set.",
      inputSchema: { task: selector, force: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    (args) => guard(async () => json(await overseer.restart(args.task, args.force))),
  );

  server.registerTool(
    "overseer_stop",
    {
      title: "Stop an overseer task",
      description:
        "Stop a running task by id or name substring. Overseer stops the underlying nvim job, " +
        "so the task's process tree is torn down rather than left orphaned. " +
        "A name matching more than one task is an error listing the candidates. Running tasks the " +
        "user started are refused unless `force` is set, since a substring like 'dev' can match theirs.",
      inputSchema: { task: selector, force: z.boolean().optional() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) => guard(async () => json(await overseer.stop(args.task, args.force))),
  );

  server.registerTool(
    "overseer_dispose",
    {
      title: "Dispose an overseer task",
      description:
        "Stop (if running) and remove a task from the list by id or name substring. " +
        "Disposing a finished task is unguarded; a running one the user started is refused " +
        "unless `force` is set. A name matching more than one task is an error.",
      inputSchema: { task: selector, force: z.boolean().optional() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) => guard(async () => json(await overseer.dispose(args.task, args.force))),
  );
}
