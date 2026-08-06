import { expect, test } from "vitest";

/** Pure mirror of the Lua trailing-blank trim in src/lua/tail.lua. */
function trimTrailingBlanks(lines: string[]): string[] {
  let last = lines.length;
  while (last > 0 && !/\S/.test(lines[last - 1]!)) last--;
  return lines.slice(0, last);
}

/** Pure mirror of the Lua pending_output chunk join in src/lua/tail.lua. */
function joinChunks(chunks: string[][]): string[] {
  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    if (out.length === 0) {
      out.push(...chunk);
      continue;
    }
    out[out.length - 1] += chunk[0]!;
    for (let i = 1; i < chunk.length; i++) out.push(chunk[i]!);
  }
  return out;
}

test("drops trailing blank padding, keeps interior blanks", () => {
  const grid = ["output line 1", "", "output line 3", "", "", "", ""];
  expect(trimTrailingBlanks(grid)).toEqual(["output line 1", "", "output line 3"]);
});

test("all-blank buffer trims to empty", () => {
  expect(trimTrailingBlanks(["", "", ""])).toEqual([]);
});

test("no trailing blanks is unchanged", () => {
  expect(trimTrailingBlanks(["a", "b"])).toEqual(["a", "b"]);
});

// Per :h channel-lines, the last element of a chunk is a partial line that the
// next chunk's first element continues. One line per write therefore arrives
// as ["line", ""], and appending both verbatim invents a blank line each time.
test("chunk boundary markers do not become blank lines", () => {
  const chunks = [
    ["tick-7", ""],
    ["tick-8", ""],
    ["tick-9", ""],
  ];
  expect(trimTrailingBlanks(joinChunks(chunks))).toEqual(["tick-7", "tick-8", "tick-9"]);
});

test("a line split across two chunks is rejoined", () => {
  expect(joinChunks([["abc"], ["def", ""]])).toEqual(["abcdef", ""]);
});

test("a chunk carrying several complete lines keeps them separate", () => {
  expect(joinChunks([["a", "b", ""]])).toEqual(["a", "b", ""]);
});

test("empty chunk list yields no lines", () => {
  expect(joinChunks([])).toEqual([]);
});
