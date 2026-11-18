import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("dashboard exposes only a qualified stated date for comments with unknown order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-monitor-date-only-"));
  const artifacts = path.join(dir, "artifacts");
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(dir, "reqs.txt"), "REQ123\n");
  const comment = { author: "Operations", date: null, isResponse: true,
    text: "Esperamos tu información antes del día 🕦 12/11/2026 🕦" };
  const resultsFile = path.join(artifacts, "monitor-results.json");
  fs.writeFileSync(resultsFile, JSON.stringify([{ req: "REQ123", status: "Pendiente",
    conversationStatus: "Respondida", activeDeadline: null,
    latestOperationsComment: comment,
    comments: [comment, { author: "Requester", date: null, isResponse: false, text: "Initial request" }],
  }]));
  const previousResults = fs.readFileSync(resultsFile);
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ["--import", "tsx", "monitor-api.ts"], {
    cwd: path.join(import.meta.dirname, ".."), stdio: "ignore",
    env: { ...process.env, HOME: dir, MONITOR_API_HOST: "127.0.0.1", MONITOR_API_PORT: String(address.port),
      MONITOR_RUN_ON_START: "false", MONITOR_INTERVAL_MINUTES: "0", TEAMS_WEBHOOK_URL: "",
      REQ_FILE: path.join(dir, "reqs.txt"), ARTIFACTS_DIR: artifacts,
      MONITOR_SETTINGS_FILE: path.join(dir, "settings.json"), AUTH_FILE: path.join(dir, "auth.json") },
  });
  try {
    const base = `http://127.0.0.1:${address.port}`;
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { ready = (await fetch(`${base}/health`)).ok; if (ready) break; } catch { await delay(50); }
    }
    assert.ok(ready, "isolated dashboard API starts without running the monitor");
    const response = await fetch(`${base}/api/dashboard`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.results[0].statedDeadlineDate, "2026-11-12");
    assert.equal(data.results[0].deadlineOrderKnown, false);
    assert.equal(data.results[0].activeDeadline, null);
    assert.deepEqual(fs.readFileSync(resultsFile), previousResults);
    const dated = { ...comment, date: "9 nov 2026, 18:02" };
    fs.writeFileSync(resultsFile, JSON.stringify([{ req: "REQ123", status: "Pendiente",
      conversationStatus: "Pendiente de respuesta", activeDeadline: null,
      latestOperationsComment: dated,
      comments: [dated, { author: "Requester", date: "4 nov 2026, 15:19", isResponse: false, text: "Initial request" }],
    }]));
    const confirmed = (await (await fetch(`${base}/api/dashboard`)).json()).results[0];
    assert.equal(confirmed.statedDeadlineDate, "2026-11-12");
    assert.equal(confirmed.deadlineOrderKnown, true);
    assert.equal(confirmed.activeDeadline, null);
    const underscore = { ...dated, date: "17/11/2026, 5:42 p. m.",
      text: "Esperamos tu información antes del día 🕦 20/11/2026_ 72 horas 🕦" };
    fs.writeFileSync(resultsFile, JSON.stringify([{ req: "REQ123", status: "Pendiente",
      conversationStatus: "Pendiente de respuesta", activeDeadline: null,
      latestOperationsComment: underscore,
      comments: [underscore, { author: "Requester", date: "13/11/2026, 3:58 p. m.",
        isResponse: false, text: "Initial request" }],
    }]));
    const stated = (await (await fetch(`${base}/api/dashboard`)).json()).results[0];
    assert.equal(stated.statedDeadlineDate, "2026-11-20");
    assert.equal(stated.deadlineOrderKnown, true);
    assert.equal(stated.activeDeadline, null, "date-only deadline must not activate notifications");
    fs.writeFileSync(resultsFile, JSON.stringify([{ req: "REQ123", status: "Pendiente",
      conversationStatus: "Pendiente de respuesta", activeDeadline: null,
      latestOperationsComment: { ...dated, text: "Please review the request." },
      comments: [{ ...dated, text: "Please review the request." }],
    }]));
    const unchanged = (await (await fetch(`${base}/api/dashboard`)).json()).results[0];
    assert.equal("statedDeadlineDate" in unchanged, false);
    assert.equal("deadlineOrderKnown" in unchanged, false);
    assert.equal(unchanged.estimatedDeadlineDate, "2026-11-12", "three Colombian business days after the reply");
    const friday = { ...dated, date: "13/11/2026, 5:42 p. m.", text: "Please review the request." };
    fs.writeFileSync(resultsFile, JSON.stringify([{ req: "REQ123", status: "Pendiente",
      conversationStatus: "Pendiente de respuesta", activeDeadline: null, latestOperationsComment: friday,
      comments: [friday, { author: "Requester", date: "12/11/2026, 3:58 p. m.",
        isResponse: false, text: "Initial request" }],
    }]));
    assert.equal((await (await fetch(`${base}/api/dashboard`)).json()).results[0].estimatedDeadlineDate,
      "2026-11-19", "skip weekend and the Monday holiday");
    fs.writeFileSync(resultsFile, JSON.stringify([{ req: "REQ123", status: "Pendiente",
      conversationStatus: "Pendiente de respuesta", activeDeadline: null,
      latestOperationsComment: { ...friday, date: null }, comments: [{ ...friday, date: null }],
    }]));
    assert.equal("estimatedDeadlineDate" in (await (await fetch(`${base}/api/dashboard`)).json()).results[0], false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
