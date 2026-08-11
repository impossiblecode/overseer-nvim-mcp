import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decoder, encode } from "@msgpack/msgpack";
import { expect, test } from "vitest";
import { NvimRpc } from "../rpc.js";

const isWindows = process.platform === "win32";

// Windows IPC is a named pipe under \\.\pipe\; elsewhere a unix socket, kept
// short because macOS caps sun_path at 104 bytes.
const sockPath = (n: string) =>
  isWindows
    ? `\\\\.\\pipe\\ovm-${process.pid}-${n}`
    : join(tmpdir(), `ovm-${process.pid}-${n}.sock`);

// node:net won't bind over a stale socket file (EADDRINUSE), which a crashed
// run leaves behind. Named pipes have no filesystem entry to clear.
async function listen(sock: string, onConn: (s: Socket) => void): Promise<Server> {
  if (!isWindows) await unlink(sock).catch(() => {});
  const server = createServer(onConn);
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  // close() hangs on live connections, so destroy them first.
  (server as Server & { destroyAll(): void }).destroyAll = () => {
    for (const s of sockets) s.destroy();
  };
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return server;
}

async function stop(server: Server): Promise<void> {
  (server as Server & { destroyAll(): void }).destroyAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Mock msgpack-RPC server: echoes back the first Lua arg as the result,
// so responses are deterministic and no nvim is needed.
async function startMock(sock: string) {
  return listen(sock, (s) => {
    s.on("data", async (chunk: Buffer) => {
      const dec = new Decoder();
      const src = (async function* () {
        yield new Uint8Array(chunk);
      })();
      for await (const m of dec.decodeStream(src)) {
        const [type, id, , params] = m as [number, number, string, unknown[]];
        if (type !== 0) continue;
        const [, args] = params as [string, unknown[]];
        s.write(encode([1, id, null, args[0] ?? null]));
      }
    });
  });
}

test("correlates concurrent responses by msgid", async () => {
  const sock = sockPath("c");
  const server = await startMock(sock);
  const rpc = new NvimRpc();
  await rpc.connect(sock);
  const out = await Promise.all([11, 22, 33].map((n) => rpc.execLua<number>("return ...", [n])));
  expect(out).toEqual([11, 22, 33]);
  rpc.close();
  await stop(server);
});

test("passes hostile args as data rather than code", async () => {
  const sock = sockPath("h");
  const server = await startMock(sock);
  const rpc = new NvimRpc();
  await rpc.connect(sock);
  const hostile = 'x") os.exit(1) --';
  expect(await rpc.execLua<string>("return ...", [hostile])).toBe(hostile);
  rpc.close();
  await stop(server);
});

test("fails a pending call when nvim dies mid-request", async () => {
  const sock = sockPath("d");
  // Accepts the connection, never replies.
  const server = await listen(sock, () => {});
  const rpc = new NvimRpc();
  await rpc.connect(sock);
  const pending = rpc.execLua("return 1", [], 30000);
  await stop(server);
  await expect(pending).rejects.toThrow(/nvim is no longer running/);
  rpc.close();
});

test("rejects a call made after nvim has already died, rather than hanging", async () => {
  const sock = sockPath("e");
  const server = await listen(sock, () => {});
  const rpc = new NvimRpc();
  await rpc.connect(sock);
  await stop(server);
  // Let the close event reach the client before the next call.
  await new Promise((r) => setTimeout(r, 50));
  const startedAt = Date.now();
  await expect(rpc.execLua("return 1", [], 30000)).rejects.toThrow();
  expect(Date.now() - startedAt).toBeLessThan(2000);
  rpc.close();
});

test("rejects with a timeout message when nvim never responds", async () => {
  const sock = sockPath("t");
  // Server that accepts the connection but never replies.
  const server = await listen(sock, () => {});
  const rpc = new NvimRpc();
  await rpc.connect(sock);
  await expect(rpc.execLua("return 1", [], 60)).rejects.toThrow(/did not respond within 60ms/);
  rpc.close();
  await stop(server);
});
