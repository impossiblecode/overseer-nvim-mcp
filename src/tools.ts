import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatTail } from "./format.ts";
import * as overseer from "./overseer.ts";
import {
  clientSupportsTasks,
  createTaskResult,
  startWait,
  validateMatch,
  type WaitArgs,
  waitCommand,
} from "./wait-task.ts";

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

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

function withoutSeq<T extends { seq: number }>(res: T): Omit<T, "seq"> {
  const { seq: _, ...rest } = res;
  return rest;
}

const followInputs = {
  wait: z.boolean().optional(),
  match: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  lines: z.number().int().positive().optional(),
};

type FollowArgs = { wait?: boolean; match?: string; timeout_ms?: number; lines?: number };
const following = (a: FollowArgs) => a.wait === true || a.match !== undefined;

/**
 * Follows the task until it ends: a task reply where the client has MCP tasks,
 * the `wait` command where it doesn't, and the result itself when it is
 * already decided. `head` names a task the call just started or restarted.
 */
async function followOrReturn(
  ctx: ServerContext,
  waitCli: string,
  args: WaitArgs,
  head?: string,
): Promise<ToolResult | ReturnType<typeof createTaskResult>> {
  try {
    const start = await startWait(args);
    const prefix = head === undefined ? "" : `${head}\n`;
    if ("done" in start) return text(prefix + formatTail(start.done));
    const id = start.pending.id;
    if (clientSupportsTasks(ctx)) {
      const until =
        args.match === undefined ? "when it ends" : `when a line matches ${args.match}, or it ends`;
      const note = `${prefix}${formatTail(start.tail)}\n\nFollowing overseer task ${id}: you will be notified ${until}.`;
      return createTaskResult(start.pending, start.tail, note);
    }
    return text(
      `${prefix}${formatTail(start.tail)}\n\n` +
        "This client does not support MCP tasks, so the wait cannot run in the background " +
        "here. Run this as a background shell command instead; it prints the same result " +
        "and exits with the task's exit code:\n\n" +
        `  ${waitCommand(waitCli, start.pending)}`,
    );
  } catch (e) {
    return {
      content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      isError: true,
    };
  }
}

/** `waitCli` is how this server's own `wait` subcommand is invoked. */
export function registerTools(server: McpServer, waitCli = "overseer-nvim-mcp"): void {
  server.registerTool(
    "overseer_list_tasks",
    {
      title: "List overseer tasks",
      description:
        "List running and completed overseer.nvim tasks (id, name, status), newest first. " +
        "`origin` is 'agent' for tasks this server started and 'user' for the ones they started " +
        "themselves; only clean up your own.",
      inputSchema: z.object({}),
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
      inputSchema: z.object({
        cwd: z
          .string()
          .optional()
          .describe("Directory to search; defaults to nvim's current working directory"),
        filter: z.string().optional(),
      }),
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
        "as `waited`, so a timeout is never mistaken for success. " +
        "`wait_for` is for a wait of a few seconds: it holds up the conversation for as long as " +
        "it waits. For anything longer, follow the task with overseer_run's `wait` or with " +
        "overseer_wait.",
      inputSchema: z.object({
        task: selector.optional(),
        lines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Trailing lines to return; default 10. Pass more when diagnosing a failure, " +
              "e.g. 100 for a stack trace with its footer",
          ),
        since: z.number().int().nonnegative().optional(),
        wait_for: z.string().optional(),
        timeout_ms: z.number().int().positive().optional(),
      }),
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
    "overseer_wait",
    {
      title: "Wait for an overseer task",
      description:
        "Follow a task you did not start (the user's, or one from earlier) until it ends or prints " +
        "a line matching `match`, without holding up the conversation. For a task you are " +
        "starting, pass `wait` or `match` to overseer_run instead. " +
        "`task` is a numeric id or a case-insensitive name substring. " +
        "The result is the task's last `lines` output lines (default 20) under a status line " +
        "carrying `exit_code` and `waited`: exited, matched, stopped, restarted, disposed or " +
        "timeout. If the task has already exited, or `match` is already in its output, that comes " +
        "back at once. Otherwise, on clients that support MCP tasks, this returns a task that the " +
        "client follows in the background, and the result arrives when the task ends. It gives up " +
        "after `timeout_ms`: 24 hours by default without `match`, ending quietly with the task " +
        "still running, and 10 minutes with it, ending as an error. A background wait takes a " +
        "`match` of up to about 50 characters. On clients without MCP tasks it returns at once " +
        "with the shell command that does the same wait; run that as a background shell command. " +
        "For a wait of a few seconds, overseer_tail's wait_for is simpler. Cancelling the wait " +
        "leaves the task running.",
      inputSchema: z.object({
        task: selector,
        match: z.string().optional(),
        lines: z.number().int().positive().optional(),
        timeout_ms: z.number().int().positive().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    // the handler is typed to return a CallToolResult, which a task reply isn't
    (args, ctx) =>
      followOrReturn(ctx, waitCli, {
        task: args.task,
        match: args.match,
        lines: args.lines,
        timeoutMs: args.timeout_ms,
      }) as never,
  );

  server.registerTool(
    "overseer_run",
    {
      title: "Run a command as an overseer task",
      description:
        "Start a long-running command as an overseer task, so it appears in the user's task list, " +
        "can be stopped from it, and inherits proper process-group teardown. " +
        "Use for commands that run for a while: dev servers, file watchers, --watch test runs, log " +
        "tails, and builds or test runs you follow with `wait`. For short commands that terminate " +
        "by themselves, use Bash instead: you need their output in-band, and round-tripping a fast " +
        "build through start-then-poll is worse. " +
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
        "rather than a prompt opening in the editor. " +
        "Pass `wait: true` to be told when the task ends. On clients that support MCP tasks this " +
        "returns a task that runs in the background, and its result (exit code, last `lines` " +
        "output lines, default 20, and any diagnostics the task parsed) arrives when the task " +
        "exits, fails, is stopped, restarted or disposed. Pass `match`, a regex, to end it at the " +
        "first matching output line instead, for a dev server coming up; a background `match` " +
        "takes up to about 50 characters. It gives up after `timeout_ms`: 24 hours by default " +
        "without `match`, ending quietly with the task still running, and 10 minutes with it, " +
        "ending as an error. Cancelling the background task stops the overseer task. On clients " +
        "without MCP tasks the reply carries a shell command that does the same wait; run that " +
        "as a background shell command.",
      inputSchema: z.object({
        cmd: z.array(z.string()).optional(),
        template: z.string().optional(),
        name: z
          .string()
          .optional()
          .describe(
            "Task-list name for a `cmd` task; defaults to the command. " +
              "A `template` runs under its own name",
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory for the task; for `template`, also the directory the template " +
              "is resolved in. A relative path in `cmd[0]` (./script.sh) resolves against it. " +
              "Defaults to nvim's cwd",
          ),
        params: z.record(z.string(), z.unknown()).optional(),
        settle_ms: z.number().int().nonnegative().optional(),
        dispose_timeout: z
          .number()
          .int()
          .positive()
          .max(86400)
          .optional()
          .describe(
            "Seconds a finished task stays in the task list before overseer removes it; " +
              "default 300. Keep it above ~30: a removed task can no longer be tailed or restarted",
          ),
        dispose_require_view: z
          .boolean()
          .optional()
          .describe(
            "Keep the finished task until the user opens its output in nvim, and only then " +
              "start counting `dispose_timeout`. Use it for output they should read themselves; " +
              "your own tail does not count as opening it",
          ),
        ...followInputs,
      }),
      annotations: { destructiveHint: false },
    },
    async (args, ctx) => {
      let started: overseer.RunResult;
      try {
        if (args.match !== undefined) {
          await validateMatch(args.match, clientSupportsTasks(ctx), args.lines, args.timeout_ms);
        }
        started = await overseer.run({
          cmd: args.cmd,
          template: args.template,
          name: args.name,
          cwd: args.cwd,
          params: args.params,
          settleMs: args.settle_ms,
          disposeTimeout: args.dispose_timeout,
          disposeRequireView: args.dispose_require_view,
        });
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
      if (!following(args)) return text(json(withoutSeq(started)));
      return followOrReturn(
        ctx,
        waitCli,
        {
          task: started.id,
          seq: started.seq,
          stops: true,
          match: args.match,
          lines: args.lines,
          timeoutMs: args.timeout_ms,
        },
        `task ${started.id} (${started.name}) started`,
      ) as never;
    },
  );

  server.registerTool(
    "overseer_restart",
    {
      title: "Restart an overseer task",
      description:
        "Restart a task by id or name substring (stops it first if running). " +
        "A name matching more than one task is an error listing the candidates; pass a numeric " +
        "id instead. Running tasks the user started are refused unless `force` is set. " +
        "Takes `wait`, `match`, `timeout_ms` and `lines` as overseer_run does, to follow the " +
        "restarted task until it ends.",
      inputSchema: z.object({ task: selector, force: z.boolean().optional(), ...followInputs }),
      annotations: { destructiveHint: true },
    },
    async (args, ctx) => {
      let restarted: { id: number; status: string; seq: number };
      try {
        if (args.match !== undefined) {
          await validateMatch(args.match, clientSupportsTasks(ctx), args.lines, args.timeout_ms);
        }
        restarted = await overseer.restart(args.task, args.force);
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
      if (!following(args)) return text(json(withoutSeq(restarted)));
      return followOrReturn(
        ctx,
        waitCli,
        {
          task: restarted.id,
          seq: restarted.seq,
          stops: true,
          match: args.match,
          lines: args.lines,
          timeoutMs: args.timeout_ms,
        },
        `task ${restarted.id} restarted`,
      ) as never;
    },
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
      inputSchema: z.object({ task: selector, force: z.boolean().optional() }),
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
      inputSchema: z.object({ task: selector, force: z.boolean().optional() }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) => guard(async () => json(await overseer.dispose(args.task, args.force))),
  );
}
