import { expect } from "vitest";
import { dispose, restart, run, stop, taskEvents, watchTask } from "../overseer.ts";
import {
  it,
  nodeCmd,
  startAsUser,
  stayAlive,
  trackTasks,
  waitForExit,
} from "./overseer.testkit.ts";

// The lifecycle event log kept in nvim for tasks this server follows.
const track = trackTasks();

const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

it("a followed task logs its completion with status and exit code", async () => {
  const started = await run({
    cmd: nodeCmd("process.exit(3)"),
    name: "mcp journal exit",
    settleMs: 0,
  });
  track(started.id);
  await waitForExit(started.id);
  const { events } = await taskEvents(started.id, started.seq);
  expect(events).toEqual([
    expect.objectContaining({ kind: "complete", status: "FAILURE", exit_code: 3 }),
  ]);
});

it("a restart logs restart_requested, complete CANCELED, then reset, in order", async () => {
  const started = await run({ cmd: nodeCmd(stayAlive), name: "mcp journal restart", settleMs: 0 });
  track(started.id);
  await restart(started.id);
  const { events } = await taskEvents(started.id, started.seq);
  expect(kinds(events)).toEqual(["restart_requested", "complete", "reset"]);
  expect(events[1]).toMatchObject({ status: "CANCELED" });
});

it("a restart's own seq is past its events", async () => {
  const started = await run({
    cmd: nodeCmd(stayAlive),
    name: "mcp journal restart seq",
    settleMs: 0,
  });
  track(started.id);
  const restarted = await restart(started.id);
  expect((await taskEvents(started.id, restarted.seq)).events).toEqual([]);
});

it("a forced dispose of a running task logs complete then dispose", async () => {
  const started = await run({ cmd: nodeCmd(stayAlive), name: "mcp journal dispose", settleMs: 0 });
  await dispose(started.id, true);
  const log = await taskEvents(started.id, started.seq);
  expect(kinds(log.events)).toEqual(["complete", "dispose"]);
  expect(log.events[1]).toMatchObject({ while_running: true });
  expect(log.known).toBe(true);
});

it("a stop then a later dispose logs the dispose as not while running", async () => {
  const started = await run({
    cmd: nodeCmd(stayAlive),
    name: "mcp journal stop dispose",
    settleMs: 0,
  });
  await stop(started.id);
  await dispose(started.id);
  const { events } = await taskEvents(started.id, started.seq);
  expect(kinds(events)).toEqual(["complete", "dispose"]);
  expect(events[1]?.while_running).toBeUndefined();
});

it("following twice subscribes once", async () => {
  const started = await run({ cmd: nodeCmd(stayAlive), name: "mcp journal twice", settleMs: 0 });
  track(started.id);
  await watchTask(started.id);
  await watchTask(started.id);
  await stop(started.id);
  expect(kinds((await taskEvents(started.id, started.seq)).events)).toEqual(["complete"]);
});

it("a user's task is followed on demand", async () => {
  const id = await startAsUser("mcp journal user task");
  track(id);
  const watched = await watchTask(id);
  expect(watched.id).toBe(id);
  await stop(id, true);
  expect(kinds((await taskEvents(id, watched.seq)).events)).toEqual(["complete"]);
});

it("an unknown id reports known=false", async () => {
  expect(await taskEvents(999999, 0)).toEqual({
    seq: expect.any(Number),
    known: false,
    events: [],
  });
});
