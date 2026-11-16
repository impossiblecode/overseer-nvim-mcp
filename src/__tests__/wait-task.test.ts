import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { describe, expect, test } from "vitest";
import { getRpc } from "../nvim.ts";
import {
  dispose,
  listTasks,
  nvimPid,
  OverseerError,
  restart,
  run,
  type TaskEvent,
} from "../overseer.ts";
import {
  cancelTask,
  clientSupportsTasks,
  createTaskResult,
  decodeTaskId,
  encodeTaskId,
  getTask,
  lifecycleOutcome,
  MAX_TASK_ID,
  startWait,
  TASKS_EXTENSION,
  type WaitState,
  waitCommand,
} from "../wait-task.ts";
import {
  it,
  nodeCmd,
  sleep,
  startAsUser,
  stayAlive,
  trackTasks,
  waitForExit,
} from "./overseer.testkit.ts";

const track = trackTasks();

const STATE: WaitState = {
  pid: 4242,
  id: 7,
  match: "ready",
  lines: 20,
  t0: Date.parse("2026-11-15T12:00:00Z"),
  timeoutMs: 3_600_000,
  since: 3,
  seq: 5,
  stops: false,
};

const invalidParams = { code: ProtocolErrorCode.InvalidParams };

test("a task id round-trips its wait state, with or without a pattern", () => {
  expect(decodeTaskId(encodeTaskId(STATE))).toEqual(STATE);
  const { match: _, ...noMatch } = STATE;
  expect(decodeTaskId(encodeTaskId(noMatch))).toEqual(noMatch);
  // an empty pattern is still a pattern
  expect(decodeTaskId(encodeTaskId({ ...STATE, match: "" }))).toEqual({ ...STATE, match: "" });
  expect(decodeTaskId(encodeTaskId({ ...STATE, stops: true }))).toEqual({ ...STATE, stops: true });
});

// What Claude Code 2.1.325 accepts: /^[\x21-\x7e]+$/, at most 128 characters.
test("a task id with large numbers and a 50-character pattern still fits Claude Code's limits", () => {
  const id = encodeTaskId({
    pid: 4_194_304,
    id: 999_999,
    match: "x".repeat(50),
    lines: 9999,
    t0: Date.parse("2099-12-31T23:59:59Z"),
    timeoutMs: 7 * 86_400_000,
    since: 9_999_999,
    seq: 9_999_999,
    stops: true,
  });
  expect(id).toMatch(/^[\x21-\x7e]+$/);
  expect(id.length).toBeLessThanOrEqual(MAX_TASK_ID);
});

test("a pattern too long for a task id fails at the call with the room it has", () => {
  const long = { ...STATE, match: "x".repeat(200) };
  expect(() =>
    createTaskResult(long, { lines: [], from: 0, total: 0, status: "RUNNING" }, "note"),
  ).toThrow(/match is 200 bytes; a background wait has room for \d+/);
});

test("a task reply carries the note Claude Code shows the model at the start", () => {
  const reply = createTaskResult(
    STATE,
    { lines: [], from: 0, total: 0, status: "RUNNING" },
    "following task 7",
  );
  expect(reply._meta).toEqual({
    "com.anthropic/agent-task": { modelImmediateResponse: "following task 7" },
  });
});

test("a malformed task id is an invalid-params error", () => {
  const good = encodeTaskId(STATE);
  for (const bad of [
    "",
    "nope",
    "o2.",
    "o1.1.2.3.4.5.6",
    "o2.1.2.3.4.5.6.7",
    "o2.1.2.3.4.5.0.7.0",
    "o2.1.2.3.4.5.6.7.2",
    "o2.1.2.3.4.5.6.7.0.Z",
    `${good}.extra`,
    `${good}!`,
    "ovs1.eyJ2IjoxfQ",
  ]) {
    expect(() => decodeTaskId(bad), bad).toThrow(ProtocolError);
    try {
      decodeTaskId(bad);
    } catch (e) {
      expect(e).toMatchObject(invalidParams);
    }
  }
});

test("the CLI fallback names the resolved id and shell-quotes the pattern", () => {
  const cmd = waitCommand("node /x/bin.mjs", { ...STATE, match: "it's up" });
  expect(cmd).toBe(`node /x/bin.mjs wait 7 --match 'it'\\''s up'`);
});

test("the CLI fallback passes --lines and --timeout only when they differ from its defaults", () => {
  const { match: _, ...noMatch } = STATE;
  expect(waitCommand("ovs", noMatch)).toBe("ovs wait 7");
  expect(waitCommand("ovs", { ...noMatch, lines: 50, timeoutMs: 90_500 })).toBe(
    "ovs wait 7 --lines 50 --timeout 91",
  );
});

test("tasks are offered only to a request that declares the 2026 extension", () => {
  const ctx = (envelope: unknown) => ({ mcpReq: { envelope } }) as never;
  const caps = (extensions: unknown) => ({
    "io.modelcontextprotocol/clientCapabilities": { extensions },
  });
  expect(clientSupportsTasks(ctx(caps({ [TASKS_EXTENSION]: {} })))).toBe(true);
  expect(clientSupportsTasks(ctx(caps({})))).toBe(false);
  expect(clientSupportsTasks(ctx({}))).toBe(false);
  // legacy connections carry no envelope at all
  expect(clientSupportsTasks(ctx(undefined))).toBe(false);
});

describe("lifecycleOutcome", () => {
  const complete = (status: string, exit_code?: number): TaskEvent => ({
    seq: 0,
    kind: "complete",
    status,
    ...(exit_code !== undefined && { exit_code }),
  });
  const ev = (kind: TaskEvent["kind"]): TaskEvent => ({ seq: 0, kind });

  test("no events, no outcome", () => {
    expect(lifecycleOutcome([])).toBeUndefined();
  });

  test("an exit reports exited with its code", () => {
    expect(lifecycleOutcome([complete("FAILURE", 2)])).toEqual({ waited: "exited", exit_code: 2 });
  });

  test("an exit carries the task's diagnostics", () => {
    const diagnostics = [{ filename: "a.ts", lnum: 3, text: "boom" }];
    const event = { ...complete("FAILURE", 1), diagnostics, diagnostics_total: 4 };
    expect(lifecycleOutcome([event])).toEqual({
      waited: "exited",
      exit_code: 1,
      diagnostics,
      diagnostics_total: 4,
    });
  });

  test("a cancel on its own reports stopped", () => {
    expect(lifecycleOutcome([complete("CANCELED")])).toEqual({ waited: "stopped" });
  });

  test("a cancel followed by reset reports restarted", () => {
    expect(lifecycleOutcome([complete("CANCELED"), ev("reset")])).toEqual({ waited: "restarted" });
  });

  test("a restart the agent asked for is marked as such", () => {
    expect(lifecycleOutcome([ev("restart_requested"), complete("CANCELED"), ev("reset")])).toEqual({
      waited: "restarted",
      by_agent: true,
    });
  });

  test("a failure and a restart in one batch report restarted with the failure's exit code", () => {
    expect(lifecycleOutcome([complete("FAILURE", 2), ev("reset")])).toEqual({
      waited: "restarted",
      exit_code: 2,
    });
  });

  test("a finished task restarted reports restarted", () => {
    expect(lifecycleOutcome([ev("reset")])).toEqual({ waited: "restarted" });
  });

  test("a forced dispose of a running task reports disposed", () => {
    const disposed: TaskEvent = { seq: 0, kind: "dispose", while_running: true };
    expect(lifecycleOutcome([complete("CANCELED"), disposed])).toEqual({ waited: "disposed" });
  });

  test("a stop and a later auto-dispose report stopped", () => {
    expect(lifecycleOutcome([complete("CANCELED"), ev("dispose")])).toEqual({ waited: "stopped" });
  });

  test("a dispose on its own reports disposed", () => {
    expect(lifecycleOutcome([ev("dispose")])).toEqual({ waited: "disposed" });
  });

  test("a restart request alone decides nothing", () => {
    expect(lifecycleOutcome([ev("restart_requested")])).toBeUndefined();
  });
});

it("a task that already exited comes back at once, with its exit code", async () => {
  const { id } = await run({
    cmd: nodeCmd('console.log("all done"); process.exit(4)'),
    name: "mcp wait-task exited",
    settleMs: 3000,
  });
  track(id);
  const start = await startWait({ task: id });
  expect("done" in start && start.done).toMatchObject({ waited: "exited", exit_code: 4 });
});

it("a match already in the output comes back at once, while the task runs on", async () => {
  const { id } = await run({
    cmd: nodeCmd(`console.log("server ready"); ${stayAlive}`),
    name: "mcp wait-task early match",
    settleMs: 3000,
  });
  track(id);
  const start = await startWait({ task: id, match: "ready" });
  expect("done" in start && start.done).toMatchObject({ waited: "matched" });
  expect("done" in start && start.done.exit_code).toBeUndefined();
});

it("an ambiguous selector fails at the call, before any task is handed out", async () => {
  const a = await run({ cmd: nodeCmd(stayAlive), name: "mcp wait-task twin a", settleMs: 0 });
  const b = await run({ cmd: nodeCmd(stayAlive), name: "mcp wait-task twin b", settleMs: 0 });
  track(a.id, b.id);
  await expect(startWait({ task: "mcp wait-task twin" })).rejects.toThrow(OverseerError);
});

it("polls report working until the task exits, then the CLI's output", async () => {
  const { id } = await run({
    cmd: nodeCmd(
      'console.log("one"); setTimeout(() => { console.log("two"); process.exit(2) }, 1200)',
    ),
    name: "mcp wait-task poll exit",
    settleMs: 0,
  });
  track(id);
  const start = await startWait({ task: id });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  const taskId = encodeTaskId(start.pending);

  const first = await getTask(taskId);
  expect(first.status).toBe("working");
  expect(first.taskId).toBe(taskId);
  expect(first.result).toBeUndefined();

  await sleep(2000);
  const last = await getTask(taskId);
  expect(last.status).toBe("completed");
  const text = last.result?.content[0]?.text ?? "";
  expect(text.split("\n")[0]).toContain("exit_code=2");
  expect(text).toContain("waited=exited");
  expect(text).toContain("two");
  // a non-zero exit
  expect(last.result?.isError).toBe(true);
});

it("a clean exit completes without an error", async () => {
  const { id } = await run({
    cmd: nodeCmd("setTimeout(() => process.exit(0), 300)"),
    name: "mcp wait-task clean exit",
    settleMs: 0,
  });
  track(id);
  const start = await startWait({ task: id });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  await sleep(800);
  const done = await getTask(encodeTaskId(start.pending));
  expect(done.result?.content[0]?.text).toContain("waited=exited");
  expect(done.result?.isError).toBeUndefined();
});

it("a match that appears after the wait began completes it without an exit", async () => {
  const { id } = await run({
    cmd: nodeCmd(`setTimeout(() => console.log("listening on 3000"), 600); ${stayAlive}`),
    name: "mcp wait-task poll match",
    settleMs: 0,
  });
  track(id);
  const start = await startWait({ task: id, match: "listening" });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  await sleep(1500);
  const done = await getTask(encodeTaskId(start.pending));
  expect(done.status).toBe("completed");
  expect(done.result?.content[0]?.text).toContain("waited=matched");
});

it("a match wait past its timeout completes as an error with waited=timeout", async () => {
  const { id } = await run({ cmd: nodeCmd(stayAlive), name: "mcp wait-task timeout", settleMs: 0 });
  track(id);
  const start = await startWait({ task: id, match: "never printed", timeoutMs: 1000 });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  const done = await getTask(encodeTaskId(start.pending), start.pending.t0 + 1001);
  expect(done.status).toBe("completed");
  expect(done.result?.content[0]?.text).toContain("waited=timeout");
  expect(done.result?.isError).toBe(true);
});

it("a follow without match times out quietly, saying the task still runs", async () => {
  const { id } = await run({ cmd: nodeCmd(stayAlive), name: "mcp wait-task follow", settleMs: 0 });
  track(id);
  const start = await startWait({ task: id, timeoutMs: 1000 });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  const done = await getTask(encodeTaskId(start.pending), start.pending.t0 + 1001);
  expect(done.status).toBe("completed");
  expect(done.result?.content[0]?.text).toContain("still running");
  expect(done.result?.isError).toBeUndefined();
});

it("defaults: 10 minutes with a match, 24 hours without", async () => {
  const { id } = await run({
    cmd: nodeCmd(stayAlive),
    name: "mcp wait-task defaults",
    settleMs: 0,
  });
  track(id);
  const follow = await startWait({ task: id });
  const match = await startWait({ task: id, match: "nope" });
  expect("pending" in follow && follow.pending.timeoutMs).toBe(86_400_000);
  expect("pending" in match && match.pending.timeoutMs).toBe(600_000);
});

it("a followed run reports a restart between polls", async () => {
  const { id } = await run({ cmd: nodeCmd(stayAlive), name: "mcp wait-task restart", settleMs: 0 });
  track(id);
  const start = await startWait({ task: id });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  await restart(id);
  const done = await getTask(encodeTaskId(start.pending));
  expect(done.status).toBe("completed");
  expect(done.result?.content[0]?.text).toContain("waited=restarted");
  expect(done.result?.isError).toBeUndefined();
});

it("a forced dispose of a running task completes as an error with waited=disposed", async () => {
  const { id } = await run({ cmd: nodeCmd(stayAlive), name: "mcp wait-task gone", settleMs: 0 });
  const start = await startWait({ task: id });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  await dispose(id, true);
  const done = await getTask(encodeTaskId(start.pending));
  expect(done.status).toBe("completed");
  expect(done.result?.isError).toBe(true);
  expect(done.result?.content[0]?.text).toContain("waited=disposed");
});

it("a poll after the task was auto-disposed still reports its exit code", async () => {
  const started = await run({
    cmd: nodeCmd("process.exit(1)"),
    name: "mcp wait-task late poll",
    settleMs: 0,
  });
  const start = await startWait({ task: started.id, seq: started.seq });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  await waitForExit(started.id);
  await dispose(started.id);
  const done = await getTask(encodeTaskId(start.pending));
  expect(done.result?.content[0]?.text).toContain("exit_code=1");
  expect(done.result?.isError).toBe(true);
});

it("a restart from the editor reports restarted without crediting the agent", async () => {
  const started = await run({
    cmd: nodeCmd(stayAlive),
    name: "mcp wait-task user restart",
    settleMs: 0,
  });
  track(started.id);
  const start = await startWait({ task: started.id, seq: started.seq });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  await (await getRpc()).execLua(
    "local id = ... ; require('overseer').list_tasks({ filter = function(t) return t.id == id end })[1]:restart(true)",
    [started.id],
  );
  const text = (await getTask(encodeTaskId(start.pending))).result?.content[0]?.text ?? "";
  expect(text).toContain("waited=restarted");
  expect(text).not.toContain("overseer_restart");
});

it("a ready line pushed out of the last lines still counts at the start", async () => {
  const started = await run({
    cmd: nodeCmd(
      `console.log("ready on 3000"); for (let i = 0; i < 40; i++) console.log("noise " + i); ${stayAlive}`,
    ),
    name: "mcp wait-task buried ready",
    settleMs: 1500,
  });
  track(started.id);
  const start = await startWait({ task: started.id, seq: started.seq, match: "ready on" });
  expect("done" in start && start.done.waited).toBe("matched");
});

it("cancelling a run's task from another nvim leaves the task with that id alone", async () => {
  const started = await run({
    cmd: nodeCmd(stayAlive),
    name: "mcp wait-task stale cancel",
    settleMs: 0,
  });
  track(started.id);
  const pid = await nvimPid();
  await cancelTask(encodeTaskId({ ...STATE, pid: pid + 1, id: started.id, stops: true }));
  const task = (await listTasks()).find((t) => t.id === started.id);
  expect(task?.status).toBe("RUNNING");
});

it("a task the log never followed completes as an error saying its outcome is unknown", async () => {
  const pid = await nvimPid();
  const done = await getTask(encodeTaskId({ ...STATE, pid, id: 999_999 }));
  expect(done.result?.isError).toBe(true);
  expect(done.result?.content[0]?.text).toContain("task 999999 no longer exists");
});

it("a failing exit carries diagnostics when the task parsed some", async () => {
  const res = await (await getRpc()).execLua<{ id: number }>(
    `
    local cmd = ({...})[1]
    local t = require('overseer').new_task({
      cmd = cmd,
      name = 'mcp wait-task diagnostics',
      components = { { 'on_output_parse', errorformat = '%f:%l: %m' }, 'default' },
    })
    t:start()
    return { id = t.id }
  `,
    [nodeCmd('setTimeout(() => { console.log("/tmp/a.ts:3: boom"); process.exit(1) }, 400)')],
  );
  track(res.id);
  const start = await startWait({ task: res.id });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  await sleep(1000);
  const text = (await getTask(encodeTaskId(start.pending))).result?.content[0]?.text ?? "";
  expect(text).toContain("diagnostics (1 of 1):");
  expect(text).toContain("/tmp/a.ts:3: boom");
});

it("a task id from another nvim is refused", async () => {
  const pid = await nvimPid();
  const foreign = encodeTaskId({ ...STATE, pid: pid + 1 });
  await expect(getTask(foreign)).rejects.toMatchObject(invalidParams);
});

it("cancelling stops the wait and leaves the overseer task running", async () => {
  const id = await startAsUser("mcp wait-task cancel");
  track(id);
  const start = await startWait({ task: id });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  const taskId = encodeTaskId(start.pending);
  await cancelTask(taskId);
  expect((await getTask(taskId)).status).toBe("cancelled");
  const still = await startWait({ task: id });
  expect("pending" in still).toBe(true);
});

it("cancelling a run's task stops the overseer task", async () => {
  const started = await run({
    cmd: nodeCmd(stayAlive),
    name: "mcp wait-task cancel run",
    settleMs: 0,
  });
  track(started.id);
  const start = await startWait({ task: started.id, seq: started.seq, stops: true });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  await cancelTask(encodeTaskId(start.pending));
  const task = (await listTasks()).find((t) => t.id === started.id);
  expect(task?.status).toBe("CANCELED");
});

it("cancelling a run's task after it exited does nothing and does not throw", async () => {
  const started = await run({
    cmd: nodeCmd("setTimeout(() => process.exit(0), 200)"),
    name: "mcp wait-task cancel exited",
    settleMs: 0,
  });
  track(started.id);
  const start = await startWait({ task: started.id, seq: started.seq, stops: true });
  if (!("pending" in start)) throw new Error("expected a pending wait");
  await waitForExit(started.id);
  await dispose(started.id);
  await expect(cancelTask(encodeTaskId(start.pending))).resolves.toBeUndefined();
});
