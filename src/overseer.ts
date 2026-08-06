import { LUA } from "./lua.gen.js";
import { getRpc } from "./nvim.js";

export type TaskInfo = {
  id: number;
  name: string;
  status: string;
  /** Absent while running; present once the task has exited. 0 means success. */
  exit_code?: number;
  /** A string when overseer runs it through a shell, an argv array otherwise. */
  cmd?: string | string[];
  cwd?: string;
  /** os.time() seconds (not milliseconds). */
  time_start?: number;
  time_end?: number;
  /** Whether this server started the task, or the user did. */
  origin: "agent" | "user";
};
export type TemplateParam = {
  name: string;
  type?: string;
  default?: unknown;
  /** True when the param is neither optional nor defaulted; `run` refuses to start without it. */
  required: boolean;
};

export type Template = {
  name: string;
  /** Explicitly null when the provider supplies none (npm and make never do). */
  desc: string | null;
  /** Provider module ("npm", "make", "just"…); null for directly registered templates. */
  provider: string | null;
  /** Omitted when the template takes none, which is the overwhelmingly common case. */
  params?: TemplateParam[];
  /** A running task with this template's name. The match is by name, so it can miss. */
  running_task_id?: number;
};

export type TailResult = {
  lines: string[];
  /** 1-based index of the first returned line. Greater than `since` + 1 means a gap. */
  from: number;
  /** Lines available now. Pass it back as `since` next call to get only the delta. */
  total: number;
  status: string;
  exit_code?: number;
  /** Why a wait ended. Absent when no wait was requested. */
  waited?: "matched" | "exited" | "timeout";
};

export type TailOpts = {
  lines?: number;
  since?: number;
  waitFor?: string;
  timeoutMs?: number;
};

export type RunResult = {
  id: number;
  name: string;
  status?: string;
  exit_code?: number;
  lines?: string[];
};

const WAIT_POLL_MS = 250;
const WAIT_DEFAULT_MS = 15_000;
const WAIT_MAX_MS = 120_000;
const SETTLE_DEFAULT_MS = 1_500;
const SETTLE_POLL_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OverseerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverseerError";
  }
}

function unwrap<T>(value: unknown): T {
  if (value && typeof value === "object" && "error" in value) {
    throw new OverseerError(String((value as { error: unknown }).error));
  }
  return value as T;
}

async function exec<T>(code: string, args: unknown[] = []): Promise<T> {
  const rpc = await getRpc();
  return unwrap<T>(await rpc.execLua(code, args));
}

export async function listTasks(): Promise<TaskInfo[]> {
  return exec<TaskInfo[]>(LUA.LIST);
}

/**
 * `cwd` omitted means nvim's cwd, resolved in Lua. Providers search nvim's cwd
 * regardless, so a process.cwd() default would disagree with discovery.
 */
export async function listTemplates(cwd?: string, filter?: string): Promise<Template[]> {
  return exec<Template[]>(LUA.TEMPLATES, [cwd ?? null, filter ?? null]);
}

export type ProviderReport = {
  name: string;
  /** Why this provider contributed nothing, e.g. "No package.json file found". */
  message: string | null;
  available: number;
  total: number;
  from_cache: boolean;
};

export type Diagnosis = {
  timed_out: boolean;
  dir: string;
  /** Providers search this as well as `dir`, so a mismatch explains stray templates. */
  nvim_cwd: string;
  exrc: boolean;
  has_nvim_lua: boolean;
  templates: number;
  providers: ProviderReport[];
  tasks_running: number;
};

/**
 * Nvim's own cwd. Providers search it as well as the requested dir, which
 * explains stray templates from other projects.
 */
export async function nvimCwd(): Promise<string> {
  return exec<string>(LUA.NVIM_CWD);
}

/**
 * Live state behind "why can't overseer see my task", for the diagnose prompt.
 * `cwd` defaults to nvim's, for the same reason `listTemplates` does.
 */
export async function diagnose(cwd?: string): Promise<Diagnosis> {
  return exec<Diagnosis>(LUA.DIAGNOSE, [cwd ?? null]);
}

/**
 * Read a task's output, optionally blocking until `waitFor` matches.
 *
 * The wait loop runs in Node. vim.wait does not process input, and this server
 * runs inside the user's editor, so waiting in Lua would freeze their session
 * for the whole timeout.
 */
export async function tail(
  selector: number | string | null,
  opts: TailOpts = {},
): Promise<TailResult> {
  const read = () => exec<TailResult>(LUA.TAIL, [selector, opts.lines ?? 100, opts.since ?? 0]);
  if (opts.waitFor === undefined) return read();

  let pattern: RegExp;
  try {
    pattern = new RegExp(opts.waitFor);
  } catch (e) {
    throw new OverseerError(`wait_for is not a valid regular expression: ${String(e)}`);
  }
  const deadline = Date.now() + Math.min(opts.timeoutMs ?? WAIT_DEFAULT_MS, WAIT_MAX_MS);

  for (;;) {
    // Re-read from the same `since` each round so the result holds everything
    // that arrived during the wait.
    const res = await read();
    if (res.lines.some((line) => pattern.test(line))) return { ...res, waited: "matched" };
    // Once the task has exited nothing new can match, so stop early.
    if (res.exit_code !== undefined) return { ...res, waited: "exited" };
    if (Date.now() >= deadline) return { ...res, waited: "timeout" };
    await sleep(WAIT_POLL_MS);
  }
}

export async function run(opts: {
  cmd?: string[];
  template?: string;
  name?: string;
  cwd?: string;
  params?: Record<string, unknown>;
  settleMs?: number;
}): Promise<RunResult> {
  const hasCmd = Array.isArray(opts.cmd) && opts.cmd.length > 0;
  const hasTemplate = typeof opts.template === "string" && opts.template.length > 0;
  if (hasCmd === hasTemplate) {
    throw new OverseerError("run requires exactly one of `cmd` or `template`");
  }
  if (hasCmd && opts.params !== undefined) {
    throw new OverseerError("`params` applies to `template`, not to a raw `cmd`");
  }
  const started = hasCmd
    ? await exec<RunResult>(LUA.RUN_CMD, [opts.cmd, opts.name ?? null, opts.cwd ?? null])
    : await exec<RunResult>(LUA.RUN_TEMPLATE, [
        opts.template,
        opts.cwd ?? null,
        opts.params ?? null,
      ]);

  const settle = opts.settleMs ?? SETTLE_DEFAULT_MS;
  if (settle <= 0) return started;

  // Without this, a typo'd binary returns the same { id, name } as a healthy
  // dev server. Return as soon as there is something to report: an exit is
  // conclusive, and first output means it is alive.
  const deadline = Date.now() + settle;
  for (;;) {
    const out = await tail(started.id, { lines: 20 }).catch(() => null);
    const expired = Date.now() >= deadline;
    if (out) {
      if (out.exit_code !== undefined) {
        return { ...started, status: out.status, exit_code: out.exit_code, lines: out.lines };
      }
      if (out.lines.length > 0 || expired) {
        return { ...started, status: out.status, lines: out.lines };
      }
    } else if (expired) {
      return started;
    }
    await sleep(SETTLE_POLL_MS);
  }
}

// Synchronous despite their looks: Task:stop finalizes before strategy:stop(),
// and Task:restart is stop() -> reset() -> start() inline. Nothing to poll for
// (a restart ends in RUNNING where it began, so a predicate never fires).
export async function restart(
  selector: number | string,
  force = false,
): Promise<{ id: number; status: string }> {
  return exec(LUA.RESTART, [selector, force]);
}

export async function stop(
  selector: number | string,
  force = false,
): Promise<{ id: number; status: string }> {
  return exec(LUA.STOP, [selector, force]);
}

export async function dispose(
  selector: number | string,
  force = false,
): Promise<{ id: number; disposed: true }> {
  return exec(LUA.DISPOSE, [selector, force]);
}
