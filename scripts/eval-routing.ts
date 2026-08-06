/**
 * Routing evals: does the agent pick overseer_run for long-running commands
 * and its own shell for short ones? Exercises the published tool descriptions
 * and INSTRUCTIONS against real clients, since only a real client has the
 * shell tool overseer_run competes with.
 *
 * Manual only: every run costs real agent tokens. Keep it out of precommit
 * and CI.
 *
 * Any headless agent CLI can be an adapter (see AGENTS). Rates differ per
 * agent and model, so calibrate each combination on its own.
 *
 * Prerequisites: `pnpm build`, the agent's binary and `nvim` on PATH, and an
 * overseer clone (defaults to /tmp/overseer, override with OVERSEER_PATH):
 *   git clone --depth 1 --branch v2.1.0 https://github.com/stevearc/overseer.nvim /tmp/overseer
 *
 * Usage: pnpm eval:routing [--agent claude] [--model NAME] [--runs 3]
 *                          [--jobs 4] [--only substring] [--json FILE]
 *
 * The copilot adapter reaches non-Claude models through one binary:
 *   pnpm eval:routing --agent copilot --model gemini-3.1-pro-preview
 *   pnpm eval:routing --agent copilot --model gpt-5.3-codex
 *
 * The codex and agy adapters run their native CLIs, with approval checks
 * bypassed: headless codex auto-denies mutating MCP tools and headless agy
 * auto-denies the mcp permission, so without the bypass every should-route
 * query would lose to the shell:
 *   pnpm eval:routing --agent codex
 *   pnpm eval:routing --agent agy
 * agy reads MCP servers only from ~/.gemini/config/mcp_config.json; the eval
 * swaps that file in for the run and restores it on exit.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "overseer-nvim-mcp.mjs");
const MINIMAL_INIT = join(ROOT, "ci", "minimal_init.lua");
const QUERIES = join(ROOT, "scripts", "eval-routing.queries.json");
const OVERSEER_PATH = process.env.OVERSEER_PATH ?? "/tmp/overseer";
const RUN_TIMEOUT_MS = 300_000;
const ROUTE_TOOL = "overseer_run";

interface EvalQuery {
  query: string;
  should_route: boolean;
}

interface Agent {
  bin: string;
  /** Argv after the binary name. The MCP config json attaches this repo's server. */
  args: (query: string, mcpConfigJson: string, model: string | undefined, ws: string) => string[];
  /** True when the run called overseer_run. */
  detect: (stdout: string) => boolean;
  /** Mutates state outside the workspaces before any run; returns the undo. */
  setup?: () => () => void;
}

interface Args {
  agent: string;
  model?: string;
  runs: number;
  jobs: number;
  only?: string;
  json?: string;
}

interface Task {
  qi: number;
  query: EvalQuery;
  run: number;
}

interface Outcome {
  routed: boolean;
  errored: boolean;
}

interface Row {
  query: string;
  should_route: boolean;
  routed: number;
  runs: number;
  errors: number;
  route_rate: number;
  verdict: "PASS" | "FAIL" | "ERR";
}

/**
 * The workspace each invocation runs in. Scripts are real so either routing
 * choice actually works: dev and test:watch never exit, test and build do.
 * The lockfile makes the npm provider discover the scripts as templates.
 */
const WORKSPACE_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "eval-ws",
      private: true,
      scripts: {
        dev: "node server.js",
        "test:watch": "node server.js",
        test: "node test.js",
        build: "node -e \"console.log('built')\"",
      },
    },
    null,
    2,
  ),
  "package-lock.json": JSON.stringify({ name: "eval-ws", lockfileVersion: 3 }, null, 2),
  "server.js": [
    'console.log("compiling...");',
    'setTimeout(() => console.log("ready - listening on http://localhost:3000"), 400);',
    'setInterval(() => console.log("tick"), 900);',
    "",
  ].join("\n"),
  "test.js": 'console.log("2 passed, 0 failed");\n',
};

function parseArgs(argv: string[]): Args {
  const out: Args = { agent: "claude", runs: 3, jobs: 4 };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`);
    switch (argv[i]) {
      case "--agent":
        out.agent = value;
        break;
      case "--model":
        out.model = value;
        break;
      case "--runs":
        out.runs = Number(value);
        break;
      case "--jobs":
        out.jobs = Number(value);
        break;
      case "--only":
        out.only = value;
        break;
      case "--json":
        out.json = value;
        break;
      default:
        throw new Error(`unknown arg: ${argv[i]}`);
    }
  }
  return out;
}

function parseQueries(raw: unknown): EvalQuery[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`${QUERIES}: expected a non-empty array`);
  return raw.map((entry, i) => {
    const item = entry as Partial<EvalQuery>;
    if (typeof item?.query !== "string" || item.query.length === 0)
      throw new Error(`${QUERIES}[${i}]: 'query' must be a non-empty string`);
    if (typeof item.should_route !== "boolean")
      throw new Error(`${QUERIES}[${i}]: 'should_route' must be a boolean`);
    return { query: item.query, should_route: item.should_route };
  });
}

/** Walks any JSON shape for tool_use blocks; survives output-format changes. */
function claudeCalledRouteTool(stdout: string): boolean {
  let found = false;
  const walk = (node: unknown): void => {
    if (found || node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "tool_use" && record.name === `mcp__overseer__${ROUTE_TOOL}`) {
      found = true;
      return;
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(JSON.parse(stdout));
  return found;
}

const AGENTS: Record<string, Agent> = {
  claude: {
    bin: "claude",
    args: (query, mcpConfigJson, model) => [
      "-p",
      query,
      "--output-format",
      "json",
      // don't pick up the user's own settings
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigJson,
      "--disallowed-tools",
      "Task",
      // both tools must be callable, or a permission denial decides the
      // routing
      "--allowedTools",
      "Bash,mcp__overseer",
      "--max-turns",
      "8",
      ...(model ? ["--model", model] : []),
    ],
    detect: claudeCalledRouteTool,
  },
  // Fronts Claude, GPT, Gemini and Kimi models; `copilot help config` lists
  // the ids for --model.
  copilot: {
    bin: "copilot",
    args: (query, mcpConfigJson, model) => [
      "-p",
      query,
      "--no-color",
      "--allow-all-tools",
      // copilot only injects MCP instructions for allowlisted servers, and
      // ours have to reach the model for routing to happen at all
      "--allow-all-mcp-server-instructions",
      "--output-format",
      "json",
      "--additional-mcp-config",
      mcpConfigJson,
      ...(model ? ["--model", model] : []),
    ],
    // JSONL; tool.execution_start fires when the call actually runs
    detect: (stdout) =>
      stdout.split("\n").some((line) => {
        if (!line.startsWith("{")) return false;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            data?: { toolName?: string };
          };
          return (
            event.type === "tool.execution_start" &&
            event.data?.toolName === `overseer-${ROUTE_TOOL}`
          );
        } catch {
          return false;
        }
      }),
  },
  codex: {
    bin: "codex",
    args: (query, mcpConfigJson, model) => {
      const server = (
        JSON.parse(mcpConfigJson) as {
          mcpServers: { overseer: { command: string; args: string[] } };
        }
      ).mcpServers.overseer;
      return [
        "exec",
        query,
        "--json",
        "--skip-git-repo-check",
        // don't pick up the user's config.toml (auth still comes from
        // CODEX_HOME)
        "--ignore-user-config",
        // headless codex auto-denies mutating MCP tools, overseer_run
        // included; acceptable here, every run is confined to a throwaway
        // workspace
        "--dangerously-bypass-approvals-and-sandbox",
        // JSON strings and string arrays are valid TOML values as-is.
        "-c",
        `mcp_servers.overseer.command=${JSON.stringify(server.command)}`,
        "-c",
        `mcp_servers.overseer.args=${JSON.stringify(server.args)}`,
        // codex whitelists env per MCP server; NVIM has to be listed or
        // the server registers no tools
        "-c",
        'mcp_servers.overseer.env_vars=["NVIM"]',
        ...(model ? ["-m", model] : []),
      ];
    },
    // JSONL; an mcp_tool_call item only appears once the call executes
    detect: (stdout) =>
      stdout.split("\n").some((line) => {
        if (!line.startsWith("{")) return false;
        try {
          const event = JSON.parse(line) as {
            item?: { type?: string; server?: string; tool?: string };
          };
          return (
            event.item?.type === "mcp_tool_call" &&
            event.item.server === "overseer" &&
            event.item.tool === ROUTE_TOOL
          );
        } catch {
          return false;
        }
      }),
  },
  // Antigravity CLI. Verified against 1.1.10.
  agy: {
    bin: "agy",
    args: (query, _mcpConfigJson, model, ws) => [
      "-p",
      query,
      "--output-format",
      "stream-json",
      // agy works out of its own scratch dir rather than the cwd; point it
      // at the real workspace or it finds no project and gives up
      "--add-dir",
      ws,
      // headless agy auto-denies the mcp permission, and allow-rules only
      // exist in user-global settings; the per-run flag avoids touching those
      "--dangerously-skip-permissions",
      ...(model ? ["--model", model] : []),
    ],
    // JSONL. MCP calls go through the generic call_mcp_tool; the ACTIVE step
    // is the call executing (permission checks precede it).
    detect: (stdout) =>
      stdout.split("\n").some((line) => {
        if (!line.startsWith("{")) return false;
        try {
          const event = JSON.parse(line) as {
            step_update?: {
              step_type?: string;
              tool_name?: string;
              tool_info?: { parameters?: { ServerName?: string; ToolName?: string } };
            };
          };
          const step = event.step_update;
          return (
            step?.step_type === "tool" &&
            step.tool_name === "call_mcp_tool" &&
            step.tool_info?.parameters?.ServerName === "overseer" &&
            step.tool_info.parameters.ToolName === ROUTE_TOOL
          );
        } catch {
          return false;
        }
      }),
    // print mode only reads the user-global config; workspace-level
    // .agents/mcp_config.json and .gemini/settings.json are ignored
    // (verified on 1.1.10). Swap the global file in, restore after. No env
    // block needed: agy passes its environment through, so each parallel
    // invocation keeps its own NVIM.
    setup: () => {
      const config = join(homedir(), ".gemini", "config", "mcp_config.json");
      const previous = existsSync(config) ? readFileSync(config, "utf8") : null;
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(
        config,
        JSON.stringify({ mcpServers: { overseer: { command: "node", args: [DIST] } } }),
      );
      return () => {
        if (previous === null) rmSync(config, { force: true });
        else writeFileSync(config, previous);
      };
    },
  },
};

function waitForSocket(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const poll = (): void => {
      if (existsSync(path)) {
        resolvePromise(true);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolvePromise(false);
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

/**
 * Every invocation gets its own workspace and headless nvim. A shared nvim
 * leaks state: run one's dev server shows up as running_task_id for run two,
 * which then (correctly) tails it instead of starting anything.
 */
async function invoke(agent: Agent, query: string, model?: string): Promise<string | null> {
  const ws = mkdtempSync(join(tmpdir(), "eval-routing-"));
  for (const [name, content] of Object.entries(WORKSPACE_FILES)) {
    writeFileSync(join(ws, name), content);
  }
  const sock = join(ws, "nvim.sock");
  const nvim = spawn("nvim", ["--headless", "-u", MINIMAL_INIT, "--listen", sock], {
    cwd: ws,
    env: { ...process.env, OVERSEER_PATH },
    stdio: "ignore",
  });
  try {
    if (!(await waitForSocket(sock, 5000))) return null;
    const mcpConfig = JSON.stringify({
      mcpServers: { overseer: { command: "node", args: [DIST] } },
    });
    return await new Promise((resolvePromise) => {
      // own process group: agent children can inherit the stdout pipe and
      // outlive the agent (agy leaves its MCP server running), which keeps
      // 'close' from firing. Killing the group catches them.
      const child = spawn(agent.bin, agent.args(query, mcpConfig, model, ws), {
        cwd: ws,
        env: { ...process.env, NVIM: sock },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
      let stdout = "";
      let code: number | null = null;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const killGroup = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      // a timeout still counts: an agent that foregrounds a never-exiting
      // dev server in its shell hits the timer with its routing decision
      // already in the transcript
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, RUN_TIMEOUT_MS);
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        killGroup();
        resolvePromise(code === 0 || timedOut ? stdout : null);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on("error", settle);
      // 'close' means stdout drained. If an orphan holds the pipe open,
      // 'exit' plus a grace period settles instead, and the group kill then
      // closes the pipe.
      child.on("close", settle);
      child.on("exit", (exitCode) => {
        code = exitCode;
        grace = setTimeout(settle, 2000);
      });
    });
  } finally {
    nvim.kill("SIGKILL");
    rmSync(ws, { recursive: true, force: true });
  }
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
}

function verdictFor(
  query: EvalQuery,
  routed: number,
  errors: number,
  runs: number,
): Row["verdict"] {
  // errored runs get their own verdict, or a runner that never executes
  // would report every should-not-route query as PASS at 0%
  if (errors > 0) return "ERR";
  const rate = routed / runs;
  if (query.should_route) return rate > 0.5 ? "PASS" : "FAIL";
  return rate < 0.5 ? "PASS" : "FAIL";
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const agent = AGENTS[args.agent];
  if (!agent) {
    console.error(`✗ unknown agent '${args.agent}'; available: ${Object.keys(AGENTS).join(", ")}`);
    return 2;
  }

  const missing: string[] = [];
  if (!existsSync(DIST)) missing.push("dist bundle missing; run `pnpm build`");
  if (!existsSync(OVERSEER_PATH))
    missing.push(`no overseer clone at ${OVERSEER_PATH}; see the header for the clone command`);
  for (const message of missing) console.error(`✗ ${message}`);
  if (missing.length > 0) return 2;

  const queries = parseQueries(JSON.parse(readFileSync(QUERIES, "utf8"))).filter(
    (q) => !args.only || q.query.includes(args.only),
  );
  if (queries.length === 0) {
    console.error(`✗ no queries match --only ${args.only}`);
    return 2;
  }

  const tasks: Task[] = [];
  for (const [qi, query] of queries.entries()) {
    for (let run = 0; run < args.runs; run++) tasks.push({ qi, query, run });
  }

  const results = new Map<string, Outcome>();
  let done = 0;
  const via = args.model ? `${args.agent}/${args.model}` : args.agent;
  process.stderr.write(`${tasks.length} ${via} invocations, ${args.jobs} at a time\n`);
  const restore = agent.setup?.();
  try {
    await pool(tasks, args.jobs, async (task) => {
      const stdout = await invoke(agent, task.query.query, args.model);
      let outcome: Outcome = { routed: false, errored: true };
      if (stdout !== null) {
        try {
          outcome = { routed: agent.detect(stdout), errored: false };
        } catch {
          outcome = { routed: false, errored: true };
        }
      }
      results.set(`${task.qi}.${task.run}`, outcome);
      done++;
      process.stderr.write(`\r  ${done}/${tasks.length}`);
    });
  } finally {
    restore?.();
  }
  process.stderr.write("\n");

  const report: Row[] = queries.map((query, qi) => {
    let routed = 0;
    let errors = 0;
    for (let run = 0; run < args.runs; run++) {
      const outcome = results.get(`${qi}.${run}`);
      if (!outcome || outcome.errored) errors++;
      else if (outcome.routed) routed++;
    }
    return {
      query: query.query,
      should_route: query.should_route,
      routed,
      runs: args.runs,
      errors,
      route_rate: routed / args.runs,
      verdict: verdictFor(query, routed, errors, args.runs),
    };
  });

  console.log(`\n── routing (${args.runs} runs/query)`);
  for (const row of report) {
    const mark = row.verdict === "PASS" ? "✓" : "✗";
    const pct = `${Math.round(row.route_rate * 100)}%`.padStart(4);
    const want = String(row.should_route).padEnd(5);
    console.log(
      `  ${mark} ${row.verdict.padEnd(4)} want=${want} rate=${pct}  ${row.query.slice(0, 62)}`,
    );
  }

  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nresults written to ${args.json}`);
  }

  console.log("");
  if (report.some((row) => row.verdict !== "PASS")) {
    console.error("✗ routing evals: at least one query missed its threshold");
    return 1;
  }
  console.log("✓ routing evals: all queries within threshold");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
