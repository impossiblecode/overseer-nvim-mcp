import { expect } from "vitest";
import { run, tail } from "../overseer.js";
import { it, nodeCmd, sleep, stayAlive, trackTasks } from "./overseer.testkit.js";

const track = trackTasks();

it("tail returns lines with no trailing blank padding", async () => {
  const { id } = await run({
    cmd: nodeCmd(`console.log("alpha"); console.log("beta"); ${stayAlive}`),
    name: "mcp tail probe",
  });
  track(id);
  await sleep(700);
  const { lines } = await tail(id, { lines: 100 });
  expect(lines.length).toBeGreaterThan(0);
  expect(/\S/.test(lines[lines.length - 1]!)).toBe(true); // last line is not blank padding
});

it("tail reads RPC-started output and strips CR + ANSI color codes", async () => {
  // Started over RPC in terminal mode, output lands in strategy.pending_output,
  // not the task buffer. The PTY doubles the CR on top of the emitted SGR codes.
  const { id } = await run({
    cmd: nodeCmd(
      `process.stdout.write("\\x1b[32mGREEN\\x1b[0m\\r\\nplain line\\r\\n"); ${stayAlive}`,
    ),
    name: "mcp clean probe",
  });
  track(id);
  await sleep(600);
  const { lines } = await tail(id, { lines: 100 });
  expect(lines).toContain("GREEN");
  expect(lines).toContain("plain line");
  expect(lines.some((l) => l.includes("\r") || l.includes("\x1b"))).toBe(false);
});

// Writes spaced out so each arrives as its own jobstart chunk, unlike the
// single-burst probes above. Chunk boundaries turning into blank lines only
// happens on this path.
it("tail joins chunk boundaries for output emitted over time", async () => {
  const { id } = await run({
    cmd: nodeCmd(
      `let i = 0; const t = setInterval(() => { console.log("line-" + i); if (++i === 4) clearInterval(t); }, 80); ${stayAlive}`,
    ),
    name: "mcp chunked probe",
  });
  track(id);
  await sleep(1000);
  expect((await tail(id, { lines: 100 })).lines).toEqual(["line-0", "line-1", "line-2", "line-3"]);
});

// Interval output again, one chunk per line. Assert exact arrays: an off-by-one
// since window would slip past a substring check.
it("tail since returns only new lines, and reports where the block starts", async () => {
  const { id } = await run({
    cmd: nodeCmd(
      `let i = 0; const t = setInterval(() => { console.log("evt-" + i); if (++i === 4) clearInterval(t); }, 80); ${stayAlive}`,
    ),
    name: "mcp since probe",
    settleMs: 0,
  });
  track(id);
  await sleep(1000);

  const all = await tail(id, { lines: 100 });
  expect(all.lines).toEqual(["evt-0", "evt-1", "evt-2", "evt-3"]);
  expect(all.total).toBe(4);
  expect(all.from).toBe(1);

  // Resume from an already-seen total and only the new lines come back.
  const delta = await tail(id, { lines: 100, since: 2 });
  expect(delta.lines).toEqual(["evt-2", "evt-3"]);
  expect(delta.from).toBe(3);
  expect(delta.total).toBe(4);

  // Fully caught up: no lines, and total is unchanged so it stays a valid cursor.
  const caughtUp = await tail(id, { lines: 100, since: 4 });
  expect(caughtUp.lines).toEqual([]);
  expect(caughtUp.total).toBe(4);
});

it("tail wait_for returns as soon as a line matches, well before the timeout", async () => {
  const { id } = await run({
    // The marker only arrives on the fourth tick, so a wait that returned the
    // first read would miss it.
    cmd: nodeCmd(
      `let i = 0; const t = setInterval(() => { console.log(i === 3 ? "SERVER READY" : "boot-" + i); if (++i === 4) clearInterval(t); }, 150); ${stayAlive}`,
    ),
    name: "mcp waitfor probe",
    settleMs: 0,
  });
  track(id);

  const startedAt = Date.now();
  const res = await tail(id, { waitFor: "SERVER READY", timeoutMs: 10000 });
  expect(res.waited).toBe("matched");
  expect(res.lines).toContain("SERVER READY");
  expect(Date.now() - startedAt).toBeLessThan(9000);
});

it("tail wait_for reports a timeout distinctly rather than looking like success", async () => {
  const { id } = await run({
    cmd: nodeCmd(`console.log("nothing interesting"); ${stayAlive}`),
    name: "mcp timeout probe",
    settleMs: 0,
  });
  track(id);

  const res = await tail(id, { waitFor: "NEVER APPEARS", timeoutMs: 900 });
  expect(res.waited).toBe("timeout");
  expect(res.status).toBe("RUNNING");
});

it("tail wait_for stops early when the task exits without matching", async () => {
  const { id } = await run({ cmd: nodeCmd("process.exit(7)"), settleMs: 0 });
  track(id);

  const startedAt = Date.now();
  const res = await tail(id, { waitFor: "NEVER APPEARS", timeoutMs: 30000 });
  expect(res.waited).toBe("exited");
  expect(res.exit_code).toBe(7);
  // The point is not burning the full 30s budget on a task that can never match.
  expect(Date.now() - startedAt).toBeLessThan(10000);
});

it("run reports an immediate failure instead of returning a bare id", async () => {
  const res = await run({
    cmd: nodeCmd(`console.error("boom"); process.exit(9)`),
    name: "mcp settle probe",
  });
  track(res.id);
  expect(res.exit_code).toBe(9);
  expect(res.lines?.join("\n")).toContain("boom");
});

it("run with settle_ms 0 returns immediately without status", async () => {
  const res = await run({
    cmd: nodeCmd(`console.log("x"); ${stayAlive}`),
    name: "mcp nosettle probe",
    settleMs: 0,
  });
  track(res.id);
  expect(res.id).toBeGreaterThan(0);
  expect(res.status).toBeUndefined();
});
