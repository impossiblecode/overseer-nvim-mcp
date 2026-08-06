import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, test } from "vitest";
import { run } from "../overseer.js";
import { registerResources } from "../resources.js";
import { it, nodeCmd, stayAlive, trackTasks } from "./overseer.testkit.js";

const track = trackTasks();

type ReadCb = (
  uri: URL,
  vars?: Record<string, string>,
) => Promise<{ contents: { text: string }[] }>;

type Registered = { uri: string; isTemplate: boolean; cb: ReadCb };

function capture(): Map<string, Registered> {
  const server = new McpServer({ name: "t", version: "0" });
  const found = new Map<string, Registered>();
  server.registerResource = ((
    name: string,
    uriOrTemplate: string | { uriTemplate: { toString(): string } },
    _config: unknown,
    cb: ReadCb,
  ) => {
    const isTemplate = typeof uriOrTemplate !== "string";
    found.set(name, {
      uri: isTemplate ? uriOrTemplate.uriTemplate.toString() : uriOrTemplate,
      isTemplate,
      cb,
    });
    return undefined as never;
  }) as never;
  registerResources(server);
  return found;
}

test("registers a task list resource and a per-task output template", () => {
  const res = capture();
  expect([...res.keys()].sort()).toEqual(["task-output", "tasks"]);
  expect(res.get("tasks")?.uri).toBe("overseer://tasks");
  expect(res.get("tasks")?.isTemplate).toBe(false);
  expect(res.get("task-output")?.uri).toBe("overseer://task/{id}/output");
  expect(res.get("task-output")?.isTemplate).toBe(true);
});

it("the tasks resource returns parseable JSON carrying origin", async () => {
  const entry = capture().get("tasks")!;
  const started = await run({
    cmd: nodeCmd(stayAlive),
    name: "mcp resource probe",
    settleMs: 0,
  });
  track(started.id);

  const out = await entry.cb(new URL("overseer://tasks"));
  const tasks = JSON.parse(out.contents[0]!.text) as { id: number; origin: string }[];
  expect(tasks.find((t) => t.id === started.id)?.origin).toBe("agent");
});

it("the task output resource leads with a status line, then the raw output", async () => {
  const entry = capture().get("task-output")!;
  const started = await run({
    cmd: nodeCmd(`console.log("res-alpha"); ${stayAlive}`),
    name: "mcp resource output probe",
  });
  track(started.id);

  const out = await entry.cb(new URL(`overseer://task/${started.id}/output`), {
    id: String(started.id),
  });
  const [status, ...lines] = out.contents[0]!.text.split("\n");
  // Status first so an attached log is never mistaken for a finished one.
  expect(status).toMatch(/^status=RUNNING total=\d+/);
  expect(lines).toContain("res-alpha");
});

it("the task output resource rejects a non-numeric id rather than tailing something else", async () => {
  const entry = capture().get("task-output")!;
  await expect(
    entry.cb(new URL("overseer://task/not-a-number/output"), { id: "not-a-number" }),
  ).rejects.toThrow(/not a task id/);
});
