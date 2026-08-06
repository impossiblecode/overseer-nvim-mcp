import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";
import { getRpc, insideNvim } from "../nvim.js";
import { dispose, listTasks, type TaskInfo } from "../overseer.js";

/**
 * Shared fixtures for the overseer.*.test.ts files. Not a .test.ts itself,
 * so vitest does not collect it.
 */

/** These need a live nvim with overseer. Skip cleanly outside one. */
export const it = insideNvim() ? test : test.skip;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// node rather than sh: there is no sh on Windows, and the runner guarantees a
// node on every platform. cmd is an argv array, so nothing goes via a shell.
export const nodeCmd = (src: string) => ["node", "-e", src];
export const stayAlive = "setTimeout(() => {}, 30000)";

/**
 * Register an afterAll that disposes every task the caller tracked. Per-file,
 * since vitest gives each file its own module instance. Disposes with force:
 * some tests create user-originated tasks the guard would refuse.
 */
export function trackTasks(): (...ids: number[]) => void {
  const started: number[] = [];
  afterAll(async () => {
    for (const id of started) await dispose(id, true).catch(() => {});
  });
  return (...ids: number[]) => {
    started.push(...ids);
  };
}

/** Poll until the task reports an exit_code. */
export async function waitForExit(id: number, timeoutMs = 5000): Promise<TaskInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = (await listTasks()).find((t) => t.id === id);
    if (task?.exit_code !== undefined) return task;
    await sleep(50);
  }
  throw new Error(`task ${id} did not report an exit_code within ${timeoutMs}ms`);
}

/** Start a task the way the *user* would: directly, with no provenance tag. */
export async function startAsUser(name: string): Promise<number> {
  const res = await (await getRpc()).execLua<{ id: number }>(
    `
    local name, cmd = ({...})[1], ({...})[2]
    local t = require('overseer').new_task({ cmd = cmd, name = name })
    t:start()
    return { id = t.id }
  `,
    [name, nodeCmd(stayAlive)],
  );
  return res.id;
}

const FIXTURES = fileURLToPath(new URL("../../ci/fixtures/", import.meta.url));
export const fixture = (name: string) => join(FIXTURES, name);

const hasBinary = (bin: string) => spawnSync(bin, ["--version"]).error === undefined;

/**
 * Missing binary: fatal in CI, loud skip locally. A provider that quietly
 * stops being covered is the failure the fixtures exist to catch.
 */
export function ensureBinary(bin: string): boolean {
  if (hasBinary(bin)) return true;
  if (process.env.CI) {
    throw new Error(`${bin} is not installed; provider coverage must not be skipped in CI`);
  }
  console.warn(`[provider fixtures] ${bin} not installed; skipping its coverage locally`);
  return false;
}
