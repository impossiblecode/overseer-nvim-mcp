import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, test } from "vitest";
import { formatTail, registerTools } from "../tools.js";

test("registers all seven overseer tools", () => {
  const server = new McpServer({ name: "overseer", version: "0.1.0" });
  const names: string[] = [];
  const orig = server.registerTool.bind(server);
  server.registerTool = (name: string, ...rest: unknown[]) => {
    names.push(name);
    return orig(name, ...(rest as [never, never]));
  };
  registerTools(server);
  expect(names.sort()).toEqual(
    [
      "overseer_dispose",
      "overseer_list_tasks",
      "overseer_restart",
      "overseer_run",
      "overseer_stop",
      "overseer_tail",
      "overseer_list_templates",
    ].sort(),
  );
});

test("formatTail puts status first and leaves the output lines raw", () => {
  expect(formatTail({ lines: ["a", "b"], from: 3, total: 4, status: "RUNNING" })).toBe(
    "status=RUNNING total=4 from=3\na\nb",
  );
});

test("formatTail reports an empty tail as a header alone instead of an empty string", () => {
  // total is still a usable cursor here, so an empty result must not be blank.
  expect(formatTail({ lines: [], from: 0, total: 0, status: "PENDING" })).toBe(
    "status=PENDING total=0",
  );
});

test("formatTail includes exit_code and waited when present", () => {
  const out = formatTail({
    lines: ["done"],
    from: 1,
    total: 1,
    status: "FAILURE",
    exit_code: 3,
    waited: "timeout",
  });
  expect(out).toBe("status=FAILURE exit_code=3 total=1 from=1 waited=timeout\ndone");
});

test("formatTail keeps exit_code 0 visible rather than dropping it as falsy", () => {
  expect(formatTail({ lines: [], from: 0, total: 0, status: "SUCCESS", exit_code: 0 })).toContain(
    "exit_code=0",
  );
});

test("overseer_run description states the lifetime boundary", () => {
  const server = new McpServer({ name: "overseer", version: "0.1.0" });
  let runDesc = "";
  const orig = server.registerTool.bind(server);
  server.registerTool = (name: string, config: { description?: string }, cb: never) => {
    if (name === "overseer_run") runDesc = config.description ?? "";
    return orig(name, config as never, cb);
  };
  registerTools(server);
  expect(runDesc.toLowerCase()).toContain("long-running");
  expect(runDesc.toLowerCase()).toContain("bash");
  // A cmd is transient. Left unsaid, "most repos declare no templates, pass
  // cmd" reads as the complete answer even when the user wants something that
  // outlives the session. That is how this description once mis-steered an
  // agent into telling a user a persistent task was not possible.
  expect(runDesc.toLowerCase()).toContain("one-off");
  expect(runDesc.toLowerCase()).toContain("persist");
});
