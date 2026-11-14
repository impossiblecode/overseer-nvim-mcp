/**
 * Local dependency report: outdated packages, known vulnerabilities and the
 * pinned overseer.nvim ref. Exits 1 when any of them needs attention.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OVERSEER_REPO = "https://github.com/stevearc/overseer.nvim";

// same patterns as the custom manager in renovate.json
const PIN_SITES: [string, RegExp][] = [
  [".github/workflows/ci.yml", /OVERSEER_REF: (v[\d.]+)/],
  ["README.md", /tested against `(v[\d.]+)`/],
  ["CONTRIBUTING.md", /--branch (v[\d.]+) https:\/\/github\.com\/stevearc\/overseer\.nvim/],
];

function run(cmd: string, args: string[]): string {
  // pnpm is a .cmd shim on Windows
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (res.error) throw res.error;
  return res.stdout;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const major = (v: string) => Number(v.replace(/^v/, "").split(".")[0]);

type Outdated = Record<string, { current: string; latest: string }>;

function newestInMajor(name: string, m: number): string {
  const out = JSON.parse(run("pnpm", ["view", `${name}@${m}`, "version", "--json"])) as
    | string
    | string[];
  const versions = (Array.isArray(out) ? out : [out]).sort(compareVersions);
  const newest = versions.at(-1);
  if (newest === undefined) throw new Error(`no ${name}@${m} versions on the registry`);
  return newest;
}

function outdated(minNode: number): string[] {
  const raw = run("pnpm", ["outdated", "--format", "json"]).trim();
  const pkgs: Outdated = raw === "" ? {} : JSON.parse(raw);
  const lines: string[] = [];
  for (const [name, p] of Object.entries(pkgs)) {
    // @types/node tracks the lowest Node in engines, so newer majors don't count.
    // pnpm's `wanted` is just the locked version, so ask the registry.
    if (name === "@types/node" && major(p.latest) > minNode) {
      const newest = newestInMajor(name, minNode);
      if (compareVersions(newest, p.current) > 0) lines.push(`${name} ${p.current} -> ${newest}`);
      continue;
    }
    lines.push(`${name} ${p.current} -> ${p.latest}`);
  }
  return lines;
}

const SEVERITIES = ["critical", "high", "moderate", "low", "info"];

type Advisory = {
  module_name: string;
  severity: string;
  github_advisory_id: string;
  patched_versions: string;
};

function audit(): string[] {
  const report = JSON.parse(run("pnpm", ["audit", "--json"])) as {
    advisories?: Record<string, Advisory>;
  };
  if (report.advisories === undefined) throw new Error("pnpm audit returned no report");

  const byPackage = new Map<string, Advisory[]>();
  for (const a of Object.values(report.advisories)) {
    byPackage.set(a.module_name, [...(byPackage.get(a.module_name) ?? []), a]);
  }
  return [...byPackage].map(([name, advisories]) => {
    const counts = SEVERITIES.map((s) => [s, advisories.filter((a) => a.severity === s).length])
      .filter(([, n]) => n !== 0)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ");
    // one upgrade has to clear them all, so the highest floor wins
    const fixedIn = advisories
      .map((a) => a.patched_versions.replace(/^>=\s*/, ""))
      .sort(compareVersions)
      .at(-1);
    return `${name}: ${counts}, fixed in ${fixedIn}`;
  });
}

function overseerPin(): string[] {
  const lines: string[] = [];
  const pins = PIN_SITES.map(([file, re]) => {
    const ref = readFileSync(join(ROOT, file), "utf8").match(re)?.[1];
    if (ref === undefined) lines.push(`${file}: no overseer.nvim ref found`);
    return { file, ref };
  });
  const refs = [...new Set(pins.map((p) => p.ref).filter((r) => r !== undefined))];
  if (refs.length > 1) {
    lines.push(`pins disagree: ${pins.map((p) => `${p.file}=${p.ref}`).join(", ")}`);
  }

  const tags = run("git", ["ls-remote", "--tags", "--refs", OVERSEER_REPO])
    .split("\n")
    .map((l) => l.split("refs/tags/")[1])
    .filter((t): t is string => t !== undefined && /^v\d+\.\d+\.\d+$/.test(t))
    .sort(compareVersions);
  const latest = tags.at(-1);
  if (latest === undefined) throw new Error(`could not list tags of ${OVERSEER_REPO}`);
  for (const ref of refs) {
    if (compareVersions(latest, ref) > 0) lines.push(`overseer.nvim ${ref} -> ${latest}`);
  }
  return lines;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const minNode = Number(/\d+/.exec(pkg.engines.node)?.[0]);

const checks: [string, () => string[]][] = [
  ["outdated packages", () => outdated(minNode)],
  ["vulnerabilities (dev included, the bundle ships them)", audit],
  ["overseer.nvim pin", overseerPin],
];

let dirty = false;
for (const [title, check] of checks) {
  let lines: string[];
  try {
    lines = check();
  } catch (e) {
    lines = [`check failed: ${e instanceof Error ? e.message : String(e)}`];
  }
  console.log(`${lines.length === 0 ? "✓" : "✗"} ${title}`);
  for (const line of lines) console.log(`    ${line}`);
  if (lines.length > 0) dirty = true;
}
process.exitCode = dirty ? 1 : 0;
