import { expect } from "vitest";
import { dispose, listTasks, OverseerError, restart, run, stop } from "../overseer.js";
import {
  it,
  nodeCmd,
  startAsUser,
  stayAlive,
  trackTasks,
  waitForExit,
} from "./overseer.testkit.js";

// Core task lifecycle, plus selector safety and provenance. Tail behaviour lives
// in overseer.tail.test.ts and template discovery in overseer.templates.test.ts.
const track = trackTasks();

it("listTasks returns an array", async () => {
  expect(Array.isArray(await listTasks())).toBe(true);
});

it("run(cmd) starts a task that appears in the list", async () => {
  const { id } = await run({
    cmd: nodeCmd(`console.log("hi"); ${stayAlive}`),
    name: "mcp test probe",
  });
  track(id);
  expect(id).toBeGreaterThan(0);
  const tasks = await listTasks();
  expect(tasks.some((t) => t.id === id)).toBe(true);
});

it("listTasks reports a non-zero exit_code, plus cmd and cwd", async () => {
  const { id } = await run({ cmd: nodeCmd("process.exit(3)"), name: "mcp exit probe" });
  track(id);
  const task = await waitForExit(id);
  expect(task.exit_code).toBe(3);
  expect(task.cwd).toBeTruthy();
  expect(JSON.stringify(task.cmd)).toContain("process.exit(3)");
});

it("listTasks reports exit_code 0 for a task that succeeds", async () => {
  const { id } = await run({ cmd: nodeCmd("process.exit(0)"), name: "mcp success probe" });
  track(id);
  expect((await waitForExit(id)).exit_code).toBe(0);
});

it("run requires exactly one of cmd/template", async () => {
  await expect(run({})).rejects.toThrow();
  await expect(run({ cmd: ["true"], template: "x" })).rejects.toThrow();
});

it("dispose of a missing task throws OverseerError", async () => {
  await expect(dispose(999999)).rejects.toBeInstanceOf(OverseerError);
});

// Selector safety and provenance.

it("an ambiguous name selector errors and names the candidates", async () => {
  const a = await run({ cmd: nodeCmd(stayAlive), name: "mcp ambig alpha", settleMs: 0 });
  const b = await run({ cmd: nodeCmd(stayAlive), name: "mcp ambig beta", settleMs: 0 });
  track(a.id, b.id);

  // Silently taking the first match is how the wrong task gets stopped.
  await expect(stop("mcp ambig")).rejects.toThrow(/matches 2 tasks/);
  const message = await stop("mcp ambig").catch((e: Error) => e.message);
  expect(message).toContain(String(a.id));
  expect(message).toContain(String(b.id));
  expect(message).toMatch(/numeric id/);

  // An unambiguous substring still resolves.
  const stopped = await stop("ambig alpha");
  expect(stopped.id).toBe(a.id);
});

it("listTasks marks this server's own tasks as agent and the user's as user", async () => {
  const mine = await run({ cmd: nodeCmd(stayAlive), name: "mcp origin agent", settleMs: 0 });
  track(mine.id);
  const theirs = await startAsUser("mcp origin user");
  track(theirs);

  const tasks = await listTasks();
  expect(tasks.find((t) => t.id === mine.id)?.origin).toBe("agent");
  expect(tasks.find((t) => t.id === theirs)?.origin).toBe("user");
});

it("stop refuses a running task the user started, until force is passed", async () => {
  const theirs = await startAsUser("mcp guarded task");
  track(theirs);

  await expect(stop(theirs)).rejects.toThrow(/not started by this server/);
  // Still running: the refusal must not have half-stopped it.
  expect((await listTasks()).find((t) => t.id === theirs)?.status).toBe("RUNNING");

  const forced = await stop(theirs, true);
  expect(forced.id).toBe(theirs);
  expect(forced.status).not.toBe("RUNNING");
});

it("disposing a finished task is unguarded, since there is nothing to lose", async () => {
  const theirs = await startAsUser("mcp finished user task");
  track(theirs);
  await stop(theirs, true);
  // No force: the guard covers running tasks only.
  await expect(dispose(theirs)).resolves.toMatchObject({ disposed: true });
});

// The main way the provenance design could fail silently: if metadata were
// rebuilt on restart, the agent would lose the ability to stop its own tasks.
it("the provenance tag survives a restart", async () => {
  const mine = await run({ cmd: nodeCmd(stayAlive), name: "mcp restart origin", settleMs: 0 });
  track(mine.id);

  await restart(mine.id);
  expect((await listTasks()).find((t) => t.id === mine.id)?.origin).toBe("agent");
  // And it is still ours to stop without force.
  await expect(stop(mine.id)).resolves.toMatchObject({ id: mine.id });
});

// Task:stop calls finalize(CANCELED) before strategy:stop(), so the status is
// final as read, with no polling. Asserted so that if upstream ever makes it
// async, this fails rather than the status quietly becoming a lie.
it("stop reports a final status without any polling", async () => {
  const mine = await run({ cmd: nodeCmd(stayAlive), name: "mcp stop status", settleMs: 0 });
  track(mine.id);
  expect((await stop(mine.id)).status).toBe("CANCELED");
});
