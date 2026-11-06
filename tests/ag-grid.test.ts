import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium } from "playwright";

test("AG Grid sorts and pages REQs without losing row actions or literal status", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const reqs = Array.from({ length: 13 }, (_, index) => `REQ${String(index + 1).padStart(3, "0")}`);
    const results = reqs.map((req, index) => ({ req, status: index === 0 ? "Pending" : "Finalizada",
      projectName: index === 0 ? "Special Project" : `Project ${index + 1}`,
      title: `Synthetic ${index + 1}`, description: "Synthetic details", microservices: [] }));
    await page.route("http://grid.local/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard") {
        await route.fulfill({ json: { reqs, results, monitor: { running: false, finishedAt: null }, auth: {}, schedule: { allowed: true } } });
        return;
      }
      const files: Record<string, string> = {
        "/": "web/index.html", "/app.js": "web/app.js", "/styles.css": "web/styles.css",
        "/ag-grid-community.min.js": "node_modules/ag-grid-community/dist/ag-grid-community.min.js",
      };
      const file = files[pathname];
      if (!file) return route.fulfill({ status: 404, body: "" });
      await route.fulfill({ body: fs.readFileSync(file), contentType: pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html" });
    });
    await page.goto("http://grid.local/");
    await page.locator("#req-grid .ag-row").first().waitFor();
    assert.equal(await page.locator("#req-grid .ag-row").count(), 10);
    assert.equal(await page.locator("#req-grid .portal-status.warning").count(), 1);
    await page.locator("#req-grid .ag-header-cell-text", { hasText: "Proyecto / Microservicio / REQ" }).click();
    await page.getByText("REQ001", { exact: true }).first().waitFor();
    await page.locator("#req-grid [data-details=REQ001]").click();
    assert.equal(await page.locator("#req-grid [data-details=REQ001] span").count(), 0);
    await page.locator("#req-details-dialog[open]").waitFor();
    await page.getByText("Synthetic details", { exact: true }).waitFor();
    assert.equal(await page.locator("#req-grid [data-query=REQ001]").count(), 1);
    assert.equal(await page.locator("#req-grid [data-delete=REQ001]").count(), 1);
    await page.getByRole("button", { name: "Next Page" }).click();
    await page.waitForFunction(() => document.querySelectorAll("#req-grid .ag-row").length === 3);
    assert.equal(await page.locator("#req-grid .ag-row").count(), 3);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      "grid columns must scroll inside the table, not widen the page");
    const mobileScroll = await page.evaluate(() => {
      const container = document.querySelector(".table-wrap");
      container.scrollLeft = container.scrollWidth;
      return { available: container.scrollWidth > container.clientWidth, moved: container.scrollLeft > 0 };
    });
    assert.equal(mobileScroll.available && mobileScroll.moved, true, "columns must remain reachable by horizontal scrolling");
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const completed = { startedAt: "run-1", running: false, finishedAt: "2026-11-05T15:00:00Z", exitCode: 0 };
    await page.route("http://grid.local/api/dashboard", (route) => route.fulfill({ json: {
      reqs, results, monitor: completed, auth: {}, schedule: { allowed: true },
      progress: { startedAt: "run-1", items: Object.fromEntries(reqs.map((req) => [req, "success"])) },
    } }));
    await page.getByRole("button", { name: "Actualizar" }).click();
    await page.getByLabel("Filtrar por REQ, proyecto o microservicio").fill("Special Project");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("1 de 13"));
    assert.equal(await page.locator("#req-grid .ag-row:visible").count(), 1);
    assert.equal(await page.locator("#req-grid .ag-row:visible").first().innerText().then((s) => s.includes("REQ001")), true);
  } finally {
    await browser.close();
  }
});

test("the served AG Grid keeps columns aligned under the application's CSP", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "req-grid-csp-"));
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ["--import", "tsx", "monitor-api.ts"], {
    cwd: path.join(import.meta.dirname, ".."), stdio: "ignore",
    env: { ...process.env, MONITOR_API_HOST: "127.0.0.1", MONITOR_API_PORT: String(address.port),
      MONITOR_RUN_ON_START: "false", MONITOR_INTERVAL_MINUTES: "0", REQ_FILE: path.join(scratch, "reqs.txt"),
      MONITOR_SETTINGS_FILE: path.join(scratch, "settings.json"), ARTIFACTS_DIR: path.join(scratch, "artifacts"),
      AUTH_FILE: path.join(scratch, "auth.json") },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { response = await fetch(origin); break; } catch { await delay(50); }
    }
    assert.ok(response, "isolated API must start");
    const policy = response.headers.get("content-security-policy") || "";
    const html = await response.text();
    const nonce = html.match(/name="ag-grid-style-nonce" content="([^"]+)"/)?.[1];
    assert.ok(nonce && policy.includes(`style-src 'self' 'nonce-${nonce}'`));
    assert.doesNotMatch(policy, /unsafe-inline/);
    const second = await fetch(origin);
    const secondNonce = (await second.text()).match(/name="ag-grid-style-nonce" content="([^"]+)"/)?.[1];
    assert.ok(secondNonce && secondNonce !== nonce && second.headers.get("content-security-policy")?.includes(`'nonce-${secondNonce}'`));

    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await page.route(`${origin}/api/dashboard`, (route) => route.fulfill({ json: {
      reqs: ["REQ001"], results: [{ req: "REQ001", projectName: "Synthetic project", status: "Pending", title: "Synthetic title" }],
      monitor: { running: false }, auth: {}, schedule: { allowed: false },
    } }));
    await page.goto(origin);
    const row = page.locator("#req-grid .ag-row").first();
    await row.waitFor();
    const positions = await row.locator(".ag-cell").evaluateAll((cells) => cells.map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { left: rect.left, top: rect.top, position: getComputedStyle(cell).position };
    }));
    assert.equal(positions.length, 6);
    assert.ok(positions.every((cell) => cell.position === "absolute" && cell.top === positions[0].top));
    assert.ok(positions[1].left > positions[0].left, "columns must be beside each other, not stacked");
    assert.equal(await page.locator("#req-grid style:not([nonce])").count(), 0);
  } finally {
    await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
