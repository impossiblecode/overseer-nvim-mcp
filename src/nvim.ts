import { NvimRpc } from "./rpc.js";

export class NvimUnavailableError extends Error {
  constructor(message = "not running inside nvim ($NVIM is unset)") {
    super(message);
    this.name = "NvimUnavailableError";
  }
}

export function nvimSocket(): string | null {
  return process.env.NVIM ?? null;
}

export function insideNvim(): boolean {
  return nvimSocket() !== null;
}

let rpc: NvimRpc | null = null;

export async function getRpc(): Promise<NvimRpc> {
  const sock = nvimSocket();
  if (!sock) throw new NvimUnavailableError();
  if (rpc) return rpc;
  const next = new NvimRpc();
  await next.connect(sock);
  rpc = next;
  return rpc;
}
