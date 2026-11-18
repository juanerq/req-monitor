import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("manual missing tags persist per REQ without changing monitoring data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-monitor-missing-tags-"));
  const artifacts = path.join(dir, "artifacts");
  fs.mkdirSync(artifacts);
  const reqFile = path.join(dir, "reqs.txt");
  const resultsFile = path.join(artifacts, "monitor-results.json");
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(reqFile, "REQ101\nREQ102\n");
  fs.writeFileSync(resultsFile, '[{"req":"REQ101","status":"En curso"}]\n');
  fs.writeFileSync(settingsFile, '{"allowOutsideHoursRuns":true,"intervalMinutes":0,"unlockedFinalizedReqs":{"REQ102":"2026-11-05T10:00:00.000Z"}}\n');
  const dataHash = () => [reqFile, resultsFile].map((file) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ["--import", "tsx", "monitor-api.ts"], {
    cwd: path.join(import.meta.dirname, ".."), stdio: "ignore",
    env: { ...process.env, HOME: dir, MONITOR_API_HOST: "127.0.0.1", MONITOR_API_PORT: String(address.port),
      MONITOR_RUN_ON_START: "false", MONITOR_INTERVAL_MINUTES: "0", TEAMS_WEBHOOK_URL: "",
      REQ_FILE: reqFile, ARTIFACTS_DIR: artifacts, MONITOR_SETTINGS_FILE: settingsFile,
      AUTH_FILE: path.join(dir, "auth.json") },
  });
  try {
    const base = `http://127.0.0.1:${address.port}`;
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { ready = (await fetch(`${base}/health`)).ok; if (ready) break; } catch { await delay(50); }
    }
    assert.ok(ready, "isolated API must start without running the monitor");
    const dashboard = () => fetch(`${base}/api/dashboard`).then((response) => response.json());
    const save = (req: string, tags: unknown) => fetch(`${base}/api/reqs/${req}/missing-tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags }),
    });
    assert.deepEqual((await dashboard()).missingTags, {});
    const before = dataHash();
    const initialSettings = fs.readFileSync(settingsFile, "utf8");
    for (const [req, tags, status] of [
      ["REQ999", ["documentation_md"], 404],
      ["REQ101", ["unknown"], 400],
      ["REQ101", ["documentation_md", "documentation_md"], 400],
      ["REQ101", "documentation_md", 400],
    ] as const) {
      const rejected = await save(req, tags);
      assert.equal(rejected.status, status);
      assert.equal(fs.readFileSync(settingsFile, "utf8"), initialSettings);
      assert.deepEqual(dataHash(), before);
    }
    const tags = ["documentation_md", "logging_standard", "consumption_example"];
    const saved = await save("REQ101", tags);
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).tags, tags);
    assert.deepEqual((await dashboard()).missingTags, { REQ101: tags });
    assert.deepEqual(dataHash(), before);
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(settings.allowOutsideHoursRuns, true);
    assert.equal(settings.intervalMinutes, 0);
    assert.deepEqual(settings.missingTags, { REQ101: tags });
    assert.deepEqual(settings.unlockedFinalizedReqs, { REQ102: "2026-11-05T10:00:00.000Z" });
    fs.writeFileSync(resultsFile, '[{"req":"REQ101","status":"Finalizado"}]\n');
    assert.deepEqual((await dashboard()).missingTags, { REQ101: tags }, "monitor results cannot erase manual tags");
    const removed = await save("REQ101", []);
    assert.equal(removed.status, 200);
    assert.deepEqual((await dashboard()).missingTags, {});
    await save("REQ101", ["documentation_md"]);
    const deleted = await fetch(`${base}/api/reqs/REQ101`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual((await dashboard()).missingTags, {});
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).missingTags, {});
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).unlockedFinalizedReqs,
      { REQ102: "2026-11-05T10:00:00.000Z" });
    const replaced = await fetch(`${base}/api/reqs?replace=true`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reqs: ["REQ103"] }),
    });
    assert.equal(replaced.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).unlockedFinalizedReqs, {});
    assert.deepEqual((await dashboard()).missingTags, {});
    assert.equal((await fetch(`${base}/api/monitor/status`).then((response) => response.json())).running, false);
    fs.writeFileSync(settingsFile, '{"missingTags":{"REQ102":["unknown"]}}\n');
    const corruptSettings = fs.readFileSync(settingsFile, "utf8");
    assert.notEqual((await fetch(`${base}/api/dashboard`)).status, 200);
    assert.notEqual((await save("REQ102", ["logging_standard"])).status, 200);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), corruptSettings);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
