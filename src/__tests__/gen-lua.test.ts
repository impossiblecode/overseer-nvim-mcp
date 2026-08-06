import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { composeChunk, emitModule, generate, keyFor, parseNeeds } from "../../scripts/gen-lua.js";

test("parseNeeds reads directive lines, whitespace-separated", () => {
  expect(parseNeeds("-- needs: nilify\nlocal x = 1\n")).toEqual(["nilify"]);
  expect(parseNeeds("-- needs: a b\n--needs: c\nreturn 1\n")).toEqual(["a", "b", "c"]);
  expect(parseNeeds("local x = 1\n")).toEqual([]);
});

test("parseNeeds stops at the first statement, so prose needs: comments are inert", () => {
  expect(parseNeeds("-- doc line\n\n-- needs: a\nlocal x = 1\n-- needs: b\n")).toEqual(["a"]);
  expect(parseNeeds("local x = 1\n-- needs: b\nreturn x\n")).toEqual([]);
});

test("keyFor uppercases the basename, snake intact", () => {
  expect(keyFor("run_template.lua")).toBe("RUN_TEMPLATE");
  expect(keyFor("nvim_cwd.lua")).toBe("NVIM_CWD");
});

test("composeChunk resolves needs transitively, deps first, deduped", () => {
  const preludes = new Map([
    ["nilify", "local function nilify(v) return v end\n"],
    ["resolve", "-- needs: nilify\nlocal function resolve(s) return nilify(s) end\n"],
  ]);
  const chunk = composeChunk("tail", "-- needs: resolve nilify\nreturn resolve(1)\n", preludes);
  const nilifyAt = chunk.indexOf("function nilify");
  const resolveAt = chunk.indexOf("function resolve");
  expect(nilifyAt).toBeGreaterThanOrEqual(0);
  expect(nilifyAt).toBeLessThan(resolveAt);
  expect(chunk.match(/function nilify/g)).toHaveLength(1);
  expect(chunk.endsWith("return resolve(1)\n")).toBe(true);
});

test("composeChunk rejects unknown preludes, cycles, and empty snippets", () => {
  expect(() => composeChunk("t", "-- needs: nope\nreturn 1\n", new Map())).toThrow(
    /unknown prelude "nope"/,
  );
  const cyclic = new Map([
    ["a", "-- needs: b\nlocal a = 1\n"],
    ["b", "-- needs: a\nlocal b = 1\n"],
  ]);
  expect(() => composeChunk("t", "-- needs: a\nreturn 1\n", cyclic)).toThrow(/cycle/);
  expect(() => composeChunk("t", "-- only a comment\n", new Map())).toThrow(/no Lua statements/);
});

test("composeChunk rejects a comment-only prelude", () => {
  const preludes = new Map([["nilify", "-- a comment where code should be\n"]]);
  expect(() => composeChunk("t", "-- needs: nilify\nreturn 1\n", preludes)).toThrow(
    /prelude "nilify" contains no Lua statements/,
  );
});

test("generate names a missing lua dir instead of leaking ENOENT", () => {
  expect(() => generate("/definitely/not/a/lua/dir")).toThrow(/no lua dir at/);
});

test("emitModule escapes hostile content and sorts keys", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the hostile payload needs a literal ${}
  const hostile = 'local s = "`${weird}"\n-- comment with ` backtick\n';
  const out = emitModule(
    new Map([
      ["B", "return 2\n"],
      ["A", hostile],
    ]),
  );
  expect(out.indexOf("A:")).toBeLessThan(out.indexOf("B:"));
  const literal = /A: (".*"),/.exec(out);
  expect(literal).not.toBeNull();
  expect(JSON.parse(literal![1]!)).toBe(hostile);
  expect(out).toContain("GENERATED");
  expect(out).toContain("as const;");
});

test("generate composes a directory end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-lua-"));
  mkdirSync(join(dir, "prelude"));
  writeFileSync(join(dir, "prelude", "nilify.lua"), "local function nilify(v) return v end\n");
  writeFileSync(join(dir, "tail.lua"), "-- needs: nilify\nreturn nilify(1)\n");
  const out = generate(dir);
  expect(out).toContain("TAIL:");
  expect(out).toContain("function nilify");
});
