import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium } from "playwright";

test("dashboard filters, date ordering and blocked visibility preserve monitored REQs", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const reqs = ["REQ101", "REQ102", "REQ103"];
    const results = [
      { req: "REQ101", projectName: "Alpha", microservices: ["payments"], status: "Pending", requestDetails: { requestType: "Static" }, sentAt: "4/11/2026, 4:30 p. m.", checkedAt: "2026-11-12T12:00:00Z", requester: "Ana", comments: [{ author: "Ana", date: "4/11/2026, 3:00 p. m.", isResponse: false }], activeDeadline: { dueAt: "2026-11-20T12:00:00Z" }, conversationStatus: "Pendiente de respuesta" },
      { req: "REQ102", projectName: "Beta", microservices: ["shipping"], status: "Completed", requestDetails: { requestType: "Validation" }, sentAt: "5/11/2026, 4:30 p. m.", checkedAt: "2026-11-11T12:00:00Z", latestOperationsComment: { author: "Ops", date: "5/11/2026, 2:00 p. m.", text: "Respuesta" }, activeDeadline: { dueAt: "2026-11-25T12:00:00Z" }, conversationStatus: "Finalizada" },
      { req: "REQ103", projectName: null, microservices: ["payments", "analytics"], status: "Pending", requestDetails: { requestType: "Static" }, sentAt: null, checkedAt: "2026-11-13T12:00:00Z" },
    ];
    await page.route("http://grid.local/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard") return route.fulfill({ json: {
        reqs, results, lockedReqs: ["REQ102"], monitor: { running: false }, auth: {}, schedule: { allowed: true },
      } });
      const file = ({ "/": "web/index.html", "/app.js": "dist/app.js", "/styles.css": "web/styles.css",
        "/ag-grid-community.min.js": "node_modules/ag-grid-community/dist/ag-grid-community.min.js" } as Record<string, string>)[pathname];
      return file ? route.fulfill({ body: fs.readFileSync(file), contentType: pathname.endsWith(".js") ? "text/javascript" :
        pathname.endsWith(".css") ? "text/css" : "text/html" }) : route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://grid.local/");
    const rows = page.locator("#req-grid .ag-center-cols-container .ag-row:visible");
    const firstRow = page.locator('#req-grid .ag-center-cols-container .ag-row[row-index="0"]');
    assert.equal(await page.locator("#filter-blocked").inputValue(), "hide");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("2 de 3"));
    assert.doesNotMatch(await rows.allInnerTexts().then((text) => text.join(" ")), /REQ102/);
    assert.equal(await page.locator("#sort-direction").count(), 0);
    assert.deepEqual(await page.locator("[data-date-order]").evaluateAll((buttons) =>
      buttons.map((button) => (button as HTMLElement).dataset.dateOrder)), ["project", "microservice", "date"]);
    for (const field of ["req", "type", "status", "blocked"]) {
      assert.equal(await page.locator(`[data-date-order="${field}"]`).count(), 0);
    }
    const controlStyles = await page.evaluate(() => {
      const fields = ["filter-project", "filter-microservice", "filter-req", "filter-type", "filter-status", "filter-blocked", "sort-date"];
      return fields.map((id) => {
        const element = document.getElementById(id)!;
        const wrapper = element.parentElement!;
        const arrow = wrapper.classList.contains("filter-sort-field")
          ? getComputedStyle(wrapper, "::after") : getComputedStyle(wrapper.querySelector(".search-filter-toggle")!, "::after");
        const button = wrapper.querySelector(".date-sort-button");
        const bounds = element.getBoundingClientRect();
        return { id, height: bounds.height, appearance: getComputedStyle(element).appearance,
          arrowWidth: arrow.width, arrowHeight: arrow.height,
          buttonInside: !button || button.getBoundingClientRect().right <= bounds.right };
      });
    });
    assert.equal(new Set(controlStyles.map(({ height }) => height)).size, 1, "all filter fields have the same height");
    assert.deepEqual(controlStyles.slice(5).map(({ appearance }) => appearance), ["none", "none"]);
    assert.deepEqual(controlStyles.map(({ arrowWidth, arrowHeight }) => [arrowWidth, arrowHeight]),
      Array.from({ length: 7 }, () => ["8px", "8px"]), "all filters use the same dropdown chevron");
    assert.ok(controlStyles.every(({ buttonInside }) => buttonInside), "sort controls stay within their fields");
    await page.locator("#filter-blocked").selectOption("all");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("3 de 3"));
    for (const [field, expected] of [
      ["project", ["Alpha", "Beta"]], ["microservice", ["analytics", "payments", "shipping"]],
      ["req", reqs], ["type", ["Static", "Validation"]], ["status", ["Completed", "Pending"]],
    ] as const) {
      const input = page.locator(`#filter-${field}`);
      assert.equal(await input.getAttribute("role"), "combobox");
      assert.equal(await input.getAttribute("aria-controls"), `filter-${field}-options`);
      await input.click();
      assert.equal(await input.getAttribute("aria-expanded"), "true");
      assert.deepEqual(await page.locator(`#filter-${field}-options [role=option]`).allInnerTexts(), [...expected]);
      const size = await page.locator(`#filter-${field}-options`).boundingBox();
      assert.ok(size && size.height <= 260, "suggestions must not cover the table");
      await input.press("Escape");
      assert.equal(await input.getAttribute("aria-expanded"), "false");
    }
    const project = page.locator("#filter-project");
    await project.click();
    await project.fill("sin-coincidencias");
    assert.equal(await page.locator("#filter-project-options .search-filter-empty").innerText(), "Sin coincidencias");
    await project.press("Escape");
    await project.fill("");
    await project.click();
    await project.press("ArrowDown");
    assert.ok(await project.getAttribute("aria-activedescendant"));
    await project.press("Enter");
    assert.equal(await project.inputValue(), "Alpha");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("2 de 3"));
    for (const [field, expected] of [
      ["microservice", ["analytics", "payments"]], ["req", ["REQ101", "REQ103"]], ["type", ["Static"]],
    ] as const) {
      await page.locator(`#filter-${field}`).click();
      assert.deepEqual(await page.locator(`#filter-${field}-options [role="option"]`).allInnerTexts(), [...expected]);
      await page.locator(`#filter-${field}`).press("Escape");
    }
    await page.getByRole("button", { name: "Limpiar filtros" }).click();
    assert.equal(await page.locator("#filter-blocked").inputValue(), "hide");
    await page.locator("#filter-microservice").click();
    assert.deepEqual(await page.locator('#filter-microservice-options [role="option"]').allInnerTexts(), ["analytics", "payments", "shipping"]);
    await page.locator("#filter-microservice").press("Escape");
    await page.locator("#filter-blocked").selectOption("all");
    await project.click();
    await page.locator('#filter-project-options [role="option"]', { hasText: "Beta" }).click();
    assert.equal(await project.inputValue(), "Beta");
    assert.equal(await project.getAttribute("aria-expanded"), "false");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("1 de 3"));
    for (const [field, expected] of [
      ["microservice", ["shipping"]], ["req", ["REQ102"]], ["type", ["Validation"]],
    ] as const) {
      await page.locator(`#filter-${field}`).click();
      assert.deepEqual(await page.locator(`#filter-${field}-options [role="option"]`).allInnerTexts(), [...expected]);
      await page.locator(`#filter-${field}`).press("Escape");
    }
    await page.getByRole("button", { name: "Limpiar filtros" }).click();
    await page.locator("#filter-blocked").selectOption("all");
    assert.match(await firstRow.innerText(), /REQ102.*Enviado:\s+5\/11\/2026/s);
    const check = async (selector: string, value: string, expected: string) => {
      await page.locator(selector).fill(value);
      await page.waitForFunction((count) => document.querySelector("#filter-count")?.textContent?.includes(count), expected);
      assert.match(await firstRow.innerText(), /REQ102/);
      await page.getByRole("button", { name: "Limpiar filtros" }).click();
      await page.locator("#filter-blocked").selectOption("all");
      await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("3 de 3"));
    };
    for (const [selector, value] of [["#filter-project", "Beta"], ["#filter-microservice", "shipping"],
      ["#filter-req", "REQ102"], ["#filter-type", "Validation"], ["#filter-status", "Completed"]]) {
      await check(selector, value, "1 de 3");
      assert.equal(await page.locator(selector).inputValue(), "");
    }
    await page.locator("#filter-blocked").selectOption("only");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("1 de 3"));
    assert.match(await firstRow.innerText(), /REQ102/);
    await page.locator("#filter-blocked").selectOption("hide");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("2 de 3"));
    assert.doesNotMatch(await rows.allInnerTexts().then((text) => text.join(" ")), /REQ102/);
    await page.getByRole("button", { name: "Limpiar filtros" }).click();
    assert.equal(await page.locator("#filter-blocked").inputValue(), "hide");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("2 de 3"));
    await page.locator("#filter-blocked").selectOption("all");
    await page.locator("#sort-date").selectOption("checkedAt");
    await page.waitForFunction(() => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes("REQ103"));
    assert.match(await firstRow.innerText(), /REQ103/);
    await page.locator("#sort-date").selectOption("sentAt");
    await page.waitForFunction(() => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes("REQ102"));
    assert.match(await firstRow.innerText(), /REQ102/);
    for (const [field, req] of [["requesterReply", "REQ101"], ["operationsReply", "REQ102"],
      ["deadline", "REQ101"]]) {
      await page.locator("#sort-date").selectOption(field);
      await page.waitForFunction((expected) => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes(expected), req);
    }
    await page.locator("#sort-date").selectOption("sentAt");
    await page.locator('[data-date-order="project"]').click();
    await page.waitForFunction(() => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes("REQ101"));
    assert.match(await firstRow.innerText(), /REQ101/);
    await page.locator('[data-date-order="microservice"]').click();
    assert.equal(await page.locator('[data-date-order="project"]').innerText(), "↑");
    assert.equal(await page.locator('[data-date-order="microservice"]').innerText(), "↑");
    assert.match(await firstRow.innerText(), /REQ101/, "microservice starts with its own direction");
    await page.locator('[data-date-order="project"]').click();
    await page.waitForFunction(() => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes("REQ102"));
    assert.equal(await page.locator('[data-date-order="microservice"]').innerText(), "↑", "other order stays independent");
    await page.locator("#sort-date").selectOption("checkedAt");
    await page.waitForFunction(() => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes("REQ103"));
    await page.locator('[data-date-order="date"]').click();
    await page.waitForFunction(() => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes("REQ102"));
    assert.equal(await page.locator('[data-date-order="project"]').innerText(), "↓", "each date keeps its own direction");
    await page.locator("#sort-date").selectOption("sentAt");
    await page.waitForFunction(() => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes("REQ102"));
    await page.locator('[data-date-order="project"]').click();
    await page.waitForFunction(() => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes("REQ101"));
    await page.setViewportSize({ width: 390, height: 844 });
    await project.click();
    const mobileMenu = await page.locator("#filter-project-options").boundingBox();
    assert.ok(mobileMenu && mobileMenu.width <= 390 && mobileMenu.x >= 0 && mobileMenu.x + mobileMenu.width <= 390);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await browser.close(); }
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

test("Operations conversation message fills its card without losing inner quotes", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    await page.route("http://grid.local/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard") return route.fulfill({ json: {
        reqs: ["REQ001"], results: [{ req: "REQ001", projectName: "Alpha", comments: [
          { author: "Operations", isResponse: true, date: null, text: '"Greeting\n1. Check "quoted" value\n2. Confirm"', attachments: [] },
        ] }], lockedReqs: [], monitor: { running: false }, auth: {}, schedule: { allowed: true },
      } });
      const file = ({ "/": "web/index.html", "/app.js": "dist/app.js", "/styles.css": "web/styles.css",
        "/ag-grid-community.min.js": "node_modules/ag-grid-community/dist/ag-grid-community.min.js" } as Record<string, string>)[pathname];
      return file ? route.fulfill({ body: fs.readFileSync(file), contentType: pathname.endsWith(".js") ? "text/javascript" :
        pathname.endsWith(".css") ? "text/css" : "text/html" }) : route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://grid.local/");
    await page.locator("#req-grid [data-details=REQ001]").click();
    const message = page.locator("#req-details-dialog .operations-message");
    await message.waitFor();
    assert.equal(await message.innerText(), 'Greeting\n\n1. Check "quoted" value\n\n2. Confirm');
    const layout = await message.evaluate((paragraph) => {
      const card = paragraph.closest(".conversation-entry")!;
      const style = getComputedStyle(card);
      const contentWidth = card.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      return { paragraphWidth: paragraph.getBoundingClientRect().width, contentWidth,
        whiteSpace: getComputedStyle(paragraph).whiteSpace };
    });
    assert.ok(Math.abs(layout.paragraphWidth - layout.contentWidth) < 2, "message fills the card width");
    assert.equal(layout.whiteSpace, "pre-wrap");
  } finally {
    await browser.close();
  }
});

test("unlocked Operations replies stay first across date sorts, filters, and pages", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const reqs = Array.from({ length: 12 }, (_, index) => `REQ${String(index + 1).padStart(3, "0")}`);
    const results = reqs.map((req, index) => ({ req, projectName: `Project ${index + 1}`,
      status: "Pending", requestDetails: { requestType: "Static" },
      sentAt: `${index + 1}/11/2026, 9:00 a. m.`,
      latestOperationsComment: [0, 1, 11].includes(index) ? { author: "Operations", text: "Answered", date: null } : null }));
    await page.route("http://grid.local/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard") return route.fulfill({ json: {
        reqs, results, lockedReqs: ["REQ012"], monitor: { running: false }, auth: {}, schedule: { allowed: true },
      } });
      const file = ({ "/": "web/index.html", "/app.js": "dist/app.js", "/styles.css": "web/styles.css",
        "/ag-grid-community.min.js": "node_modules/ag-grid-community/dist/ag-grid-community.min.js" } as Record<string, string>)[pathname];
      return file ? route.fulfill({ body: fs.readFileSync(file), contentType: pathname.endsWith(".js") ? "text/javascript" :
        pathname.endsWith(".css") ? "text/css" : "text/html" }) : route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://grid.local/");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("11 de 12"));
    const visibleReqs = () => page.locator("#req-grid .ag-center-cols-container .ag-row:visible").evaluateAll((rows) =>
      rows.map((row) => ({ index: Number(row.getAttribute("row-index")), req: row.querySelector(".req-copy")?.textContent?.trim() }))
        .sort((a, b) => a.index - b.index).map(({ req }) => req));
    assert.deepEqual((await visibleReqs()).slice(0, 2), ["REQ002", "REQ001"]);
    await page.getByRole("button", { name: "Next Page" }).click();
    assert.deepEqual(await visibleReqs(), ["REQ003"], "replies occupy the first page before pagination");
    await page.getByRole("button", { name: "Previous Page" }).click();
    await page.locator("#filter-blocked").selectOption("all");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("12 de 12"));
    assert.deepEqual((await visibleReqs()).slice(0, 2), ["REQ002", "REQ001"],
      "a locked reply must not be promoted");
    assert.equal((await visibleReqs())[2], "REQ012", "non-priority rows retain the selected date order");
    await page.locator('[data-date-order="date"]').click();
    await page.waitForFunction(() => document.querySelector('#req-grid .ag-center-cols-container .ag-row[row-index="0"]')?.textContent?.includes("REQ001"));
    assert.deepEqual((await visibleReqs()).slice(0, 2), ["REQ001", "REQ002"],
      "ascending date changes order within the priority group");
    await page.locator('#req-grid .ag-header-cell-text').filter({ hasText: "Proyecto / Microservicio / REQ" }).click();
    assert.deepEqual((await visibleReqs()).slice(0, 2), ["REQ001", "REQ002"],
      "column sorting must also keep unlocked replies first");
    await page.locator("#filter-req").fill("REQ011");
    await page.waitForFunction(() => document.querySelector("#filter-count")?.textContent?.includes("1 de 12"));
    assert.deepEqual(await visibleReqs(), ["REQ011"], "priority must not bypass filtering");
  } finally {
    await browser.close();
  }
});

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
    assert.match(await page.locator("#req-grid .ag-paging-row-summary-panel").innerText(), /1 a 10 de 13/);
    assert.equal(await page.locator('#req-grid .ag-header-cell[col-id="detail"]').count(), 0);
    await page.locator("#req-grid .ag-header-cell-text", { hasText: "Proyecto / Microservicio / REQ" }).click();
    await page.locator("#req-grid").getByText("REQ001", { exact: true }).first().waitFor();
    assert.equal(await page.locator('#req-grid .ag-row', { hasText: "REQ001" }).locator('.req-identity .req-title').innerText(), "Synthetic 1");
    assert.equal(await page.locator("#req-grid .portal-status.warning").count(), 1);
    assert.equal(await page.locator("#req-grid .requester-replied").count(), 1);
    assert.equal(await page.locator("#req-grid .requester-replied").innerText(), "Ya respondiste");
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
    await page.waitForFunction(() => document.querySelector("#monitor-time")?.textContent?.includes("Última revisión del monitor"),
      null, { timeout: 20_000 });
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
    await page.reload();
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
    assert.equal(positions.length, 4, "center columns exclude the pinned selection cell and removed Detail column");
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
