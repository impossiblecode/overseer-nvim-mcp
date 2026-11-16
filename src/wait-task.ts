import {
  CLIENT_CAPABILITIES_META_KEY,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatTail } from "./format.ts";
import {
  type Diagnostic,
  matchesAny,
  nvimPid,
  OverseerError,
  stop,
  type TailResult,
  type TaskEvent,
  tail,
  taskEvents,
  WAIT_CLI_DEFAULT_MS,
  watchTask,
} from "./overseer.ts";

/** Claude Code's own _meta key; its modelImmediateResponse is shown to the model at task start. */
const AGENT_TASK_META = "com.anthropic/agent-task";

/**
 * Following an overseer task as a 2026-07-28 Tasks-extension task. The task
 * id carries the whole wait, so tasks/get can answer from nvim alone, even in
 * a new server process after a resumed session.
 */

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const POLL_INTERVAL_MS = 2000;
const DEFAULT_LINES = 20;
/** Without `match`; ends quietly, the task still running. */
export const FOLLOW_DEFAULT_MS = 86_400_000;
/** With `match`; ends as an error, since the line never came. */
export const MATCH_DEFAULT_MS = 600_000;
/** Most output lines one poll scans for `match`. */
const SCAN_MAX = 5000;
/** Keeps the TTL from lapsing between the deadline and the poll that reports it. */
const TTL_SLACK_MS = 60_000;
const ID_PREFIX = "o2";
/** Claude Code refuses task ids longer than this. */
export const MAX_TASK_ID = 128;

export type WaitState = {
  pid: number;
  id: number;
  match?: string;
  lines: number;
  t0: number;
  timeoutMs: number;
  /** Output lines already seen; `match` scans after this. */
  since: number;
  /** Event-log position; lifecycle events after it decide the outcome. */
  seq: number;
  /** Cancelling also stops the overseer task (a run's own task). */
  stops: boolean;
};
const NUMERIC = ["pid", "id", "t0", "since", "seq", "lines", "timeoutMs", "stops"] as const;

export type WaitArgs = {
  task: number | string;
  match?: string;
  lines?: number;
  timeoutMs?: number;
  /** A run already following the task passes its cursor; otherwise startWait follows it. */
  seq?: number;
  stops?: boolean;
};

export type WaitStart = { done: TailResult } | { pending: WaitState; tail: TailResult };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export type TaskView = {
  taskId: string;
  status: "working" | "completed" | "cancelled";
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  result?: ToolResult;
};

export type Outcome = {
  waited: "exited" | "stopped" | "restarted" | "disposed";
  exit_code?: number;
  /** The restart came through overseer_restart. */
  by_agent?: boolean;
  diagnostics?: Diagnostic[];
  diagnostics_total?: number;
};

/**
 * How a followed task ended, from its events in order, or undefined while
 * nothing decisive has happened. A restart lands all its events between two
 * polls (complete CANCELED, then reset), so the look-ahead tells it apart
 * from a stop.
 */
export function lifecycleOutcome(events: TaskEvent[]): Outcome | undefined {
  for (const [i, e] of events.entries()) {
    const later = events.slice(i + 1);
    if (e.kind === "complete") {
      const exited = e.status === "SUCCESS" || e.status === "FAILURE";
      const result: Outcome = { waited: "stopped" };
      if (exited) {
        result.waited = "exited";
        if (e.exit_code !== undefined) result.exit_code = e.exit_code;
        if (e.diagnostics !== undefined) result.diagnostics = e.diagnostics;
        if (e.diagnostics_total !== undefined) result.diagnostics_total = e.diagnostics_total;
      }
      if (later.some((n) => n.kind === "reset")) {
        result.waited = "restarted";
        if (events.slice(0, i).some((p) => p.kind === "restart_requested")) result.by_agent = true;
      } else if (!exited && later.some((n) => n.kind === "dispose" && n.while_running)) {
        // a stop followed by the auto-dispose minutes later stays a stop
        result.waited = "disposed";
      }
      return result;
    }
    if (e.kind === "reset") return { waited: "restarted" };
    if (e.kind === "dispose") return { waited: "disposed" };
  }
  return undefined;
}

/** Per process; lost when the server restarts. */
const cancelled = new Set<string>();
/** How far each wait has scanned for `match`; a missing entry rescans from `since`. */
const cursors = new Map<string, number>();

/** Dot-separated base36 numbers, then the pattern in base64url when there is one. */
export function encodeTaskId(state: WaitState): string {
  const fields = [ID_PREFIX, ...NUMERIC.map((k) => Number(state[k]).toString(36))];
  if (state.match !== undefined) fields.push(Buffer.from(state.match).toString("base64url"));
  return fields.join(".");
}

export function decodeTaskId(taskId: string): WaitState {
  const bad = () =>
    new ProtocolError(ProtocolErrorCode.InvalidParams, `not a task this server issued: ${taskId}`);
  const [prefix, ...rest] = taskId.split(".");
  const n = NUMERIC.length;
  if (prefix !== ID_PREFIX || (rest.length !== n && rest.length !== n + 1)) throw bad();
  const nums = rest.slice(0, n).map((f) => (/^[0-9a-z]+$/.test(f) ? parseInt(f, 36) : NaN));
  if (nums.some((v) => !Number.isSafeInteger(v))) throw bad();
  const [pid, id, t0, since, seq, lines, timeoutMs, stops] = nums as number[] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (lines < 1 || timeoutMs < 1 || (stops !== 0 && stops !== 1)) throw bad();
  const state: WaitState = { pid, id, lines, t0, timeoutMs, since, seq, stops: stops === 1 };
  const encoded = rest[n];
  if (encoded !== undefined) {
    const match = Buffer.from(encoded, "base64url").toString();
    // Buffer skips characters it can't decode, so only an exact round trip counts
    if (Buffer.from(match).toString("base64url") !== encoded) throw bad();
    state.match = match;
  }
  return state;
}

/**
 * Only the 2026 extension counts. VS Code Copilot speaks the 2025-11-25 tasks
 * and blocks its chat on them (vscode#308961), so that hint is ignored.
 */
export function clientSupportsTasks(ctx: ServerContext): boolean {
  // the SDK types the envelope as {}
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return caps?.extensions?.[TASKS_EXTENSION] !== undefined;
}

function compile(match: string): RegExp {
  try {
    return new RegExp(match);
  } catch (e) {
    throw new OverseerError(`match is not a valid regular expression: ${String(e)}`);
  }
}

/** An exited task, or a match already in the output, comes back as a result straight away. */
export async function startWait(args: WaitArgs, now = Date.now()): Promise<WaitStart> {
  const pattern = args.match === undefined ? null : compile(args.match);
  const lines = args.lines ?? DEFAULT_LINES;
  // Follow before reading, so nothing that happens in between goes unlogged.
  const watched = args.seq === undefined ? await watchTask(args.task) : undefined;
  const res = await tail(watched?.id ?? args.task, { lines });
  // scan everything printed so far: later lines can bury a ready line
  if (
    pattern !== null &&
    matchesAny(pattern, (await tail(res.id!, { lines: SCAN_MAX, since: 0 })).lines)
  ) {
    return { done: { ...res, waited: "matched" } };
  }
  if (res.exit_code !== undefined) return { done: { ...res, waited: "exited" } };
  const timeoutMs = args.timeoutMs ?? (pattern === null ? FOLLOW_DEFAULT_MS : MATCH_DEFAULT_MS);
  return {
    pending: {
      pid: await nvimPid(),
      id: res.id!,
      match: args.match,
      lines,
      t0: Math.floor(now),
      timeoutMs: Math.ceil(timeoutMs),
      since: res.total,
      seq: watched?.seq ?? args.seq!,
      stops: args.stops ?? false,
    },
    tail: res,
  };
}

function view(
  state: WaitState,
  taskId: string,
  status: TaskView["status"],
  now: number,
  extra: Pick<TaskView, "statusMessage" | "result"> = {},
): TaskView {
  return {
    taskId,
    status,
    createdAt: new Date(state.t0).toISOString(),
    lastUpdatedAt: new Date(now).toISOString(),
    ttlMs: state.timeoutMs + TTL_SLACK_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    ...extra,
  };
}

const progress = (res: TailResult) => `task ${res.id} ${res.status}, ${res.total} output lines`;

/** `note` is what Claude Code shows the model when the task starts; it never shows statusMessage. */
function checkFits(state: WaitState): string {
  const taskId = encodeTaskId(state);
  if (taskId.length > MAX_TASK_ID && state.match !== undefined) {
    const { match, ...rest } = state;
    // +1 for the dot before the pattern; base64url spends 4 characters per 3 bytes
    const room = Math.floor(((MAX_TASK_ID - encodeTaskId(rest).length - 1) * 3) / 4);
    throw new OverseerError(
      `match is ${Buffer.byteLength(match)} bytes; a background wait has room for ${room}. ` +
        "Use a shorter pattern.",
    );
  }
  return taskId;
}

/**
 * Called before a run or restart starts its task, so a rejected pattern
 * leaves nothing running. Sized against generous numbers; the real ones
 * come later.
 */
export async function validateMatch(
  match: string,
  background: boolean,
  lines?: number,
  timeoutMs?: number,
) {
  compile(match);
  // only a task id has a length limit; the CLI fallback takes any pattern
  if (!background) return;
  checkFits({
    pid: await nvimPid(),
    id: 999_999,
    t0: Date.now(),
    since: 9_999_999,
    seq: 9_999_999,
    lines: lines ?? DEFAULT_LINES,
    timeoutMs: Math.ceil(timeoutMs ?? MATCH_DEFAULT_MS),
    stops: true,
    match,
  });
}

export function createTaskResult(state: WaitState, res: TailResult, note: string) {
  const taskId = checkFits(state);
  return {
    resultType: "task" as const,
    ...view(state, taskId, "working", state.t0, { statusMessage: progress(res) }),
    _meta: { [AGENT_TASK_META]: { modelImmediateResponse: note } },
  };
}

function completed(state: WaitState, taskId: string, now: number, text: string, isError: boolean) {
  cursors.delete(taskId);
  return view(state, taskId, "completed", now, {
    result: { content: [{ type: "text", text }], ...(isError && { isError: true }) },
  });
}

function formatDiagnostics(outcome: Outcome): string | null {
  const shown = outcome.diagnostics;
  if (shown === undefined || shown.length === 0) return null;
  const rows = shown.map((d) => {
    const at = [d.filename ?? "?", d.lnum, d.col ? d.col : undefined].filter(
      (p) => p !== undefined,
    );
    return `${at.join(":")}: ${d.text}`;
  });
  return [
    `diagnostics (${shown.length} of ${outcome.diagnostics_total ?? shown.length}):`,
    ...rows,
  ].join("\n");
}

async function outcomeText(state: WaitState, outcome: Outcome): Promise<string> {
  let final: TailResult | undefined;
  try {
    final = await tail(state.id, { lines: state.lines });
  } catch (e) {
    if (!(e instanceof OverseerError)) throw e;
  }
  const parts = [
    final === undefined
      ? [
          outcome.exit_code === undefined ? null : `exit_code=${outcome.exit_code}`,
          `waited=${outcome.waited}`,
        ]
          .filter((part) => part !== null)
          .join(" ") + `\ntask ${state.id} was disposed, and its output went with it.`
      : formatTail({ ...final, waited: outcome.waited }),
  ];
  if (outcome.waited === "restarted" && outcome.exit_code !== undefined) {
    parts.push(`The run before the restart exited with ${outcome.exit_code}.`);
  }
  if (outcome.by_agent) parts.push("Restarted through overseer_restart; follow the new task.");
  const diagnostics = formatDiagnostics(outcome);
  if (diagnostics !== null) parts.push(diagnostics);
  return parts.join("\n\n");
}

const failed = (o: Outcome) =>
  o.waited === "disposed" ||
  (o.waited === "exited" && o.exit_code !== undefined && o.exit_code !== 0);

export async function getTask(taskId: string, now = Date.now()): Promise<TaskView> {
  const state = decodeTaskId(taskId);
  if (cancelled.has(taskId)) {
    return view(state, taskId, "cancelled", now, {
      statusMessage: `wait cancelled; task ${state.id} is untouched`,
    });
  }
  const pid = await nvimPid();
  if (pid !== state.pid) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `task ${taskId} belongs to an nvim that is gone (pid ${state.pid}, now ${pid}); its outcome is unknown`,
    );
  }

  const log = await taskEvents(state.id, state.seq);
  if (!log.known) {
    return completed(
      state,
      taskId,
      now,
      `task ${state.id} no longer exists, so how it ended is unknown. Overseer removes ` +
        "finished tasks after their dispose_timeout (300 s unless set otherwise).",
      true,
    );
  }
  const outcome = lifecycleOutcome(log.events);
  if (outcome !== undefined) {
    return completed(state, taskId, now, await outcomeText(state, outcome), failed(outcome));
  }

  let status = `following task ${state.id}`;
  if (state.match !== undefined) {
    const from = cursors.get(taskId) ?? state.since;
    const scan = await tail(state.id, { lines: SCAN_MAX, since: from });
    cursors.set(taskId, scan.total);
    if (matchesAny(compile(state.match), scan.lines)) {
      const final = await tail(state.id, { lines: state.lines });
      return completed(state, taskId, now, formatTail({ ...final, waited: "matched" }), false);
    }
    status = progress(scan);
  }

  if (now >= state.t0 + state.timeoutMs) {
    const final = await tail(state.id, { lines: state.lines });
    const text = formatTail({ ...final, waited: "timeout" });
    if (state.match !== undefined) return completed(state, taskId, now, text, true);
    const hours = Math.round((state.timeoutMs / 3_600_000) * 10) / 10;
    return completed(
      state,
      taskId,
      now,
      `${text}\n\nTask ${state.id} is still running after ${hours} h; overseer_wait follows it again.`,
      false,
    );
  }
  return view(state, taskId, "working", now, { statusMessage: status });
}

/** A run's own task is stopped too; a wait leaves the overseer task alone. */
export async function cancelTask(taskId: string): Promise<void> {
  const state = decodeTaskId(taskId);
  cancelled.add(taskId);
  cursors.delete(taskId);
  // ids restart at 1 in a new nvim, so a stale id would name some other task
  if (!state.stops || (await nvimPid()) !== state.pid) return;
  // unforced, so the guard still refuses a user's task; finished or gone is fine
  await stop(state.id).catch((e: unknown) => {
    if (!(e instanceof OverseerError)) throw e;
  });
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The `wait` CLI line that does the same wait, for clients without tasks. */
export function waitCommand(cli: string, state: Omit<WaitState, "match"> & { match?: string }) {
  const parts = [`${cli} wait ${state.id}`];
  if (state.match !== undefined) parts.push(`--match ${shellQuote(state.match)}`);
  if (state.lines !== DEFAULT_LINES) parts.push(`--lines ${state.lines}`);
  if (state.timeoutMs !== WAIT_CLI_DEFAULT_MS) {
    parts.push(`--timeout ${Math.ceil(state.timeoutMs / 1000)}`);
  }
  return parts.join(" ");
}

export function registerTaskHandlers(server: McpServer): void {
  const params = z.looseObject({ taskId: z.string() });
  const result = z.looseObject({});
  server.server.setRequestHandler("tasks/get", { params, result }, (p) => getTask(p.taskId));
  server.server.setRequestHandler("tasks/cancel", { params, result }, async (p) => {
    await cancelTask(p.taskId);
    return {};
  });
}
