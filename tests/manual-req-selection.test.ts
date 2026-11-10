import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { mergeReqResults } from "../monitor-req.ts";

test("selected results replace only matching REQs and retain the other rows in order", () => {
  const existing = [
    { req: "REQ101", title: "Previous A" },
    { req: "REQ102", title: "Previous B" },
    { req: "REQ103", title: "Previous C" },
  ];
  assert.deepEqual(mergeReqResults(existing, [{ req: "REQ102", title: "New B" }]), [
    existing[0], { req: "REQ102", title: "New B" }, existing[2],
  ]);
  assert.deepEqual(existing.map((row) => row.title), ["Previous A", "Previous B", "Previous C"]);
  assert.deepEqual(mergeReqResults(existing, [{ req: "REQ104", title: "New D" }]), [
    ...existing, { req: "REQ104", title: "New D" },
  ]);
});

test("invalid manual selections never start the monitor or mutate saved data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-monitor-manual-selection-"));
  const artifacts = path.join(dir, "artifacts");
  fs.mkdirSync(artifacts);
  const files = [path.join(dir, "reqs.txt"), path.join(artifacts, "monitor-results.json"), path.join(artifacts, "req-status.json")];
  fs.writeFileSync(files[0], "REQ101\nREQ102\n");
  fs.writeFileSync(files[1], '[{"req":"REQ101","status":"Finalizado","checkedAt":"2026-11-05T10:00:00.000Z","title":"Previous A"}]\n');
  fs.writeFileSync(files[2], '{"REQ101":{"conversationStatus":"Respondida","lastChecked":"2026-11-05"}}\n');
  fs.writeFileSync(path.join(dir, "settings.json"), '{"allowOutsideHoursRuns":true}\n');
  const hash = () => files.map((file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  const before = hash();
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ["--import", "tsx", "monitor-api.ts"], {
    cwd: path.join(import.meta.dirname, ".."), stdio: "ignore",
    env: { ...process.env, MONITOR_API_HOST: "127.0.0.1", MONITOR_API_PORT: String(address.port),
      MONITOR_RUN_ON_START: "false", MONITOR_INTERVAL_MINUTES: "0", REQ_FILE: files[0], ARTIFACTS_DIR: artifacts,
      MONITOR_SETTINGS_FILE: path.join(dir, "settings.json"), AUTH_FILE: path.join(dir, "auth.json") },
  });
  try {
    const base = `http://127.0.0.1:${address.port}`;
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { ready = (await fetch(`${base}/health`)).ok; if (ready) break; } catch { await delay(50); }
    }
    assert.ok(ready, "isolated API must start with scheduling disabled");
    for (const reqs of [[], ["REQ999"], "REQ101", ["not-a-req"], ["REQ101"], ["REQ101", "REQ102"]]) {
      const response = await fetch(`${base}/api/monitor/run`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reqs }),
      });
      assert.equal(response.status, Array.isArray(reqs) && reqs.includes("REQ101") ? 409 : 400);
      assert.deepEqual(hash(), before);
      const status = await (await fetch(`${base}/api/monitor/status`)).json();
      assert.equal(status.running, false);
      assert.equal(status.selectedReqs, null);
    }
    const locked = await (await fetch(`${base}/api/dashboard`)).json();
    assert.deepEqual(locked.lockedReqs, ["REQ101"]);
    const unlock = await fetch(`${base}/api/reqs/REQ101/lock`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locked: false }),
    });
    assert.equal(unlock.status, 200);
    assert.deepEqual((await (await fetch(`${base}/api/dashboard`)).json()).lockedReqs, []);
    assert.deepEqual(hash(), before, "unlock must not modify configured REQs or previous results/state");
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.deepEqual(settings.unlockedFinalizedReqs, { REQ101: "2026-11-05T10:00:00.000Z" });
    fs.writeFileSync(files[1], '[{"req":"REQ101","status":"Finalizado","title":"Legacy result"}]\n');
    const missingRevisionUnlock = await fetch(`${base}/api/reqs/REQ101/lock`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locked: false }),
    });
    assert.equal(missingRevisionUnlock.status, 409);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).unlockedFinalizedReqs,
      { REQ101: "2026-11-05T10:00:00.000Z" });
    fs.writeFileSync(files[1], '[{"req":"REQ101","status":"Finalizado","checkedAt":"2026-11-05T11:00:00.000Z","title":"New analysis"}]\n');
    assert.deepEqual((await (await fetch(`${base}/api/dashboard`)).json()).lockedReqs, ["REQ101"],
      "the next finalized result re-locks the REQ without a live monitor");
    const relock = await fetch(`${base}/api/reqs/REQ101/lock`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locked: true }),
    });
    assert.equal(relock.status, 200);
    assert.deepEqual((await (await fetch(`${base}/api/dashboard`)).json()).lockedReqs, ["REQ101"]);
    const beforeAdd = files.slice(1).map((file) => fs.readFileSync(file, "utf8"));
    const added = await fetch(`${base}/api/reqs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reqs: ["REQ103"] }),
    });
    assert.equal(added.status, 201);
    assert.deepEqual((await added.json()).reqs, ["REQ101", "REQ102", "REQ103"]);
    assert.deepEqual(files.slice(1).map((file) => fs.readFileSync(file, "utf8")), beforeAdd,
      "adding REQs does not analyze them or change Teams notification state");
    assert.equal((await (await fetch(`${base}/api/monitor/status`)).json()).running, false);
    for (const value of [-1, 1.5, "5", 1441]) {
      const invalid = await fetch(`${base}/api/settings/interval`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intervalMinutes: value }),
      });
      assert.equal(invalid.status, 400);
    }
    for (const value of [30, 0]) {
      const updated = await fetch(`${base}/api/settings/interval`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intervalMinutes: value }),
      });
      assert.equal(updated.status, 200);
      assert.equal((await (await fetch(`${base}/api/dashboard`)).json()).schedule.intervalMinutes, value);
      assert.equal((await (await fetch(`${base}/api/monitor/status`)).json()).running, false);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).intervalMinutes, 0);
    const repositoryResult = [{ req: "REQ102", status: "En curso", checkedAt: "2026-11-06T10:00:00.000Z",
      requestDetails: { requestType: "Creacion y configuracion de repositorios/pipelines" },
      description: "Configurar pipeline para los siguientes repositorios:\nNombre: PaymentsApi\nProyecto: Platform\nNombre: BillingWorker\nProyecto: Platform",
      microservices: [] },
    { req: "REQ103", status: "En curso", description: "Nombre: Someone\nProyecto: Platform",
      requestDetails: { requestType: "Consulta general" }, microservices: [] }];
    fs.writeFileSync(files[1], `${JSON.stringify(repositoryResult)}\n`);
    const savedBeforeRead = hash();
    const projected = await fetch(`${base}/api/dashboard`);
    assert.equal(projected.status, 200);
    const dashboard = await projected.json();
    assert.deepEqual(dashboard.results[0].microservices, ["PaymentsApi", "BillingWorker"]);
    assert.deepEqual(dashboard.results[1].microservices, [], "unrelated requests remain unchanged");
    assert.deepEqual(hash(), savedBeforeRead, "dashboard enrichment must not rewrite saved results");
    assert.equal((await (await fetch(`${base}/api/monitor/status`)).json()).running, false);
    for (const invalidResults of ["{", '[{"status":"Finalizado"}]']) {
      fs.writeFileSync(files[1], invalidResults);
      const unchanged = hash();
      const dashboardResponse = await fetch(`${base}/api/dashboard`);
      assert.equal(dashboardResponse.status, 200, "dashboard stays readable when stored results are corrupt");
      assert.deepEqual((await dashboardResponse.json()).lockedReqs, ["REQ101", "REQ102", "REQ103"],
        "corrupt results must not make any REQ selectable");
      const refused = await fetch(`${base}/api/monitor/run`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reqs: ["REQ102"] }),
      });
      assert.notEqual(refused.status, 200, "manual runs must still fail closed");
      assert.deepEqual(hash(), unchanged, "rejected run must not modify persisted data");
      assert.equal((await (await fetch(`${base}/api/monitor/status`)).json()).running, false);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
