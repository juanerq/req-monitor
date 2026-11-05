import fs from "node:fs";

export type ReqProgress = "running" | "success" | "error";

export function appendMonitorProgress(file: string, req: string, status: ReqProgress): void {
  fs.appendFileSync(file, `${JSON.stringify({ req, status })}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readMonitorProgress(file: string): Record<string, ReqProgress> {
  let lines: string;
  try {
    lines = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const progress: Record<string, ReqProgress> = {};
  for (const line of lines.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { req?: unknown; status?: unknown };
      if (typeof entry.req === "string" && /^REQ\d+$/i.test(entry.req) &&
        (entry.status === "running" || entry.status === "success" || entry.status === "error")) {
        progress[entry.req] = entry.status;
      }
    } catch { /* A truncated last write is not a completed check. */ }
  }
  return progress;
}
