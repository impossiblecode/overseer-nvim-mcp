import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { getRpc } from "../nvim.ts";
import { listTasks, listTemplates, run } from "../overseer.ts";
import { it, nodeCmd, sleep, trackTasks, waitForExit } from "./overseer.testkit.ts";

const track = trackTasks();

/** on_complete_dispose params on the live task */
async function disposeParams(
  id: number,
): Promise<{ timeout: number; require_view: string } | null> {
  const rpc = await getRpc();
  return rpc.execLua(
    `
    local id = ({...})[1]
    for _, t in ipairs(require('overseer').list_tasks({ include_ephemeral = true, wrapped = true })) do
      if t.id == id then
        for _, c in ipairs(t.components) do
          if c.name == 'on_complete_dispose' then
            return { timeout = c.params.timeout, require_view = table.concat(c.params.require_view, ',') }
          end
        end
      end
    end
    return nil
  `,
    [id],
  );
}

const listed = async (id: number) => (await listTasks()).some((t) => t.id === id);

async function waitForGone(id: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await listed(id))) return true;
    await sleep(100);
  }
  return false;
}

it("a finished cmd task disposes itself without anyone opening its output", async () => {
  const { id } = await run({
    cmd: nodeCmd("process.exit(0)"),
    name: "mcp dispose probe",
    disposeTimeout: 2,
  });
  track(id);
  await waitForExit(id);
  expect(await waitForGone(id)).toBe(true);
});

it("run defaults to a 300s timeout and no view requirement", async () => {
  const { id } = await run({
    cmd: nodeCmd("setTimeout(() => {}, 30000)"),
    name: "mcp dispose default",
  });
  track(id);
  expect(await disposeParams(id)).toEqual({ timeout: 300, require_view: "" });
});

it("disposeRequireView keeps a finished task until the user opens it", async () => {
  const { id } = await run({
    cmd: nodeCmd("process.exit(0)"),
    name: "mcp dispose keep",
    disposeTimeout: 1,
    disposeRequireView: true,
  });
  track(id);
  await waitForExit(id);
  expect(await disposeParams(id)).toEqual({
    timeout: 1,
    require_view: "SUCCESS,FAILURE,CANCELED",
  });

  // 3s against a 1s timeout. The clock never started; the buffer was never shown.
  await sleep(3000);
  expect(await listed(id)).toBe(true);
});

it("a template task gets the same disposal params as a cmd task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-dispose-tmpl-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "mcp-dispose-probe", scripts: { mcpdispose: "node -e 0" } }),
  );
  const templates = await listTemplates(dir);
  const probe = templates.find((t) => t.name.includes("mcpdispose"));
  expect(probe, `no mcpdispose template discovered in ${dir}`).toBeDefined();

  const { id } = await run({ template: probe!.name, cwd: dir, disposeTimeout: 42 });
  track(id);
  expect(await disposeParams(id)).toEqual({ timeout: 42, require_view: "" });
});
