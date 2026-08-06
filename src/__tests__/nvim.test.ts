import { expect, test } from "vitest";
import { getRpc, insideNvim, NvimUnavailableError, nvimSocket } from "../nvim.js";

test("insideNvim reflects $NVIM presence", () => {
  const saved = process.env.NVIM;
  try {
    delete process.env.NVIM;
    expect(nvimSocket()).toBeNull();
    expect(insideNvim()).toBe(false);
  } finally {
    if (saved !== undefined) process.env.NVIM = saved;
  }
});

test("getRpc rejects with NvimUnavailableError when $NVIM unset", async () => {
  const saved = process.env.NVIM;
  try {
    delete process.env.NVIM;
    await expect(getRpc()).rejects.toBeInstanceOf(NvimUnavailableError);
  } finally {
    if (saved !== undefined) process.env.NVIM = saved;
  }
});
