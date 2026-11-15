import type { TailResult } from "./overseer.ts";

/**
 * Status header plus the raw lines, as plain text so the output isn't
 * JSON-escaped. Used by both overseer_tail and the `wait` CLI.
 */
export function formatTail(res: TailResult): string {
  const header = [
    `status=${res.status}`,
    res.exit_code === undefined ? null : `exit_code=${res.exit_code}`,
    `total=${res.total}`,
    res.lines.length > 0 ? `from=${res.from}` : null,
    res.waited === undefined ? null : `waited=${res.waited}`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  return res.lines.length > 0 ? `${header}\n${res.lines.join("\n")}` : header;
}
