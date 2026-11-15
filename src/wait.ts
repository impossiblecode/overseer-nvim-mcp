import { formatTail } from "./format.ts";
import { closeRpc } from "./nvim.ts";
import { waitForTask } from "./overseer.ts";

/**
 * `overseer-nvim-mcp wait`: block until a task finishes, print its output and
 * exit with its exit code. Waiting inside a tool call holds up the
 * conversation. An agent can run this in the background and gets woken when it
 * exits.
 */

/** Same as GNU timeout. */
export const EXIT_TIMEOUT = 124;
/** The wait failed (bad args, no such task), as env and timeout use 125. */
export const EXIT_WAIT_FAILED = 125;

export const WAIT_USAGE = `Usage: overseer-nvim-mcp wait <task> [options]

  <task>              numeric task id, or a case-insensitive name substring
  --match <regex>     return as soon as an output line matches
  --lines <n>         trailing lines to print (default 20)
  --timeout <secs>    give up after this long (default 3600)

Exits with the task's own exit code, ${EXIT_TIMEOUT} on timeout, ${EXIT_WAIT_FAILED} if the wait itself failed.`;

type Parsed = { selector: number | string; match?: string; lines?: number; timeoutMs?: number };

export function parseWaitArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  let match: string | undefined;
  let lines: number | undefined;
  let timeoutMs: number | undefined;

  const number = (flag: string, raw: string | undefined): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--match") match = argv[++i];
    else if (arg === "--lines") lines = number("--lines", argv[++i]);
    else if (arg === "--timeout") timeoutMs = number("--timeout", argv[++i]) * 1000;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (match === undefined && argv.includes("--match")) throw new Error("--match needs a pattern");
  if (positional.length === 0) throw new Error("no task given");
  if (positional.length > 1) throw new Error(`expected one task, got ${positional.length}`);

  const first = positional[0]!;
  // same selector rules as the tools
  const selector = /^\d+$/.test(first) ? Number(first) : first;
  return { selector, match, lines, timeoutMs };
}

export async function runWait(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseWaitArgs(argv);
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n\n${WAIT_USAGE}`);
    return EXIT_WAIT_FAILED;
  }

  try {
    const res = await waitForTask(parsed.selector, {
      match: parsed.match,
      lines: parsed.lines,
      timeoutMs: parsed.timeoutMs,
    });
    out(formatTail(res));
    if (res.waited === "timeout") return EXIT_TIMEOUT;
    // --match hit while the task is still running
    return res.exit_code ?? 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return EXIT_WAIT_FAILED;
  } finally {
    closeRpc();
  }
}
