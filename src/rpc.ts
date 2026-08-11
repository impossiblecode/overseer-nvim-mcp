import { createConnection, type Socket } from "node:net";
import { Decoder, encode } from "@msgpack/msgpack";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * Minimal msgpack-RPC client for a single nvim socket. $NVIM is a unix socket
 * on POSIX and a named pipe on Windows; node:net takes both as `path`.
 * Request:  [0, msgid, method, params]
 * Response: [1, msgid, error, result]
 * Only nvim_exec_lua is used. Args ride as msgpack values (arrive as `...`
 * in Lua), so no user input is ever interpolated into Lua source.
 */
export class NvimRpc {
  private conn: Socket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private queue: Uint8Array[] = [];
  private notify: (() => void) | null = null;
  private closed = false;
  private dead = false;

  async connect(sock: string): Promise<void> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection({ path: sock });
      const onConnectError = (e: Error) => {
        s.destroy();
        reject(e);
      };
      s.once("error", onConnectError);
      s.once("connect", () => {
        s.off("error", onConnectError);
        resolve(s);
      });
    });

    // Buffer views a pooled ArrayBuffer Node reuses, so copy rather than retain.
    socket.on("data", (chunk: Buffer) => {
      this.queue.push(new Uint8Array(chunk));
      this.notify?.();
    });
    // Linux reports a peer that died with unread data as ECONNRESET; macOS
    // just closes. Same meaning, so same message.
    socket.on("error", (e: Error) => {
      this.dead = true;
      this.failAll(new Error(`nvim is no longer running (${e.message})`));
    });
    socket.on("close", () => {
      this.dead = true;
      if (!this.closed) this.failAll(new Error("nvim is no longer running"));
    });

    this.conn = socket;
    void this.readLoop();
  }

  private async *chunks(): AsyncGenerator<Uint8Array> {
    while (!this.closed) {
      if (this.queue.length === 0) await new Promise<void>((r) => (this.notify = r));
      while (this.queue.length) yield this.queue.shift()!;
    }
  }

  private async readLoop(): Promise<void> {
    const decoder = new Decoder();
    for await (const msg of decoder.decodeStream(this.chunks())) {
      const [type, id, err, result] = msg as [number, number, unknown, unknown];
      if (type !== 1) continue; // 1 = response
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (err) p.reject(new Error(Array.isArray(err) ? String(err[1]) : String(err)));
      else p.resolve(result);
    }
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  execLua<T = unknown>(code: string, args: unknown[] = [], timeoutMs = 15000): Promise<T> {
    if (!this.conn) return Promise.reject(new Error("not connected"));
    // A write on the dead socket would just sit there until timeoutMs.
    if (this.dead) return Promise.reject(new Error("nvim is no longer running"));
    const id = this.nextId++;
    const req = encode([0, id, "nvim_exec_lua", [code, args]]);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`nvim did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.conn!.write(req);
    });
  }

  close(): void {
    this.closed = true;
    this.conn?.end();
    // Wake chunks() or readLoop parks on a promise nobody resolves.
    this.notify?.();
  }
}
