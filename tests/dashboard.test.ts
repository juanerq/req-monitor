import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

test("monitored table labels the stated deadline without claiming verified closure", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.match(html, /Plazo indicado/);
  const list = { innerHTML: "" };
  const empty = { hidden: false };
  const document = { querySelector: (selector: string) => selector === "#req-list" ? list : selector === "#empty-state" ? empty : {} };
  const context = vm.createContext({ document, URL, console });
  const script = fs.readFileSync("web/app.js", "utf8").split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;`, context);
  const render = (result: object) => {
    (context as { renderRowsForTest: (reqs: string[], results: object[]) => void }).renderRowsForTest(["REQ123"], [{ req: "REQ123", ...result }]);
    return list.innerHTML;
  };
  assert.match(render({ conversationStatus: "Pendiente de respuesta", activeDeadline: { dueAt: "2026-10-10T04:59:00.000Z", sourceKey: "cycle" } }), /9\/10\/2026.*11:59/);
  assert.match(render({ conversationStatus: "Pendiente de respuesta", activeDeadline: null }), /Sin plazo indicado/);
  assert.match(render({ conversationStatus: "Respondida", activeDeadline: { dueAt: "2026-10-10T04:59:00.000Z" } }), /Plazo inactivo/);
  assert.doesNotMatch(render({ conversationStatus: "Finalizada" }), /11:59/);
  assert.doesNotMatch(list.innerHTML, /cierre verificado/i);
});

test("Acceso displays only an unverified username label and local session availability", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.match(html, /id="auth-status"/);
  assert.match(html, /id="credentials-session-status"/);
  const fields = new Map<string, { textContent: string; value: string; open?: boolean }>();
  const document = { querySelector: (selector: string) => {
    if (!fields.has(selector)) fields.set(selector, { textContent: "", value: "" });
    return fields.get(selector);
  } };
  const context = vm.createContext({ document, URL, console });
  const script = fs.readFileSync("web/app.js", "utf8").split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderAuthStatusForTest = renderAuthStatus;`, context);
  const render = (context as { renderAuthStatusForTest: (auth: object) => void }).renderAuthStatusForTest;
  render({ username: "<unverified>", localSessionAvailable: true, password: "synthetic-secret" });
  assert.match(fields.get("#auth-status")?.textContent ?? "", /sesión local.*sin verificar/i);
  assert.equal(fields.get("#credentials-username")?.value, "<unverified>");
  assert.doesNotMatch([...fields.values()].map((field) => field.textContent).join(" "), /synthetic-secret/);
  fields.get("#credentials-dialog")!.open = true;
  fields.get("#credentials-username")!.value = "manual.edit";
  render({ username: "entered.user", localSessionAvailable: true });
  assert.equal(fields.get("#credentials-username")?.value, "manual.edit", "background refresh must not overwrite form edits");
  fields.get("#credentials-dialog")!.open = false;
  render({ username: null, localSessionAvailable: false });
  assert.match(fields.get("#auth-status")?.textContent ?? "", /sin sesión local/i);
  assert.equal(fields.get("#credentials-username")?.value, "");
});

function dashboardHarness() {
  const html = fs.readFileSync("web/index.html", "utf8");
  const cell = { innerHTML: "" };
  const panel = { hidden: true, querySelector: (_selector: string) => cell };
  const button = { dataset: { details: "0" }, ariaExpanded: "false", setAttribute(name: string, value: string) { if (name === "aria-expanded") this.ariaExpanded = value; } };
  const list = { innerHTML: "", querySelector: (_selector: string) => panel };
  const empty = { hidden: false };
  const query = { innerHTML: "", hidden: true, scrollIntoView() {} };
  const document = { querySelector: (selector: string) => selector === "#req-list" ? list : selector === "#empty-state" ? empty : selector === "#query-result" ? query : {} };
  const context = vm.createContext({ document, URL, console });
  const script = fs.readFileSync("web/app.js", "utf8").split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows; this.toggleDetailsForTest = toggleDetails; this.renderQueryResultForTest = renderQueryResult;`, context);
  const render = (result: object) => {
    panel.hidden = true;
    cell.innerHTML = "";
    (context as { renderRowsForTest: (reqs: string[], results: object[]) => void })
      .renderRowsForTest(["REQ123"], [{ req: "REQ123", ...result }]);
  };
  const toggle = () => (context as { toggleDetailsForTest: (button: object) => void }).toggleDetailsForTest(button);
  const renderQuery = (result: object) => (context as { renderQueryResultForTest: (result: object) => void })
    .renderQueryResultForTest({ req: "REQ123", ...result });
  return { html, list, panel, cell, button, render, toggle, query, renderQuery };
}

test("portal status is literal, independent of conversation status and unavailable when absent", () => {
  const ui = dashboardHarness();
  assert.match(ui.html, /Estado del portal/);
  ui.render({ status: "Asignado por mesa", conversationStatus: "Pendiente de respuesta", microservices: ["servicio-a"], title: "Resumen" });
  assert.match(ui.list.innerHTML, /Asignado por mesa/);
  assert.doesNotMatch(ui.list.innerHTML, /<span class="badge[^>]*>Pendiente de respuesta/);
  assert.match(ui.list.innerHTML, /servicio-a/);
  ui.render({ conversationStatus: "Finalizada", status: null, microservices: [] });
  assert.match(ui.list.innerHTML, /Estado no disponible/);
  assert.doesNotMatch(ui.list.innerHTML, /Sin microservicio/);
});

test("details reveal stored fields on demand and close when toggled or refreshed", () => {
  const ui = dashboardHarness();
  const result = {
    status: "En curso", conversationStatus: "Pendiente de respuesta", description: "Descripción completa\nsegunda línea",
    instructions: "Paso primero", requester: "Persona Prueba", requesterUserId: "usuario-prueba",
    requesterEmail: "prueba@example.invalid", requesterPhone: "555-0100", sentAt: "fecha de envío",
    updatedAt: "fecha de actualización", requestDetails: { operationType: "Cambio", application: "App demo", requestType: "Tipo A", clientType: "Interno" },
    checkedAt: "2026-10-09T12:00:00.000Z", microservices: ["servicio-a"],
  };
  ui.render(result);
  assert.match(ui.list.innerHTML, /Ver detalles/);
  assert.match(ui.list.innerHTML, /aria-expanded="false"/);
  assert.doesNotMatch(ui.list.innerHTML, /Persona Prueba|prueba@example.invalid|Descripción completa/);
  ui.toggle();
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.button.ariaExpanded, "true");
  for (const value of ["Descripción completa", "segunda línea", "Paso primero", "Persona Prueba", "usuario-prueba", "prueba@example.invalid", "555-0100", "fecha de envío", "fecha de actualización", "Cambio", "App demo", "Tipo A", "Interno", "Pendiente de respuesta", "servicio-a"]) {
    assert.ok(ui.cell.innerHTML.includes(value), value);
  }
  ui.toggle();
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.cell.innerHTML, "");
  ui.toggle();
  ui.render(result);
  assert.equal(ui.panel.hidden, true);
  assert.doesNotMatch(ui.list.innerHTML, /prueba@example.invalid/);
});

test("missing values stay unavailable and stored text and links cannot inject markup", () => {
  const ui = dashboardHarness();
  ui.render({ status: "<img src=x onerror=alert(1)>", title: "<svg onload=alert(1)>", detailUrl: "javascript:alert(1)", description: "<script>alert(1)</script>", requesterEmail: '" onfocus="alert(1)' });
  assert.doesNotMatch(ui.list.innerHTML, /<img|<svg|href="javascript:/);
  assert.match(ui.list.innerHTML, /&lt;img/);
  ui.toggle();
  assert.match(ui.cell.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.cell.innerHTML, /<script|onfocus="alert/);
  assert.match(ui.cell.innerHTML, /No disponible/);
});

test("observed project appears beside microservice and REQ and in accessible stored details", () => {
  const ui = dashboardHarness();
  assert.match(ui.html, /Proyecto.*Microservicio.*REQ/);
  ui.render({ projectName: "Proyecto Sintético", microservices: ["servicio-demo"] });
  assert.match(ui.list.innerHTML, /Proyecto Sintético/);
  assert.match(ui.list.innerHTML, /servicio-demo/);
  assert.match(ui.list.innerHTML, /REQ123/);
  ui.toggle();
  assert.match(ui.cell.innerHTML, /<dt>Proyecto<\/dt><dd>Proyecto Sintético<\/dd>/);
  assert.equal(ui.button.ariaExpanded, "true");
});

test("missing or blank project is explicitly unavailable in row, details and manual query", () => {
  const ui = dashboardHarness();
  for (const projectName of [null, "  "]) {
    ui.render({ projectName });
    assert.match(ui.list.innerHTML, /Proyecto no disponible/);
    ui.toggle();
    assert.match(ui.cell.innerHTML, /<dt>Proyecto<\/dt><dd>No disponible<\/dd>/);
    ui.renderQuery({ projectName });
    assert.match(ui.query.innerHTML, /<dt>Proyecto<\/dt><dd>Proyecto no disponible<\/dd>/);
  }
});

test("project markup is escaped in row, stored details and manual query", () => {
  const ui = dashboardHarness();
  const projectName = '<script>alert("demo")</script>';
  ui.render({ projectName });
  assert.match(ui.list.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.list.innerHTML, /<script>/);
  ui.toggle();
  assert.match(ui.cell.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.cell.innerHTML, /<script>/);
  ui.renderQuery({ projectName });
  assert.match(ui.query.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.query.innerHTML, /<script>/);
});

test("manual query shows observed project beside existing microservices", () => {
  const ui = dashboardHarness();
  ui.renderQuery({ projectName: "Proyecto Prueba", microservices: ["servicio-demo"] });
  assert.match(ui.query.innerHTML, /<dt>Proyecto<\/dt><dd>Proyecto Prueba<\/dd>/);
  assert.match(ui.query.innerHTML, /<dt>Microservicios<\/dt><dd>servicio-demo<\/dd>/);
});
