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
      conversationStatus: index === 0 ? "Respondida" : "Finalizada",
      latestOperationsComment: index === 0 ? { author: "Operations", date: null, text: "Review", attachments: [] } : null,
      projectName: index === 0 ? "Special Project" : `Project ${index + 1}`,
      title: `Synthetic ${index + 1}`, description: "Synthetic details", microservices: [] }));
    await page.route("http://grid.local/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard") {
        await route.fulfill({ json: { reqs, results, monitor: { running: false, finishedAt: null }, auth: {}, schedule: { allowed: true } } });
        return;
      }
      const files: Record<string, string> = {
        "/": "web/index.html", "/app.js": "dist/app.js", "/styles.css": "web/styles.css",
        "/ag-grid-community.min.js": "node_modules/ag-grid-community/dist/ag-grid-community.min.js",
      };
      const file = files[pathname];
      if (!file) return route.fulfill({ status: 404, body: "" });
      await route.fulfill({ body: fs.readFileSync(file), contentType: pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html" });
    });
    await page.goto("http://grid.local/");
    await page.locator("#req-grid .ag-center-cols-container .ag-row").first().waitFor();
    assert.equal(await page.locator("#req-grid .ag-center-cols-container .ag-row").count(), 10);
    await page.locator("#req-grid .ag-header-cell-text", { hasText: "Proyecto / Microservicio / REQ" }).click();
    await page.getByText("REQ001", { exact: true }).first().waitFor();
    assert.equal(await page.locator("#req-grid .portal-status.warning").count(), 1);
    assert.equal(await page.locator("#req-grid .operations-reply").count(), 1);
    assert.match(await page.locator("#req-grid .ag-row", { has: page.locator(".portal-status.warning") })
      .locator(".conversation-status").innerText(), /Respondida/);
    await page.locator("#req-grid [data-details=REQ001]").click();
    assert.equal(await page.locator("#req-grid [data-details=REQ001] span").count(), 0);
    await page.locator("#req-details-dialog[open]").waitFor();
    await page.getByText("Synthetic details", { exact: true }).waitFor();
    assert.equal(await page.locator("#req-grid [data-query=REQ001]").count(), 1);
    assert.equal(await page.locator("#req-grid [data-delete=REQ001]").count(), 1);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Next Page" }).click();
    await page.waitForFunction(() => document.querySelectorAll("#req-grid .ag-center-cols-container .ag-row").length === 3);
    assert.equal(await page.locator("#req-grid .ag-center-cols-container .ag-row").count(), 3);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      "grid columns must scroll inside the table, not widen the page");
    const mobileScroll = await page.evaluate(() => {
      const container = document.querySelector("#req-grid .ag-body-horizontal-scroll-viewport");
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
    await page.locator("#req-grid .ag-header-cell[col-id=status] .ag-header-cell-filter-button").click();
    await page.locator('.ag-popup input[aria-label="Filter Value"]').fill("Pending");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("1 de 13"));
    assert.equal(await page.locator("#req-grid .ag-center-cols-container .ag-row:visible").count(), 1);
    assert.equal(await page.locator("#req-grid .ag-center-cols-container .ag-row:visible").first().innerText().then((s) => s.includes("REQ001")), true);
  } finally {
    await browser.close();
  }
});

test("query arrows and monitor buttons show busy feedback until their work finishes", async () => {
  const browser = await chromium.launch({ headless: true });
  let finishQuery: (() => void) | undefined;
  let finishRun: (() => void) | undefined;
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3_000);
    let activeTask: string | null = null;
    await page.route("http://grid.local/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard") return route.fulfill({ json: {
        reqs: ["REQ001"], results: [{ req: "REQ001", status: "En curso" }],
        monitor: { running: activeTask === "monitor", activeTask }, auth: {}, schedule: { allowed: true },
      } });
      if (pathname === "/api/reqs/query") {
        await new Promise<void>((resolve) => { finishQuery = resolve; });
        return route.fulfill({ json: { results: [{ req: "REQ001", status: "En curso" }] } });
      }
      if (pathname === "/api/monitor/run") {
        await new Promise<void>((resolve) => { finishRun = resolve; });
        activeTask = "monitor";
        return route.fulfill({ json: { started: true } });
      }
      const file = ({ "/": "web/index.html", "/app.js": "dist/app.js", "/styles.css": "web/styles.css",
        "/ag-grid-community.min.js": "node_modules/ag-grid-community/dist/ag-grid-community.min.js" } as Record<string, string>)[pathname];
      return file ? route.fulfill({ body: fs.readFileSync(file), contentType: pathname.endsWith(".js") ? "text/javascript" :
        pathname.endsWith(".css") ? "text/css" : "text/html" }) : route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://grid.local/");
    const query = page.locator("#req-grid [data-query=REQ001]");
    await query.click();
    await page.waitForFunction(() => Boolean(document.querySelector("#req-grid [data-query=REQ001][aria-busy=true]")));
    assert.equal(await query.locator("svg").evaluate((icon) => getComputedStyle(icon).animationName), "spin");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await query.locator("svg").evaluate((icon) => getComputedStyle(icon).animationName), "none");
    finishQuery?.();
    await page.waitForFunction(() => !document.querySelector("#req-grid [data-query=REQ001][aria-busy=true]"));

    const run = page.locator("#run-all-button");
    await run.click();
    await page.waitForFunction(() => document.querySelector("#run-all-button")?.getAttribute("aria-busy") === "true");
    finishRun?.();
    await page.waitForFunction(() => document.querySelector("#monitor-label")?.textContent === "Ejecutando monitor");
    assert.equal(await run.getAttribute("aria-busy"), "true", "busy feedback persists throughout the monitor run");
    activeTask = null;
    await page.locator("#refresh-button").click();
    await page.waitForFunction(() => document.querySelector("#run-all-button")?.getAttribute("aria-busy") !== "true");
  } finally {
    finishQuery?.();
    finishRun?.();
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
    const appAsset = await fetch(`${origin}/app.js`);
    assert.equal(appAsset.status, 200);
    assert.equal(await appAsset.text(), fs.readFileSync("dist/app.js", "utf8"), "API must serve the Vite bundle");
    assert.match(appAsset.headers.get("content-security-policy") ?? "", /script-src 'self'/);

    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await page.route(`${origin}/api/dashboard`, (route) => route.fulfill({ json: {
      reqs: ["REQ001"], results: [{ req: "REQ001", projectName: "Synthetic project", status: "Pending", title: "Synthetic title" }],
      monitor: { running: false }, auth: {}, schedule: { allowed: false },
    } }));
    await page.goto(origin);
    const row = page.locator("#req-grid .ag-center-cols-container .ag-row").first();
    await row.waitFor();
    const positions = await row.locator(".ag-cell").evaluateAll((cells) => cells.map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { left: rect.left, top: rect.top, position: getComputedStyle(cell).position };
    }));
    assert.equal(positions.length, 5, "center columns exclude the pinned selection cell");
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

test("edited static-analysis message is saved locally and remains the copied template", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("http://grid.local/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard") return route.fulfill({ json: {
        reqs: [], results: [], monitor: { running: false }, auth: {}, schedule: { allowed: false },
      } });
      const file = ({ "/": "web/index.html", "/app.js": "dist/app.js", "/styles.css": "web/styles.css",
        "/ag-grid-community.min.js": "node_modules/ag-grid-community/dist/ag-grid-community.min.js" } as Record<string, string>)[pathname];
      return file ? route.fulfill({ body: fs.readFileSync(file), contentType: pathname.endsWith(".js") ? "text/javascript" :
        pathname.endsWith(".css") ? "text/css" : "text/html" }) : route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://grid.local/");
    await page.getByRole("button", { name: "Crear REQ" }).click();
    let dialog = page.getByRole("dialog", { name: "Crear REQ" });
    await dialog.getByRole("button", { name: "Análisis de código estático" }).click();
    const original = await dialog.locator(".creation-message").innerText();
    await dialog.getByRole("button", { name: "Editar plantilla" }).click();
    const editor = dialog.getByRole("textbox", { name: "Mensaje para la REQ" });
    assert.equal(await editor.inputValue(), original);
    await editor.fill("Cambio sin guardar");
    await dialog.getByRole("button", { name: "Cancelar edición" }).click();
    assert.equal(await dialog.locator(".creation-message").innerText(), original);
    await dialog.getByRole("button", { name: "Editar plantilla" }).click();
    const revised = "Mensaje personalizado\nSegunda línea <script>alert(1)</script>";
    await editor.fill(revised);
    await dialog.getByRole("button", { name: "Guardar plantilla" }).click();
    assert.equal(await dialog.locator(".creation-message").innerText(), revised);
    assert.equal(await dialog.locator(".creation-message script").count(), 0);
    await dialog.getByRole("status").getByText("Plantilla guardada").waitFor();
    await page.reload();
    await page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(value) { window.copiedMessage = value; return Promise.resolve(); } } })");
    await page.getByRole("button", { name: "Crear REQ" }).click();
    dialog = page.getByRole("dialog", { name: "Crear REQ" });
    await dialog.getByRole("button", { name: "Análisis de código estático" }).click();
    assert.equal(await dialog.locator(".creation-message").innerText(), revised);
    await dialog.getByRole("button", { name: "Copiar mensaje" }).click();
    assert.equal(await page.evaluate(() => (window as typeof window & { copiedMessage?: string }).copiedMessage), revised);
    await dialog.getByRole("button", { name: "Editar plantilla" }).click();
    await editor.fill("\n  ");
    await dialog.getByRole("button", { name: "Guardar plantilla" }).click();
    await dialog.getByRole("status").getByText("Ingresa un mensaje antes de guardar").waitFor();
    assert.equal(await dialog.locator(".creation-message").innerText(), revised);
    await editor.fill("No debe guardarse");
    await page.evaluate("Storage.prototype.setItem = function() { throw new Error('storage unavailable'); }");
    await dialog.getByRole("button", { name: "Guardar plantilla" }).click();
    await dialog.getByRole("status").getByText("No se pudo guardar la plantilla").waitFor();
    assert.equal(await dialog.locator(".creation-message").innerText(), revised);
    await dialog.getByRole("button", { name: "Cerrar" }).click();
    await page.getByRole("button", { name: "Crear REQ" }).click();
    await dialog.getByRole("button", { name: "Análisis de código estático" }).click();
    assert.equal(await dialog.locator(".creation-message").innerText(), revised);
  } finally {
    await browser.close();
  }
});

test("Create REQ shows static-analysis instructions before the portal link", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("http://grid.local/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard") return route.fulfill({ json: {
        reqs: [], results: [], monitor: { running: false }, auth: {}, schedule: { allowed: false },
      } });
      const file = ({ "/": "web/index.html", "/app.js": "dist/app.js", "/styles.css": "web/styles.css",
        "/ag-grid-community.min.js": "node_modules/ag-grid-community/dist/ag-grid-community.min.js" } as Record<string, string>)[pathname];
      return file ? route.fulfill({ body: fs.readFileSync(file), contentType: pathname.endsWith(".js") ? "text/javascript" :
        pathname.endsWith(".css") ? "text/css" : "text/html" }) : route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://grid.local/");
    await page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(value) { window.copiedMessage = value; return Promise.resolve(); } } })");
    assert.equal(await page.getByRole("link", { name: "Abrir formulario en MiAsistencia360" }).count(), 0);
    await page.getByRole("button", { name: "Crear REQ" }).click();
    const dialog = page.getByRole("dialog", { name: "Crear REQ" });
    await dialog.waitFor();
    assert.equal(await dialog.getByText("Validación SSD").count(), 0);
    assert.equal(await dialog.getByText("Parámetros de configuración").isVisible(), false);
    assert.equal(await dialog.getByRole("link", { name: "Abrir formulario en MiAsistencia360" }).count(), 0);
    await dialog.getByRole("button", { name: "Análisis de código estático" }).click();
    await dialog.getByText("Parámetros de configuración", { exact: true }).waitFor();
    assert.ok(await dialog.locator("#creation-message-title").evaluate((heading) =>
      !!(heading.compareDocumentPosition(document.querySelector("#creation-config-title")) & Node.DOCUMENT_POSITION_FOLLOWING)),
    "message and copy action should appear before the long configuration list");
    const expectedConfiguration = [
      ["Sede", "1 - Trabajo desde Casa"],
      ["Tipo de Operación", "Transversal"],
      ["Servicio", "Análisis de código estático Checkmarx"],
      ["Tipo de Solicitud", "Solicitud análisis de código estático"],
      ["Tipo de Cliente", "Cliente Interno"],
      ["Dirección IP del Equipo", "0"],
      ["Cantidad de Usuarios que Requieren la Solicitud", "1"],
    ];
    await dialog.getByText("Todos los parámetros son obligatorios.", { exact: true }).waitFor();
    assert.equal(await dialog.locator(".creation-config").getAttribute("aria-describedby"), "creation-config-required");
    assert.deepEqual(await dialog.locator(".creation-config dt").allInnerTexts(),
      expectedConfiguration.map(([label]) => label));
    assert.deepEqual(await dialog.locator(".creation-config dd").allInnerTexts(),
      expectedConfiguration.map(([, value]) => value));
    const message = await dialog.locator(".creation-message").innerText();
    const expectedMessage = "Cordial saludo,\n\nSe solicita amablemente su colaboración con la validación de vulnerabilidad de los códigos compartidos en el siguiente adjunto, cualquier inquietud por favor comunicarse con,\n\nJuan Sebastian Mendez T.\njuan.mendez@vasscompany.com\nusuario de red:   46075453";
    assert.equal(message, expectedMessage);
    const back = dialog.getByRole("button", { name: "Volver a tipos de solicitud" });
    assert.equal((await back.innerText()).trim(), "", "back button is an icon with an accessible name");
    assert.equal(await back.locator("svg").count(), 1);
    assert.ok(await back.evaluate((button) => button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44));
    assert.ok(await dialog.locator(".creation-config").evaluate((list) =>
      list.getBoundingClientRect().height < 560 && list.scrollWidth <= list.clientWidth),
    "configuration should be compact without horizontal overflow on mobile");
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.ok(await dialog.locator(".creation-config").evaluate((list) => list.getBoundingClientRect().height < 380),
      "configuration should remain compact on desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => typeof navigator.clipboard?.writeText), "function");
    await dialog.getByRole("button", { name: "Copiar mensaje" }).click();
    assert.equal(await dialog.locator("#create-req-copy-status").innerText(), "Mensaje copiado");
    assert.equal(await page.evaluate(() => (window as typeof window & { copiedMessage?: string }).copiedMessage), expectedMessage);
    await page.evaluate("navigator.clipboard.writeText = function() { return Promise.reject(new Error('denied')); }");
    await dialog.getByRole("button", { name: "Copiar mensaje" }).click();
    await dialog.getByRole("status").getByText("No se pudo copiar el mensaje").waitFor();
    await dialog.getByText("Adjuntar archivo en 7zip", { exact: true }).waitFor();
    const link = dialog.getByRole("link", { name: "Abrir formulario en MiAsistencia360" });
    assert.equal(await link.locator("xpath=..").getAttribute("class"), "creation-guide-heading");
    assert.equal((await link.innerText()).trim(), "", "portal link should be icon-only with an accessible name");
    assert.equal(await link.locator("svg[aria-hidden=true]").count(), 1);
    assert.ok(await link.evaluate((element) => element.getBoundingClientRect().width >= 44 && element.getBoundingClientRect().height >= 44));
    assert.equal(await dialog.locator("#creation-attachment-title").locator("xpath=..").getByRole("link").count(), 0);
    assert.equal(await link.getAttribute("href"), "https://miasistencia360-dwp.claro.com.co/dwp/app/#/srm/profile/SRGlbtarmdevapPEC4DMPDFU6NEGUJ/srm");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.match(await link.getAttribute("rel") ?? "", /noopener/);
    assert.match(await link.getAttribute("rel") ?? "", /noreferrer/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const headerPosition = await dialog.evaluate((element) => {
        element.scrollTop = 460;
        return { dialogTop: element.getBoundingClientRect().top,
          headerTop: element.querySelector(".details-dialog-header").getBoundingClientRect().top };
      });
      assert.ok(headerPosition.headerTop <= headerPosition.dialogTop + 2,
        `sticky modal header must cover scrolled content at ${width}px`);
    }
    await back.click();
    assert.equal(await dialog.locator("#create-req-copy-status").innerText(), "");
    assert.equal(await dialog.getByText("Parámetros de configuración").isVisible(), false);
    assert.equal(await dialog.getByRole("link", { name: "Abrir formulario en MiAsistencia360" }).count(), 0);
    assert.equal(await dialog.getByRole("button", { name: "Análisis de código estático" }).count(), 1);
    await dialog.getByRole("button", { name: "Análisis de código estático" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Crear REQ" }).click();
    assert.equal(await dialog.getByRole("link", { name: "Abrir formulario en MiAsistencia360" }).count(), 0);
    await dialog.getByRole("button", { name: "Análisis de código estático" }).waitFor();
  } finally {
    await browser.close();
  }
});
