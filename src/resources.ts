import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as overseer from "./overseer.js";

/**
 * The user or client attaches these; the model has no access to them. Tools
 * cover the agent's side, and these let a user drop the task list or a log
 * straight into context.
 */
export function registerResources(server: McpServer): void {
  server.registerResource(
    "tasks",
    "overseer://tasks",
    {
      title: "Overseer tasks",
      description:
        "Every overseer task with its status, exit code, command and origin. Attach it to give " +
        "the conversation the current state of the task list without a tool call.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await overseer.listTasks(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "task-output",
    new ResourceTemplate("overseer://task/{id}/output", {
      // Enumerated so a client can list the existing tasks up front, with no
      // id lookup needed.
      list: async () => {
        const tasks = await overseer.listTasks();
        return {
          resources: tasks.map((t) => ({
            uri: `overseer://task/${t.id}/output`,
            name: `${t.name} (${t.status})`,
            mimeType: "text/plain",
          })),
        };
      },
      complete: {
        id: async (value) =>
          (await overseer.listTasks())
            .map((t) => String(t.id))
            .filter((id) => id.startsWith(value)),
      },
    }),
    {
      title: "Overseer task output",
      description:
        "A single task's output, preceded by its status line. Reads both the terminal buffer " +
        "and the pending output of a task started over RPC, so it is populated whether or not " +
        "the overseer panel has been opened.",
      mimeType: "text/plain",
    },
    async (uri, { id }) => {
      const taskId = Number(Array.isArray(id) ? id[0] : id);
      if (!Number.isInteger(taskId)) {
        throw new overseer.OverseerError(`not a task id: ${String(id)}`);
      }
      const res = await overseer.tail(taskId, { lines: 1000 });
      const status = [
        `status=${res.status}`,
        res.exit_code === undefined ? null : `exit_code=${res.exit_code}`,
        `total=${res.total}`,
      ]
        .filter((part) => part !== null)
        .join(" ");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: `${status}\n${res.lines.join("\n")}`,
          },
        ],
      };
    },
  );
}
