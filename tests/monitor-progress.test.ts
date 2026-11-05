import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendMonitorProgress, readMonitorProgress } from "../monitor-progress.ts";

test("per-REQ progress is private, ordered and distinguishable from unvisited REQs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-monitor-progress-"));
  try {
    const file = path.join(dir, "progress.jsonl");
    assert.deepEqual(readMonitorProgress(file), {});
    appendMonitorProgress(file, "REQ101", "running");
    assert.deepEqual(readMonitorProgress(file), { REQ101: "running" });
    appendMonitorProgress(file, "REQ101", "success");
    appendMonitorProgress(file, "REQ102", "running");
    appendMonitorProgress(file, "REQ102", "error");
    assert.deepEqual(readMonitorProgress(file), { REQ101: "success", REQ102: "error" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, "", { mode: 0o600 });
    assert.deepEqual(readMonitorProgress(file), {}, "a new run must not reuse previous progress");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("incomplete trailing progress and invalid entries never invent a result", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-monitor-progress-"));
  try {
    const file = path.join(dir, "progress.jsonl");
    fs.writeFileSync(file, '{"req":"REQ101","status":"success"}\n{"req":"REQ102","status":"');
    assert.deepEqual(readMonitorProgress(file), { REQ101: "success" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
