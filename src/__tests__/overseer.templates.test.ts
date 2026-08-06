import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getRpc } from "../nvim.js";
import { diagnose, listTemplates, run } from "../overseer.js";
import { ensureBinary, fixture, it, trackTasks } from "./overseer.testkit.js";

const track = trackTasks();

// Not Array.isArray: LUA.TEMPLATES seeds its result to an empty table and
// returns it if the vim.wait expires, so an is-it-an-array assertion goes green
// precisely when require('overseer.template'), the most fragile internal reach
// in this codebase, stops calling back. Assert real discovery instead.
it("listTemplates actually discovers templates, rather than returning empty on failure", async () => {
  const names = (await listTemplates(process.cwd())).map((t) => t.name);
  expect(names.some((n) => n.includes("precommit"))).toBe(true);
});

// Template discovery and template running must agree about what `cwd` means.
// The tmpdir is somewhere nvim's cwd is not, which is what breaks the lookup.
it("run(template) resolves a template from an explicit cwd, not nvim's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tmpl-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "mcp-tmpl-probe", scripts: { mcpprobe: "node -e 0" } }),
  );

  const templates = await listTemplates(dir);
  const probe = templates.find((t) => t.name.includes("mcpprobe"));
  expect(probe, `no mcpprobe template discovered in ${dir}`).toBeDefined();

  const { id } = await run({ template: probe!.name, cwd: dir });
  track(id);
  expect(id).toBeGreaterThan(0);
});

// Templates from just, cargo and rake declare params, and overseer prompts the
// user for any that are missing. Over RPC that opens a form in the editor and
// RUN_TEMPLATE's vim.wait then burns its full 10s before reporting a timeout,
// leaving the form orphaned. RUN_TEMPLATE passes disallow_prompt to turn that
// into an error instead.
//
// The probe is registered through the RPC layer rather than via a provider, so
// the assertion does not depend on just/cargo/rake being installed. condition.dir
// scopes it to the tmpdir, so it never shows up in the user's own template list.
it("run(template) errors on a missing required param instead of prompting", async () => {
  // realpath: on macOS mkdtemp returns /var/... while overseer resolves the
  // /private/var symlink, and condition.dir would then never match.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mcp-param-")));
  const rpc = await getRpc();
  await rpc.execLua(
    `
    local dir = ({...})[1]
    require('overseer').register_template({
      name = 'mcp param probe',
      condition = { dir = dir },
      -- Neither optional nor defaulted, so it is the case that prompts.
      params = { thing = { type = 'string' } },
      builder = function() return { cmd = { 'node', '-e', '0' } } end,
    })
    -- overseer memoizes its provider list on runtimepath (template.lua
    -- get_providers), so a register_template issued after any listing has
    -- already happened is silently ignored. Appending to rtp is what forces
    -- the rebuild. The path need not exist.
    vim.opt.runtimepath:append(dir)
  `,
    [dir],
  );

  // A directly registered template has no module. Asserted as an explicit
  // null for the same reason desc is: absent and none-to-report must not
  // look alike.
  const listed = await listTemplates(dir, "mcp param probe");
  expect(listed).toHaveLength(1);
  expect(listed[0]?.provider).toBeNull();

  try {
    const startedAt = Date.now();
    // Not overseer's own "Missing param thing": run_task discards the build
    // error (commands.lua binds it to _), so RUN_TEMPLATE reconstructs which
    // params were required rather than reporting the template as missing.
    await expect(run({ template: "mcp param probe", cwd: dir })).rejects.toThrow(
      /requires params: thing/,
    );
    // Failing fast is the actual assertion: a prompt would leave RUN_TEMPLATE
    // blocked until its 10s vim.wait expires, so anything near that means the
    // form opened and the caller only saw a timeout.
    expect(Date.now() - startedAt).toBeLessThan(3000);
  } finally {
    // Leave the user's runtimepath as we found it, whatever the outcome.
    await rpc.execLua(`vim.opt.runtimepath:remove(({...})[1])`, [dir]);
  }
});

// process.cwd() is wherever the MCP client was launched; overseer's providers
// search nvim's cwd regardless. Defaulting to anything but nvim's would make
// the omitted-dir case disagree with what discovery actually does, and
// diagnose would then report a mismatch the server had introduced itself.
it("with no cwd, discovery uses nvim's cwd rather than the server process's", async () => {
  const d = await diagnose();
  expect(d.dir).toBe(d.nvim_cwd);

  const implicit = (await listTemplates()).map((t) => t.name);
  const explicit = (await listTemplates(d.nvim_cwd)).map((t) => t.name);
  expect(implicit).toEqual(explicit);
});

it("params are rejected for a raw cmd, where they mean nothing", async () => {
  await expect(run({ cmd: ["true"], params: { a: 1 } })).rejects.toThrow(/applies to `template`/);
});

// Provider fixtures.
//
// The server is provider-agnostic on purpose; these tests are where provider
// knowledge belongs, because their job is to prove the agnostic code survives
// contact with each one. The five fixtures span the *shape* space rather than
// the ecosystem space: overseer ships 15 builtin providers, but only desc
// presence and params presence actually vary, so the other ten add languages
// and no new shapes.

/**
 * Templates the fixture itself declares, ignoring anything inherited from
 * nvim's cwd. Does not re-sort: the server promises described entries first,
 * then by name, and the assertions below check the order a caller actually
 * receives.
 */
async function fixtureTemplates(name: string) {
  const all = await listTemplates(fixture(name));
  return all.filter((t) => t.name.includes("fixture-"));
}

// Plain `test` because this needs no nvim; the guard it checks is what stands
// between CI and silently losing a provider.
test("ensureBinary throws under CI instead of skipping", () => {
  const prev = process.env.CI;
  process.env.CI = "1";
  try {
    expect(() => ensureBinary("mcp-definitely-not-a-real-binary")).toThrow(
      /must not be skipped in CI/,
    );
  } finally {
    if (prev === undefined) delete process.env.CI;
    else process.env.CI = prev;
  }
});

test("ensureBinary skips, and says so, when CI is unset", () => {
  const prev = process.env.CI;
  delete process.env.CI;
  try {
    expect(ensureBinary("mcp-definitely-not-a-real-binary")).toBe(false);
  } finally {
    if (prev !== undefined) process.env.CI = prev;
  }
});

it("npm fixture is discovered, and carries no desc because npm supplies none", async () => {
  if (!ensureBinary("npm")) return;
  const tmpls = await fixtureTemplates("npm");
  expect(tmpls.map((t) => t.name)).toEqual([
    "npm fixture-build (mcp-fixture-npm)",
    "npm fixture-watch (mcp-fixture-npm)",
  ]);
  expect(tmpls.every((t) => !t.desc)).toBe(true);
});

it("make fixture is discovered, and carries no desc", async () => {
  if (!ensureBinary("make")) return;
  const tmpls = await fixtureTemplates("make");
  expect(tmpls.map((t) => t.name)).toEqual(["make fixture-make-build", "make fixture-make-test"]);
  expect(tmpls.every((t) => !t.desc)).toBe(true);
});

// vscode needs no binary at all; it is a pure tasks.json read, which is why it
// is worth covering despite adding no language to the matrix.
it("vscode fixture maps detail to desc, and omits it when absent", async () => {
  const tmpls = await fixtureTemplates("vscode");
  expect(tmpls.map((t) => t.name)).toEqual(["fixture-vscode-build", "fixture-vscode-plain"]);
  expect(tmpls[0]?.desc).toBe("Build the vscode fixture");
  expect(tmpls[1]?.desc).toBeFalsy();
});

it("gotask fixture supplies a desc for every task", async () => {
  if (!ensureBinary("task")) return;
  const tmpls = await fixtureTemplates("gotask");
  expect(tmpls.map((t) => t.name)).toEqual([
    "task fixture-task-build",
    "task fixture-task-serve",
    "task fixture-task-watch",
  ]);
  expect(tmpls.every((t) => typeof t.desc === "string" && t.desc.length > 0)).toBe(true);
});

// just is the only builtin provider that emits desc AND params together, which
// is why it is worth one binary in CI.
it("just fixture supplies desc per documented recipe, and none for an undocumented one", async () => {
  if (!ensureBinary("just")) return;
  const tmpls = await fixtureTemplates("just");
  expect(tmpls.map((t) => t.name)).toEqual([
    "just fixture-just-build",
    "just fixture-just-generate",
    "just fixture-just-undocumented",
  ]);
  expect(tmpls[0]?.desc).toBe("Build the just fixture");
  expect(tmpls[1]?.desc).toBe("Generate output for a language");
  expect(tmpls[2]?.desc).toBeFalsy();
});

it("templates carry their provider, and an absent desc survives as explicit null", async () => {
  if (!ensureBinary("just")) return;
  const tmpls = await fixtureTemplates("just");
  expect(tmpls.map((t) => t.provider)).toEqual(["just", "just", "just"]);
  // Not undefined: Lua drops nil keys, so a dropped field and a provider that
  // supplies no description would otherwise be indistinguishable.
  const undocumented = tmpls.find((t) => t.name.endsWith("undocumented"));
  expect(undocumented?.desc).toBeNull();
  expect("desc" in (undocumented ?? {})).toBe(true);
});

it("described templates sort ahead of undescribed ones across providers", async () => {
  if (!ensureBinary("npm") || !ensureBinary("make") || !ensureBinary("task")) return;
  const tmpls = await fixtureTemplates("multi");
  // gotask supplies a desc and npm/make do not, so the informative entry leads
  // regardless of which provider overseer happened to iterate first.
  expect(tmpls.map((t) => t.provider)).toEqual(["task", "make", "npm"]);
  expect(tmpls[0]?.desc).toBeTruthy();
  expect(tmpls[1]?.desc).toBeNull();
  expect(tmpls[2]?.desc).toBeNull();
});

it("multi fixture discovers npm, make and gotask together from one directory", async () => {
  if (!ensureBinary("npm") || !ensureBinary("make") || !ensureBinary("task")) return;
  const names = (await fixtureTemplates("multi")).map((t) => t.name);
  // Described first, then by name; see the ordering test above.
  expect(names).toEqual([
    "task fixture-multi-task",
    "make fixture-multi-make",
    "npm fixture-multi-npm (mcp-fixture-multi)",
  ]);
});

it("filter narrows by name or desc", async () => {
  if (!ensureBinary("just")) return;
  const byName = await listTemplates(fixture("just"), "undocumented");
  expect(byName.map((t) => t.name)).toEqual(["just fixture-just-undocumented"]);
  // "language" appears only in a desc.
  const byDesc = await listTemplates(fixture("just"), "language");
  expect(byDesc.map((t) => t.name)).toEqual(["just fixture-just-generate"]);
});

it("params are surfaced with required, and omitted entirely when there are none", async () => {
  if (!ensureBinary("just")) return;
  const tmpls = await fixtureTemplates("just");
  const generate = tmpls.find((t) => t.name.endsWith("generate"));
  expect(generate?.params).toEqual([{ name: "lang", type: "string", required: true }]);
  expect(tmpls.find((t) => t.name.endsWith("build"))?.params).toBeUndefined();
});

// The synthetic probe above proves our handling of params; this proves a real
// provider still emits them, so an upstream change shows up here.
it("running a real just recipe without its required param errors rather than prompting", async () => {
  if (!ensureBinary("just")) return;
  const startedAt = Date.now();
  await expect(
    run({ template: "just fixture-just-generate", cwd: fixture("just") }),
  ).rejects.toThrow(/requires params: lang/);
  expect(Date.now() - startedAt).toBeLessThan(3000);
});

it("a template that declares params runs once they are supplied", async () => {
  if (!ensureBinary("just")) return;
  const res = await run({
    template: "just fixture-just-generate",
    cwd: fixture("just"),
    params: { lang: "python" },
  });
  track(res.id);
  expect(res.id).toBeGreaterThan(0);
  expect(res.lines?.join("\n")).toContain("python");
});

it("running_task_id flags a template that already has a task running", async () => {
  if (!ensureBinary("task")) return;
  const before = await fixtureTemplates("gotask");
  expect(before.every((t) => t.running_task_id === undefined)).toBe(true);

  const res = await run({ template: "task fixture-task-serve", cwd: fixture("gotask") });
  track(res.id);

  const during = await fixtureTemplates("gotask");
  const serve = during.find((t) => t.name.endsWith("serve"));
  expect(serve?.running_task_id).toBe(res.id);
  // Only the one that is running, so it stays a usable signal.
  expect(during.filter((t) => t.running_task_id !== undefined)).toHaveLength(1);
});
