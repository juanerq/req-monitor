import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { test } from "node:test";

function frontendSource(): string {
  const helper = fs.readFileSync("operations-reviewer.ts", "utf8").replace(/^export /gm, "");
  const frontend = fs.readFileSync("web/app.ts", "utf8")
    .replace(/^import \{ operationsReviewerName \} from "\.\.\/operations-reviewer\.js";\s*/m, "");
  return stripTypeScriptTypes(`${helper}\n${frontend}`);
}

function mockGrid(list: { innerHTML: string }) {
  let options: { columnDefs: { field?: string; cellRenderer?: (params: { data: any }) => string }[]; rowSelection?: { isRowSelectable?: (node: { data: any }) => boolean }; onModelUpdated?: () => void; onSelectionChanged?: () => void };
  let rows: any[] = [];
  let selected = new Set<string>();
  let quick = "";
  let status = "all";
  const displayed = () => rows.filter((row) =>
    (!quick || `${row.req} ${row.project} ${row.microservices}`.toLowerCase().includes(quick.toLowerCase())) &&
    (status === "all" || row.status === status));
  const redraw = () => {
    list.innerHTML = displayed().map((row) => options.columnDefs.map((col) =>
      col.hide ? "" : col.cellRenderer ? col.cellRenderer({ data: row }) : String(row[col.field || ""] ?? "")).join(" ")).join("\n");
    options.onModelUpdated?.();
  };
  const api = {
    setGridOption(name: string, value: any) {
      if (name === "rowData") {
        rows = value;
        selected = new Set([...selected].filter((req) => rows.some((row) => row.req === req && options.rowSelection?.isRowSelectable?.({ data: row }) !== false)));
      }
      if (name === "quickFilterText") quick = value;
      redraw();
      if (name === "rowData") options.onSelectionChanged?.();
    },
    setColumnFilterModel: async (_column: string, model: { filter: string } | null) => { status = model?.filter ?? "all"; },
    setFilterModel: (model: { status?: { filter: string } } | null) => { status = model?.status?.filter ?? "all"; redraw(); },
    getFilterModel: () => status === "all" ? {} : { status: { filter: status } },
    forEachNodeAfterFilter: (callback: (node: { data: any }) => void) => displayed().forEach((data) => callback({ data })),
    onFilterChanged: redraw,
    getDisplayedRowCount: () => displayed().length,
    getSelectedRows: () => rows.filter((row) => selected.has(row.req)),
    refreshCells: () => redraw(),
    selectAll: (mode?: string) => { assert.equal(mode, undefined, "default mode includes filtered and paginated rows"); selected = new Set(rows.filter((row) => options.rowSelection?.isRowSelectable?.({ data: row }) !== false).map((row) => row.req)); options.onSelectionChanged?.(); },
    deselectAll: (mode?: string) => { assert.equal(mode, undefined); selected.clear(); options.onSelectionChanged?.(); },
    resetRowHeights() {},
  };
  return { agGrid: { themeQuartz: { withParams: () => ({}) }, createGrid: (_el: unknown, config: typeof options) => { options = config; return api; } }, api,
    select: (...reqs: string[]) => { selected = new Set(reqs.filter((req) => rows.some((row) => row.req === req && options.rowSelection?.isRowSelectable?.({ data: row }) !== false))); options.onSelectionChanged?.(); } };
}

test("add-monitor form submits pasted REQs together and preserves the single-REQ path", async () => {
  const source = frontendSource();
  const loading = source.slice(source.indexOf("function setLoading("), source.indexOf("function statusClass("));
  const helpers = source.slice(source.indexOf("function normalizeReq("), source.indexOf("function fileType("));
  const handler = source.slice(source.indexOf('elements.addForm.addEventListener("submit"'), source.indexOf('elements.queryForm.addEventListener("submit"'));
  const input = { value: "REQ101, req102\nREQ101; REQ103" };
  const calls: { method: string; body: string }[] = [];
  const urls: string[] = [];
  const messages: string[] = [];
  let onSubmit: (event: { preventDefault: () => void }) => Promise<void> = async () => {};
  let refreshes = 0;
  let releaseRequest: (() => void) | undefined;
  let holdRequest = false;
  const button = { disabled: false, busy: "false", setAttribute(_name: string, value: string) { this.busy = value; } };
  const elements = { addForm: { querySelector: () => button,
    addEventListener: (_name: string, listener: typeof onSubmit) => { onSubmit = listener; } } };
  const context = vm.createContext({ elements, document: { querySelector: () => input },
    api: async (url: string, options: { method: string; body: string }) => {
      urls.push(url); calls.push(options);
      if (holdRequest) await new Promise<void>((resolve) => { releaseRequest = resolve; });
    },
    loadDashboard: async () => { refreshes++; }, toast: (message: string) => messages.push(message) });
  vm.runInContext(`${loading}\n${helpers}\n${handler}`, context);
  await onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(calls[0].body), { reqs: ["REQ101", "REQ102", "REQ103"] });
  assert.equal(calls[0].method, "POST");
  assert.equal(urls[0], "/api/reqs");
  assert.equal(input.value, "");
  assert.equal(refreshes, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.busy, "false");
  assert.match(messages[0], /3 REQ/);

  input.value = "req104";
  holdRequest = true;
  const pending = onSubmit({ preventDefault() {} });
  assert.equal(button.disabled, true);
  assert.equal(button.busy, "true");
  await onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 2, "busy submit must not start a duplicate request");
  releaseRequest?.();
  await pending;
  assert.deepEqual(JSON.parse(calls[1].body), { reqs: ["REQ104"] });
  assert.equal(refreshes, 2);
  assert.equal(button.busy, "false");

  input.value = " , ; \n ";
  await onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 2, "empty input must not send a batch");
});

test("REQ table uses AG Grid Community for sorting, column filtering and pagination", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.match(html, /src="\/ag-grid-community\.min\.js"/);
  assert.match(html, /id="req-grid"/);
  assert.doesNotMatch(html, /<tbody id="req-list"/);
  const grid = { innerHTML: "" };
  let options: Record<string, unknown> | undefined;
  const agGrid = { themeQuartz: { withParams: () => ({}) }, createGrid: (_element: unknown, config: Record<string, unknown>) => {
    options = config;
    return { setGridOption() {}, setColumnFilterModel: async () => {}, onFilterChanged() {}, getDisplayedRowCount: () => 0 };
  } };
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? grid : ({}) };
  const context = vm.createContext({ document, URL, console, agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(script, context);
  assert.ok(options);
  assert.equal(options.pagination, true);
  assert.equal((options.defaultColDef as { sortable: boolean; filter: boolean }).sortable, true);
  assert.equal((options.defaultColDef as { sortable: boolean; filter: boolean }).filter, true);
  assert.deepEqual(Array.from((options.columnDefs as { headerName: string; hide?: boolean }[])
    .filter((column) => !column.hide).map((column) => column.headerName)),
  ["REQ / Microservicio", "Conversación", "Portal", "Plazo", "Última actividad", "Acciones"]);
});

test("dashboard refresh repaints changed microservice names when the REQ column value stays the same", () => {
  const list = { innerHTML: "" };
  const empty = { hidden: false, textContent: "" };
  const live = { hidden: true, textContent: "" };
  const selection = { textContent: "" };
  const run = { disabled: true };
  let options: { columnDefs: { field?: string; cellRenderer?: (params: { data: any }) => string }[] };
  let lastReq = "";
  let row: any;
  const refreshes: object[] = [];
  const gridApi = {
    setGridOption: (_key: string, value: any[]) => {
      row = value[0];
      if (row.req !== lastReq) {
        lastReq = row.req;
        list.innerHTML = options.columnDefs[0].cellRenderer!({ data: row });
      }
    },
    refreshCells: (params: object) => {
      refreshes.push(params);
      list.innerHTML = options.columnDefs[0].cellRenderer!({ data: row });
    },
    getSelectedRows: () => [], getDisplayedRowCount: () => 1,
    forEachNodeAfterFilter: (callback: (node: { data: any }) => void) => callback({ data: row }),
  };
  const document = { querySelector: (selector: string) => ({
    "#req-grid": list, "#empty-state": empty, "#live-progress": live,
    "#selection-count": selection, "#run-button": run,
  } as Record<string, object>)[selector] ?? {} };
  const context = vm.createContext({ document, URL, console,
    agGrid: { themeQuartz: { withParams: () => ({}) }, createGrid: (_el: unknown, config: typeof options) => { options = config; return gridApi; } } });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;
    state.dashboard = { reqs: ["REQ101"], monitor: { activeTask: null }, schedule: { allowed: true } };`, context);
  const render = (names: string[]) => (context as { renderRowsForTest: (reqs: string[], results: object[]) => void })
    .renderRowsForTest(["REQ101"], [{ req: "REQ101", microservices: names }]);
  render(["OldService"]);
  render(["AlphaApi,BetaApi", "GammaApi"]);
  assert.match(list.innerHTML, /AlphaApi, BetaApi, GammaApi/);
  assert.doesNotMatch(list.innerHTML, /OldService/);
  assert.deepEqual(JSON.parse(JSON.stringify(refreshes.at(-1))), {
    force: true, columns: ["req", "conversationStatus", "status", "deadline", "activity", "actions"],
  });
  const css = fs.readFileSync("web/styles.css", "utf8");
  assert.match(css, /\.req-service\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/);
});

test("dashboard remains usable when the AG Grid asset cannot load", () => {
  const fields = new Map<string, { textContent: string; hidden: boolean; disabled: boolean }>();
  const document = { querySelector: (selector: string) => {
    if (!fields.has(selector)) fields.set(selector, { textContent: "", hidden: true, disabled: false });
    return fields.get(selector);
  } };
  const context = vm.createContext({ document, URL, console });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;`, context);
  const ui = context as { renderRowsForTest: (reqs: string[], results: object[]) => void };
  ui.renderRowsForTest(["REQ123"], [{ req: "REQ123", status: "Pending" }]);
  assert.equal(fields.get("#empty-state")?.hidden, false);
  assert.match(fields.get("#empty-state")?.textContent ?? "", /tabla.*no disponible/i);
});

test("monitored table labels the stated deadline without claiming verified closure", () => {
  const source = frontendSource();
  assert.match(source, /headerName: "Plazo"/);
  const list = { innerHTML: "" };
  const empty = { hidden: false };
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list : selector === "#empty-state" ? empty : {} };
  const context = vm.createContext({ document, URL, console, agGrid: mockGrid(list).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;`, context);
  const render = (result: object) => {
    (context as { renderRowsForTest: (reqs: string[], results: object[]) => void }).renderRowsForTest(["REQ123"], [{ req: "REQ123", ...result }]);
    return list.innerHTML;
  };
  assert.match(render({ conversationStatus: "Pendiente de respuesta", activeDeadline: { dueAt: "2026-10-10T04:59:00.000Z", sourceKey: "cycle" } }), /class="req-review-date"[^>]*>2026-10-09 23:59<\/span>/);
  assert.match(render({ conversationStatus: "Pendiente de respuesta", activeDeadline: null }), /Sin plazo indicado/);
  assert.match(render({ conversationStatus: "Respondida", activeDeadline: null,
     statedDeadlineDate: "2026-11-12", deadlineOrderKnown: false }), /class="req-review-date"[^>]*>2026-11-12<\/span>/);
  assert.match(list.innerHTML, /Fecha indicada ya pasó · vigencia sin confirmar/);
  assert.doesNotMatch(list.innerHTML, /23:59/);
  assert.match(render({ conversationStatus: "Pendiente de respuesta", activeDeadline: null,
     statedDeadlineDate: "2026-11-12", deadlineOrderKnown: true }), /class="req-review-date"[^>]*>2026-11-12<\/span>/);
  assert.match(render({ conversationStatus: "Respondida", activeDeadline: null,
    statedDeadlineDate: "2026-11-12", deadlineOrderKnown: true }), /Plazo inactivo/);
  assert.match(render({ conversationStatus: "Respondida", activeDeadline: { dueAt: "2026-10-10T04:59:00.000Z" } }), /Plazo inactivo/);
  assert.doesNotMatch(render({ conversationStatus: "Finalizada" }), /11:59/);
  assert.doesNotMatch(list.innerHTML, /cierre verificado/i);
});

test("deadline details retain time and uncertainty context while the table shows only the date", () => {
  const context = vm.createContext({ document: { querySelector: () => ({}) }, URL, console, agGrid: mockGrid({ innerHTML: "" }).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.statedDeadlineForTest = statedDeadline;`, context);
  const deadline = (context as { statedDeadlineForTest: (result: object) => string }).statedDeadlineForTest;
  assert.match(deadline({ conversationStatus: "Pendiente de respuesta", activeDeadline: { dueAt: "2026-10-10T04:59:00.000Z" } }), /9\/10\/2026.*11:59/);
  assert.match(deadline({ conversationStatus: "Respondida", statedDeadlineDate: "2026-11-12", deadlineOrderKnown: false }), /12\/11\/2026 \(vigencia sin confirmar; sin hora\)/);
});

test("table shows the latest requester reply time only when its order is established", () => {
  const list = { innerHTML: "" };
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list : {} };
  const context = vm.createContext({ document, URL, console, agGrid: mockGrid(list).agGrid });
  vm.runInContext(`${frontendSource().split('elements.credentialsButton.addEventListener')[0]}\nthis.renderRowsForTest = renderRows;`, context);
  const render = (comments: object[], requester = "Ana Pérez") => {
    (context as { renderRowsForTest: (reqs: string[], results: object[]) => void })
      .renderRowsForTest(["REQ123"], [{ req: "REQ123", requester, comments }]);
    return list.innerHTML;
  };
  const ops = { author: "Operations", date: "10 nov 2026, 12:00", isResponse: true };
  const early = { author: "ANA PEREZ", date: "9 nov 2026, 18:02", isResponse: false };
  const latest = { author: "Ana Pérez", date: "11 nov 2026, 09:35", isResponse: false };
  assert.match(render([latest, ops, early]), />2026-11-11 09:35<\/span>\s*<span class="activity-author"[^>]*>Ana Pérez<\/span>/);
  assert.match(render([{ ...latest, date: "4/11/2026, 8:19 p.\u00a0m." },
     { ...early, date: "3/11/2026, 11:02 p. m." }]), />2026-11-04 20:19<\/span>/);
  assert.match(render([latest, { ...early, date: null }]), /Sin respuesta con fecha/);
  assert.match(render([ops]), /Sin respuesta con fecha/);
  assert.match(render([{ ...ops, isResponse: false }], ""), /Sin respuesta con fecha/);
});

test("activity shows the last Operations reply instead of per-REQ review time", () => {
  const list = { innerHTML: "" };
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list : {} };
  const context = vm.createContext({ document, URL, console, agGrid: mockGrid(list).agGrid });
  vm.runInContext(`${frontendSource().split('elements.credentialsButton.addEventListener')[0]}\nthis.renderRowsForTest = renderRows;`, context);
  const render = (result: object) => {
    (context as { renderRowsForTest: (reqs: string[], results: object[]) => void })
      .renderRowsForTest(["REQ123"], [{ req: "REQ123", checkedAt: "2026-11-13T21:00:00.000Z", ...result }]);
    return list.innerHTML;
  };
  const html = render({ latestOperationsComment: { author: "Operations", date: "9 nov 2026, 18:02" } });
  assert.match(html, />2026-11-09 18:02<\/span>\s*<span class="activity-author"[^>]*>Operations<\/span>/);
  assert.doesNotMatch(html, /Última revisión|2026-11-13 16:00/);
  assert.match(render({ latestOperationsComment: { date: "4\/11\/2026, 8:19 p. m." } }), /2026-11-04 20:19/);
  assert.match(render({ latestOperationsComment: { date: null } }), /Sin respuesta con fecha/);
  assert.match(render({}), /Sin respuesta con fecha/);
});

test("monitor header keeps its last review globally visible outside schedule", () => {
  const fields = new Map<string, { textContent: string; className: string; disabled: boolean }>();
  const document = { querySelector: (selector: string) => {
    if (selector === "#query-form") return { querySelector: () => ({ disabled: false }) };
    if (!fields.has(selector)) fields.set(selector, { textContent: "", className: "", disabled: false });
    return fields.get(selector);
  } };
  const context = vm.createContext({ document, URL, console });
  vm.runInContext(`${frontendSource().split('elements.credentialsButton.addEventListener')[0]}\nthis.updateMonitorForTest = updateMonitor;`, context);
  (context as { updateMonitorForTest: (monitor: object, schedule: object, progress: object, reqs: string[]) => void })
    .updateMonitorForTest({ activeTask: null, running: false, finishedAt: "2026-11-13T21:00:00.000Z" },
      { allowed: false, reason: "fuera del horario laboral" }, {}, ["REQ123"]);
  assert.match(fields.get("#monitor-time")?.textContent ?? "", /Última revisión del monitor: 2026-11-13 16:00/);
});

test("table leads with the Operations reply and marks only confirmed timed deadlines near", () => {
  const list = { innerHTML: "" };
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list : {} };
  const context = vm.createContext({ document, URL, console, agGrid: mockGrid(list).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;`, context);
  const render = (result: object) => {
    (context as { renderRowsForTest: (reqs: string[], results: object[]) => void })
      .renderRowsForTest(["REQ123"], [{ req: "REQ123", ...result }]);
    return list.innerHTML;
  };
  const near = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const later = new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString();
  const timed = { status: "Pendiente", conversationStatus: "Pendiente de respuesta",
    latestOperationsComment: { author: "Operations", date: "9 nov 2026, 18:02", text: "Please reply" },
    activeDeadline: { dueAt: near, sourceKey: "cycle" } };
  const html = render(timed);
  assert.match(html, /Te toca responder[\s\S]*portal-status warning/);
  assert.ok(html.indexOf("portal-status warning") < html.indexOf('class="req-review-date"'));
  assert.ok(html.indexOf('class="req-title"') < html.indexOf('class="status-stack"'));
  assert.match(html, /Vence en menos de 24 horas/);
  assert.match(html, /class="deadline-note near"/);
  assert.doesNotMatch(render({ ...timed, activeDeadline: { dueAt: later, sourceKey: "cycle" } }), /Vence en menos de 24 horas/);
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.match(render({ ...timed, activeDeadline: { dueAt: past, sourceKey: "cycle" } }), /class="deadline-note overdue"[^>]*>Plazo vencido<\/span>/);
  assert.doesNotMatch(render({ ...timed, conversationStatus: "Respondida", activeDeadline: { dueAt: past, sourceKey: "cycle" } }), /Plazo vencido/);
  assert.doesNotMatch(render({ ...timed, activeDeadline: null, statedDeadlineDate: "2026-11-12", deadlineOrderKnown: false }), /Plazo vencido/);
  assert.doesNotMatch(render({ ...timed, activeDeadline: null, statedDeadlineDate: "2099-01-01", deadlineOrderKnown: false }), /Fecha indicada ya pasó/);
  assert.doesNotMatch(render({ ...timed, conversationStatus: "Respondida" }), /Vence en menos de 24 horas/);
  assert.doesNotMatch(render({ ...timed, activeDeadline: null, statedDeadlineDate: "2026-11-12",
    comments: [{ date: null }, { date: null }] }), /Vence en menos de 24 horas/);
  assert.match(list.innerHTML, /Orden de mensajes sin confirmar/);
  assert.doesNotMatch(render({ status: "Pendiente", conversationStatus: "Sin comentario de operaciones" }), /Operaciones respondió/);
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
  const context = vm.createContext({ document, URL, console, agGrid: mockGrid({ innerHTML: "" }).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
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

test("manual REQ query opens Acceso for authentication errors without showing CLI commands", async () => {
  const button = { disabled: false, textContent: "Consultar REQ" };
  const dialog = { open: false, shows: 0, showModal() { this.open = true; this.shows++; } };
  const username = { focuses: 0, focus() { this.focuses++; } };
  const messages: string[] = [];
  let answer: { results?: object[]; error?: string; ok: boolean } = { ok: true };
  const document = { querySelector: (selector: string) => ({
    "#query-form": { querySelector: () => button },
    "#credentials-dialog": dialog,
    "#credentials-username": username,
  } as Record<string, unknown>)[selector] ?? {} };
  const fetch = async () => ({ ok: answer.ok, status: answer.ok ? 200 : 500,
    json: async () => answer.error ? { error: answer.error } : { results: answer.results } });
  const context = vm.createContext({ document, URL, console, fetch, agGrid: mockGrid({ innerHTML: "" }).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.queryReqForTest = queryReq; toast = (message) => messages.push(message); loadDashboard = async () => {};`,
    Object.assign(context, { messages }));
  const query = () => (context as { queryReqForTest: (req: string) => Promise<void> }).queryReqForTest("REQ123");

  answer = { ok: true, results: [{ req: "REQ123", error: "No existe sesión. Ejecuta: pnpm run auth" }] };
  await query();
  assert.equal(dialog.open, true);
  assert.doesNotMatch(messages.join(" "), /pnpm run auth|Consulta completada/);
  await query();
  assert.equal(dialog.shows, 1, "an open dialog must not be opened again");
  assert.equal(username.focuses, 1);

  dialog.open = false;
  answer = { ok: false, error: "Sesión MiAsistencia360 expirada; usa Acceso" };
  await query();
  assert.equal(dialog.open, true);
  assert.doesNotMatch(messages.join(" "), /usa Acceso|pnpm run auth/);

  dialog.open = false;
  answer = { ok: false, error: "Error: No existe /app/playwright/.auth/miasistencia.json. Ejecuta: pnpm run auth\n    at main (check-req.ts:513)" };
  await query();
  assert.equal(dialog.open, true, "CLI stderr propagated by the API must also open the dialog");
  assert.doesNotMatch(messages.join(" "), /pnpm run auth/);

  dialog.open = false;
  answer = { ok: false, error: "Error de red al conectar al portal" };
  await query();
  assert.equal(dialog.open, false, "network failures must not be treated as expired sessions");
  assert.match(messages.at(-1) ?? "", /Error de red/);

  vm.runInContext("renderQueryResult = (result) => { this.lastQueryResult = result; }", context);
  answer = { ok: true, results: [{ req: "REQ123", error: "REQ no disponible" }] };
  await query();
  assert.equal(dialog.open, false);
  assert.equal(messages.at(-1), "No se pudo consultar la REQ");

  answer = { ok: true, results: [{ req: "REQ123", status: "Abierta" }] };
  await query();
  assert.equal((context as { lastQueryResult?: { status: string } }).lastQueryResult?.status, "Abierta");
  assert.equal(messages.at(-1), "Consulta completada");
});

test("completed monitor authentication failure opens Acceso once per run", () => {
  const dialog = { open: false, shows: 0, showModal() { this.open = true; this.shows++; } };
  const document = { querySelector: (selector: string) => selector === "#credentials-dialog" ? dialog :
    selector === "#credentials-username" ? { focus() {} } : { setAttribute() {} } };
  const messages: string[] = [];
  const context = vm.createContext({ document, URL, console, messages, agGrid: mockGrid({ innerHTML: "" }).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderDashboardForTest = renderDashboard;
    renderAuthStatus = () => {}; updateMonitor = () => {}; renderRows = () => {}; updateProgressPolling = () => {};
    toast = (message) => messages.push(message);`, context);
  const render = (monitor: object) => (context as { renderDashboardForTest: (data: object) => void })
    .renderDashboardForTest({ reqs: [], results: [], monitor, auth: {} });
  render({ startedAt: "2026-11-05T15:00:00Z", running: true, authRequired: false });
  assert.equal(dialog.shows, 0);
  const failed = { startedAt: "2026-11-05T15:00:00Z", running: false, authRequired: true };
  render(failed);
  assert.equal(dialog.shows, 1);
  dialog.open = false;
  render(failed);
  assert.equal(dialog.shows, 1, "polling must not reopen a dismissed credential dialog");
  render({ startedAt: "2026-11-05T16:00:00Z", running: false, authRequired: false });
  assert.equal(dialog.shows, 1);
  render({ startedAt: "2026-11-05T17:00:00Z", running: false, authRequired: true });
  assert.equal(dialog.shows, 2, "a later run must be actionable again");
  assert.doesNotMatch(messages.join(" "), /pnpm run auth/);
});

test("per-REQ monitor progress distinguishes running, successful, failed and unvisited rows", () => {
  const list = { innerHTML: "" };
  const empty = { hidden: false };
  const live = { hidden: true, textContent: "" };
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list :
    selector === "#empty-state" ? empty : selector === "#live-progress" ? live : {} };
  const context = vm.createContext({ document, URL, console, agGrid: mockGrid(list).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows; this.activeRowForTest = gridOptions.rowClassRules["req-active"];`, context);
  const render = (items: object, running: boolean, selectedReqs: string[] | null = null) => (context as {
    renderRowsForTest: (reqs: string[], results: object[], progress: object, monitor: object) => void;
  }).renderRowsForTest(["REQ101", "REQ102", "REQ103"],
    [{ req: "REQ101", title: "Resultado anterior", checkedAt: "2026-11-04T10:00:00Z" }],
    { startedAt: "2026-11-05T15:00:00Z", items }, { running, startedAt: "2026-11-05T15:00:00Z", selectedReqs });
  render({ REQ101: "success", REQ102: "running" }, true);
  assert.equal(live.hidden, false);
  assert.match(live.textContent, /Monitoreando ahora: REQ102 · 1 de 3 revisadas/);
  const activeRow = (context as { activeRowForTest: (params: object) => boolean }).activeRowForTest;
  assert.equal(activeRow({ data: { active: true } }), true);
  assert.equal(activeRow({ data: { active: false } }), false);
  assert.match(list.innerHTML, /Resultado anterior/);
  assert.match(list.innerHTML, /aria-label="Monitoreo: Revisada"/);
  assert.match(list.innerHTML, /REQ102[\s\S]*En revisión/);
  assert.doesNotMatch(list.innerHTML, /Analizada|En espera|No revisada/);
  assert.doesNotMatch(list.innerHTML, />Analizando</);
  render({ REQ102: "running" }, true, ["REQ102"]);
  assert.match(live.textContent, /Monitoreando ahora: REQ102 · 0 de 1 revisadas/);
  assert.doesNotMatch(list.innerHTML, /REQ101[\s\S]*Monitoreo: Revisada/);
  render({ REQ101: "success" }, true);
  assert.match(live.textContent, /Preparando siguiente REQ · 1 de 3 revisadas/);
  render({ REQ101: "success", REQ102: "error" }, false);
  assert.equal(live.hidden, true);
  assert.equal(live.textContent, "");
  assert.match(list.innerHTML, /REQ101[\s\S]*Revisada/);
  assert.match(list.innerHTML, /REQ102[\s\S]*Error de revisión/);
  assert.doesNotMatch(list.innerHTML, /No revisada/);
});

test("manual selection starts empty, survives refresh and never selects unconfigured REQs", () => {
  const list = { innerHTML: "" };
  const empty = { hidden: false };
  const run = { disabled: true };
  const count = { textContent: "" };
  const grid = mockGrid(list);
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list :
    selector === "#empty-state" ? empty : selector === "#run-button" ? run :
      selector === "#selection-count" ? count : {} };
  const context = vm.createContext({ document, URL, console, agGrid: grid.agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;
    this.setDashboardForTest = (reqs) => { state.dashboard = { reqs, monitor: { activeTask: null }, schedule: { allowed: true } }; };
    this.selectedReqsForTest = selectedReqs; this.selectionConfigForTest = gridOptions.rowSelection;`, context);
  const ui = context as { renderRowsForTest: (reqs: string[], results: object[]) => void;
    setDashboardForTest: (reqs: string[]) => void; selectedReqsForTest: () => string[];
    selectionConfigForTest: { headerCheckbox: boolean; mode: string; selectAll: string } };
  ui.setDashboardForTest(["REQ101", "REQ102"]);
  ui.renderRowsForTest(["REQ101", "REQ102"], []);
  assert.equal(run.disabled, true);
  assert.equal(ui.selectionConfigForTest.headerCheckbox, true);
  assert.equal(ui.selectionConfigForTest.selectAll, "all");
  assert.equal(ui.selectionConfigForTest.mode, "multiRow");
  grid.select("REQ102");
  assert.deepEqual([...ui.selectedReqsForTest()], ["REQ102"]);
  assert.equal(run.disabled, false);
  assert.equal(count.textContent, "1 REQ seleccionadas");
  ui.renderRowsForTest(["REQ101", "REQ102"], []);
  assert.deepEqual([...ui.selectedReqsForTest()], ["REQ102"]);
  ui.setDashboardForTest(["REQ101"]);
  ui.renderRowsForTest(["REQ101"], []);
  assert.equal(run.disabled, true);
});

test("header checkbox selects all eligible REQs across filters and pagination", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.doesNotMatch(html, /id="select-all-button"/);
  const list = { innerHTML: "" };
  const empty = { hidden: false };
  const run = { disabled: true };
  const count = { textContent: "" };
  const grid = mockGrid(list);
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list :
    selector === "#empty-state" ? empty : selector === "#run-button" ? run :
      selector === "#selection-count" ? count : {} };
  const context = vm.createContext({ document, URL, console, agGrid: grid.agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;
    this.setDashboardForTest = (reqs) => { state.dashboard = { reqs, monitor: { activeTask: null }, schedule: { allowed: true } }; };
    this.selectedForTest = selectedReqs; this.gridOptionsForTest = gridOptions;`, context);
  const ui = context as { renderRowsForTest: (reqs: string[], results: object[]) => void;
    setDashboardForTest: (reqs: string[]) => void; selectedForTest: () => string[];
    gridOptionsForTest: { selectionColumnDef: { pinned: string }; rowSelection: { headerCheckbox: boolean; selectAll: string } } };
  ui.setDashboardForTest([]);
  ui.renderRowsForTest([], []);
  assert.equal(ui.gridOptionsForTest.selectionColumnDef.pinned, "left");
  assert.equal(ui.gridOptionsForTest.rowSelection.headerCheckbox, true);
  assert.equal(ui.gridOptionsForTest.rowSelection.selectAll, "all");
  ui.setDashboardForTest(["REQ101", "REQ102", "REQ103"]);
  ui.renderRowsForTest(["REQ101", "REQ102", "REQ103"], []);
  grid.api.setGridOption("quickFilterText", "REQ101");
  grid.api.selectAll();
  assert.deepEqual([...ui.selectedForTest()], ["REQ101", "REQ102", "REQ103"]);
  assert.equal(run.disabled, false);
  ui.renderRowsForTest(["REQ101", "REQ102", "REQ103"], []);
  assert.deepEqual([...ui.selectedForTest()], ["REQ101", "REQ102", "REQ103"]);
  grid.api.deselectAll();
  assert.deepEqual([...ui.selectedForTest()], []);
  assert.equal(run.disabled, true);
  grid.select("REQ102");
  grid.api.selectAll();
  assert.deepEqual([...ui.selectedForTest()], ["REQ101", "REQ102", "REQ103"]);
});

test("creation submission is the default sort and review remains selectable", () => {
  const list = { innerHTML: "" };
  const grid = mockGrid(list);
  const empty = { hidden: false, textContent: "" };
  const progress = { hidden: false, textContent: "" };
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list :
    selector === "#empty-state" ? empty : selector === "#live-progress" ? progress :
      selector === "#selection-count" ? { textContent: "" } :
      selector === "#run-button" || selector === "#run-all-button" ? { disabled: false } : {} };
  const context = vm.createContext({ document, URL, console, agGrid: grid.agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;
    this.setDashboardForTest = (reqs) => { state.dashboard = { reqs, monitor: { activeTask: null }, schedule: { allowed: true } }; };
     this.dateColumnForTest = gridOptions.columnDefs.find((column) => column.colId === "sentAt");
     this.reviewColumnForTest = gridOptions.columnDefs.find((column) => column.colId === "checkedAt");`, context);
  const ui = context as { renderRowsForTest: (reqs: string[], results: object[]) => void;
    setDashboardForTest: (reqs: string[]) => void;
     dateColumnForTest: { sort: string; valueGetter: (params: { data: { dateSort: { sentAt: number } } }) => number };
     reviewColumnForTest: { hide: boolean; valueGetter: (params: { data: { dateSort: { checkedAt: number } } }) => number } };
  assert.equal(ui.dateColumnForTest.sort, "desc");
  assert.equal(ui.reviewColumnForTest.hide, true);
  assert.ok(ui.dateColumnForTest.valueGetter({ data: { dateSort: { sentAt: 2 } } }) >
    ui.dateColumnForTest.valueGetter({ data: { dateSort: { sentAt: 1 } } }));
  ui.setDashboardForTest(["REQ101", "REQ102", "REQ103"]);
  ui.renderRowsForTest(["REQ101", "REQ102", "REQ103"], []);
  assert.ok(list.innerHTML.indexOf("REQ103") < list.innerHTML.indexOf("REQ101"));
});

test("run-all selects every configured REQ and sends one manual batch without starting when blocked", async () => {
  const list = { innerHTML: "" };
  const empty = { hidden: false };
  const run = { disabled: true };
  const runAll = { disabled: true };
  const count = { textContent: "" };
  const grid = mockGrid(list);
  const requests: { url: string; body: string }[] = [];
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list :
    selector === "#empty-state" ? empty : selector === "#run-button" ? run :
      selector === "#run-all-button" ? runAll : selector === "#selection-count" ? count : {} };
  const context = vm.createContext({ document, URL, console, agGrid: grid.agGrid, requests });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;
    this.setDashboardForTest = (reqs, allowed = true, activeTask = null, lockedReqs = []) => {
      state.dashboard = { reqs, lockedReqs, monitor: { activeTask }, schedule: { allowed } }; updateRunSelection();
    };
    this.runAllForTest = runAllReqs; this.runSelectedForTest = runManualMonitor; this.selectedForTest = selectedReqs;
    api = async (url, options) => { requests.push({ url, body: options.body }); };
    loadDashboard = async () => {}; toast = () => {};`, context);
  const ui = context as { renderRowsForTest: (reqs: string[], results: object[]) => void;
    setDashboardForTest: (reqs: string[], allowed?: boolean, activeTask?: string | null, lockedReqs?: string[]) => void;
    runAllForTest: () => Promise<void>; runSelectedForTest: (reqs: string[]) => Promise<void>; selectedForTest: () => string[] };
  ui.setDashboardForTest([]);
  await ui.runAllForTest();
  assert.equal(runAll.disabled, true);
  assert.equal(requests.length, 0);
  ui.setDashboardForTest(["REQ101", "REQ102", "REQ103"]);
  ui.renderRowsForTest(["REQ101", "REQ102", "REQ103"], []);
  grid.api.setGridOption("quickFilterText", "REQ101");
  grid.select("REQ102");
  await ui.runAllForTest();
  assert.deepEqual([...ui.selectedForTest()], ["REQ101", "REQ102", "REQ103"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/monitor/run");
  assert.deepEqual(JSON.parse(requests[0].body), { reqs: ["REQ101", "REQ102", "REQ103"] });
  grid.select("REQ102");
  await ui.runSelectedForTest(ui.selectedForTest());
  assert.deepEqual(JSON.parse(requests[1].body), { reqs: ["REQ102"] });
  ui.setDashboardForTest(["REQ101", "REQ102", "REQ103"], true, null, ["REQ101"]);
  ui.renderRowsForTest(["REQ101", "REQ102", "REQ103"], [{ req: "REQ101", status: "Finalizado" }]);
  grid.select("REQ101");
  assert.deepEqual([...ui.selectedForTest()], []);
  assert.match(list.innerHTML, /Desbloquear REQ101/);
  await ui.runAllForTest();
  assert.deepEqual(JSON.parse(requests[2].body), { reqs: ["REQ102", "REQ103"] });
  ui.setDashboardForTest(["REQ101", "REQ102", "REQ103"]);
  ui.renderRowsForTest(["REQ101", "REQ102", "REQ103"], [{ req: "REQ101", status: "Finalizado" }]);
  assert.match(list.innerHTML, /Bloquear REQ101/);
  ui.setDashboardForTest(["REQ101", "REQ102", "REQ103"], false);
  await ui.runAllForTest();
  ui.setDashboardForTest(["REQ101", "REQ102", "REQ103"], true, "monitor");
  await ui.runAllForTest();
  assert.equal(requests.length, 3, "blocked and busy states must not start another run");
});

test("dashboard alerts once for partial or total scan failures and not for clean runs", () => {
  const messages: string[] = [];
  const document = { querySelector: () => ({ setAttribute() {} }) };
  const context = vm.createContext({ document, URL, console, messages, agGrid: mockGrid({ innerHTML: "" }).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderDashboardForTest = renderDashboard;
    renderAuthStatus = () => {}; updateMonitor = () => {}; renderRows = () => {}; updateProgressPolling = () => {};
    toast = (message) => messages.push(message);`, context);
  const render = (startedAt: string, items: object, running: boolean, exitCode: number, selectedReqs: string[] | null = null) =>
    (context as { renderDashboardForTest: (data: object) => void }).renderDashboardForTest({
      reqs: ["REQ101", "REQ102"], results: [], auth: {},
      monitor: { startedAt, running, exitCode, authRequired: false, selectedReqs },
      progress: { startedAt, items },
    });
  render("run-1", { REQ101: "running" }, true, 0);
  assert.equal(messages.length, 0);
  render("run-1", { REQ101: "success", REQ102: "error" }, false, 1);
  assert.match(messages.at(-1) ?? "", /1 de 2/);
  render("run-1", { REQ101: "success", REQ102: "error" }, false, 1);
  assert.equal(messages.length, 1);
  render("run-2", { REQ101: "error" }, false, 1);
  assert.match(messages.at(-1) ?? "", /ninguna REQ/i);
  render("run-3", { REQ101: "success", REQ102: "success" }, false, 0);
  assert.equal(messages.length, 2);
  render("run-4", { REQ101: "success" }, false, 0, ["REQ101"]);
  assert.equal(messages.length, 2, "unselected REQs do not count as missing from a partial run");
  render("run-5", { REQ101: "error" }, false, 1, ["REQ101"]);
  assert.match(messages.at(-1) ?? "", /ninguna REQ/i);
});

test("late dashboard response cannot replace newer monitor progress", async () => {
  const rendered: string[] = [];
  const pending: ((value: unknown) => void)[] = [];
  const document = { querySelector: () => ({}) };
  const fetch = () => new Promise((resolve) => pending.push(resolve));
  const context = vm.createContext({ document, URL, console, fetch, rendered, agGrid: mockGrid({ innerHTML: "" }).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}
    renderDashboard = (data) => rendered.push(data.monitor.startedAt);
    this.loadDashboardForTest = loadDashboard;`, context);
  const load = (context as { loadDashboardForTest: () => Promise<void> }).loadDashboardForTest;
  const oldRequest = load();
  const newRequest = load();
  const response = (startedAt: string) => ({
    ok: true, json: async () => ({ reqs: [], results: [], monitor: { startedAt }, auth: {} }),
  });
  pending[1](response("run-new"));
  await newRequest;
  pending[0](response("run-old"));
  await oldRequest;
  assert.deepEqual(rendered, ["run-new"]);
});

function dashboardHarness() {
  const html = fs.readFileSync("web/index.html", "utf8");
  const panel = { innerHTML: "" };
  const dialog = { open: false, dataset: {} as { req?: string }, showModal() { this.open = true; }, close() { this.open = false; } };
  const button = { dataset: { details: "REQ123" } };
  const list = { innerHTML: "" };
  const empty = { hidden: false };
  const query = { innerHTML: "", hidden: true, scrollIntoView() {} };
  const document = { querySelector: (selector: string) => selector === "#req-grid" ? list : selector === "#empty-state" ? empty : selector === "#query-result" ? query : selector === "#req-details-dialog" ? dialog : selector === "#req-details-content" ? panel : {} };
  const context = vm.createContext({ document, URL, console, agGrid: mockGrid(list).agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows; this.toggleDetailsForTest = toggleDetails; this.renderQueryResultForTest = renderQueryResult; this.setMissingTagsForTest = (tags) => { state.missingTags = tags; };`, context);
  const render = (result: object) => {
    dialog.close();
    panel.innerHTML = "";
    (context as { renderRowsForTest: (reqs: string[], results: object[]) => void })
      .renderRowsForTest(["REQ123"], [{ req: "REQ123", ...result }]);
  };
  const toggle = () => (context as { toggleDetailsForTest: (button: object) => void }).toggleDetailsForTest(button);
  const renderQuery = (result: object) => (context as { renderQueryResultForTest: (result: object) => void })
    .renderQueryResultForTest({ req: "REQ123", ...result });
  const setMissingTags = (tags: object) => (context as { setMissingTagsForTest: (tags: object) => void }).setMissingTagsForTest(tags);
  return { html, list, panel, cell: panel, dialog, button, render, toggle, query, renderQuery, setMissingTags };
}

test("portal status is literal, independent of conversation status and unavailable when absent", () => {
  const ui = dashboardHarness();
  assert.match(frontendSource(), /headerName: "Portal"/);
  ui.render({ status: "Asignado por mesa", conversationStatus: "Pendiente de respuesta", microservices: ["servicio-a"], title: "Resumen" });
  assert.match(ui.list.innerHTML, /Asignado por mesa/);
  assert.doesNotMatch(ui.list.innerHTML, /<span class="badge[^>]*>Pendiente de respuesta/);
  assert.match(ui.list.innerHTML, /servicio-a/);
  ui.render({ conversationStatus: "Finalizada", status: null, microservices: [] });
  assert.match(ui.list.innerHTML, /Estado no disponible/);
  assert.doesNotMatch(ui.list.innerHTML, /Sin microservicio/);
});

test("table exposes conversation state and Operations reply without replacing the portal status", () => {
  const ui = dashboardHarness();
  ui.render({ status: "Pendiente", conversationStatus: "Respondida", latestOperationsComment: {
    author: "Operations", date: null, text: "Please review", attachments: [],
  } });
  assert.match(ui.list.innerHTML, /class="badge portal-status warning"[^>]*>Pendiente<\/span>/);
  assert.match(ui.list.innerHTML, /class="conversation-status answered"[^>]*>Ya respondiste<\/span>/);
  assert.doesNotMatch(ui.list.innerHTML, />Respondida<\/span>/);
  assert.doesNotMatch(ui.list.innerHTML, /Operaciones respondió/);
  ui.render({ status: "Pendiente", conversationStatus: "Pendiente de respuesta", latestOperationsComment: {
    author: "Operations", date: null, text: "Please review", attachments: [],
  } });
  assert.match(ui.list.innerHTML, /class="conversation-status pending"[^>]*>Te toca responder<\/span>/);
  assert.doesNotMatch(ui.list.innerHTML, />Pendiente de respuesta<\/span>|Operaciones respondió/);
  assert.doesNotMatch(ui.list.innerHTML, /Ya respondiste/);
  ui.render({ status: "Pendiente", conversationStatus: "Pendiente de respuesta" });
  assert.match(ui.list.innerHTML, />Pendiente de respuesta<\/span>/);
  assert.doesNotMatch(ui.list.innerHTML, /Te toca responder/);
  ui.render({ status: "Pendiente", conversationStatus: "Pendiente de respuesta",
    latestOperationsComment: { author: "Operations", date: null, text: "Please review" },
    comments: [{ date: null }, { date: "19 nov 2026, 18:02" }],
  });
  assert.match(ui.list.innerHTML, /Orden de mensajes sin confirmar/);
  assert.doesNotMatch(ui.list.innerHTML, /Te toca responder/);
  ui.render({ status: "Asignada", conversationStatus: "<script>", latestOperationsComment: null });
  assert.match(ui.list.innerHTML, /class="conversation-status[^"]*"[^>]*>&lt;script&gt;<\/span>/);
  assert.doesNotMatch(ui.list.innerHTML, /Operaciones respondió/);
});

test("estimated business deadline is visibly distinct from a stated deadline and cannot trigger an alert", () => {
  const ui = dashboardHarness();
  ui.render({ status: "Pendiente", conversationStatus: "Pendiente de respuesta", activeDeadline: null,
    estimatedDeadlineDate: "2026-11-20" });
  assert.match(ui.list.innerHTML, /Estimado: 2026-11-20 \(3 días hábiles\)/);
  assert.doesNotMatch(ui.list.innerHTML, /Vence en menos de 24 horas|Plazo vencido/);
  ui.toggle();
  assert.match(ui.cell.innerHTML, /20\/11\/2026 \(estimado: 3 días hábiles\)/);
});

test("portal status badges retain literal text with distinct, safe color classes", () => {
  const ui = dashboardHarness();
  for (const [status, tone] of [
    ["Pending", "warning"], ["Pendiente", "warning"], ["En curso", "info"],
    ["Finalizada", "success"], ["Rechazada", "danger"],
  ]) {
    ui.render({ status, conversationStatus: "Pendiente de respuesta" });
    assert.match(ui.list.innerHTML, new RegExp(`class="badge portal-status ${tone}"[^>]*>${status}<`));
  }
  ui.render({ status: "Other <status>" });
  assert.match(ui.list.innerHTML, /class="badge portal-status neutral"[^>]*>Other &lt;status&gt;<\/span>/);
  ui.render({ status: null });
  assert.match(ui.list.innerHTML, /class="badge portal-status unavailable"[^>]*>Estado no disponible<\/span>/);
  const css = fs.readFileSync("web/styles.css", "utf8");
  for (const tone of ["warning", "info", "success", "danger", "neutral", "unavailable"]) {
    assert.match(css, new RegExp(`\\.portal-status\\.${tone}\\s*\\{`));
  }
});

test("dashboard distinguishes a closed ticket from its approval outcome", () => {
  const ui = dashboardHarness();
  ui.render({ status: "Finalizado", conversationStatus: "Finalizada", closureOutcome: "needs_correction" });
  assert.match(ui.list.innerHTML, /portal-status warning[^>]*>Finalizado/);
  assert.match(ui.list.innerHTML, /Cerrada con observaciones/);
  ui.render({ status: "Finalizado", conversationStatus: "Finalizada", closureOutcome: "unknown" });
  assert.match(ui.list.innerHTML, /portal-status neutral[^>]*>Finalizado/);
  assert.match(ui.list.innerHTML, /Cierre sin resultado claro/);
  ui.renderQuery({ status: "Finalizado", conversationStatus: "Finalizada", closureOutcome: "approved" });
  assert.match(ui.query.innerHTML, /Resultado del cierre \(calculado\)/);
  assert.match(ui.query.innerHTML, /Cierre aprobado/);
});

test("manual REQ message separates the Operations reply from status and preserves safe line breaks", () => {
  const ui = dashboardHarness();
  ui.renderQuery({ status: "Asignado", latestOperationsComment: {
    author: "Operaciones", text: "Primera línea\nSegunda <línea>", attachments: [],
  } });
  assert.match(ui.query.innerHTML, /Último comentario de Operaciones/);
  assert.match(ui.query.innerHTML, /Primera línea\n\nSegunda &lt;línea&gt;/);
  assert.doesNotMatch(ui.query.innerHTML, /<línea>/);
  assert.match(ui.query.innerHTML, /Estado del portal/);
});

test("details open in a separate dialog without compressing the grid cell", () => {
  const ui = dashboardHarness();
  const result = {
    status: "En curso", conversationStatus: "Pendiente de respuesta", description: "Descripción completa\nsegunda línea",
    instructions: "Paso primero", requester: "Persona Prueba", requesterUserId: "usuario-prueba",
    requesterEmail: "prueba@example.invalid", requesterPhone: "555-0100", sentAt: "fecha de envío",
    updatedAt: "fecha de actualización", requestDetails: { operationType: "Cambio", application: "App demo", requestType: "Tipo A", clientType: "Interno" },
    checkedAt: "2026-10-09T12:00:00.000Z", microservices: ["servicio-a"],
  };
  ui.render(result);
  assert.match(ui.list.innerHTML, /aria-label="Ver detalles de REQ123"/);
  assert.doesNotMatch(ui.list.innerHTML, /<span>Detalles<\/span>|grid-details/);
  assert.doesNotMatch(ui.list.innerHTML, /Persona Prueba|prueba@example.invalid|Descripción completa/);
  ui.toggle();
  assert.equal(ui.dialog.open, true);
  for (const value of ["Descripción completa", "segunda línea", "Paso primero", "Persona Prueba", "usuario-prueba", "prueba@example.invalid", "555-0100", "fecha de envío", "fecha de actualización", "Cambio", "App demo", "Tipo A", "Interno", "Pendiente de respuesta", "servicio-a"]) {
    assert.ok(ui.cell.innerHTML.includes(value), value);
  }
  ui.dialog.close();
  assert.equal(ui.dialog.open, false);
  ui.render(result);
  assert.equal(ui.dialog.open, false);
  assert.doesNotMatch(ui.list.innerHTML, /prueba@example.invalid/);
});

test("request title appears below its REQ without a separate Detail column", () => {
  const ui = dashboardHarness();
  ui.render({ title: "Short <request>" });
  assert.match(ui.list.innerHTML, /data-copy="REQ123"[^>]*>REQ123<\/button><\/div><span class="req-service"[^>]*>Short &lt;request&gt;<\/span>/);
  assert.doesNotMatch(ui.list.innerHTML, /class="req-service"[^>]*>Short <request>/);
  const context = vm.createContext({ document: { querySelector: () => ({}) }, URL, console });
  vm.runInContext(`${frontendSource().split('elements.credentialsButton.addEventListener')[0]}\nthis.columnsForTest = gridOptions.columnDefs;`, context);
  const columns = (context as { columnsForTest: { field?: string; filterValueGetter?: (params: { data: object }) => string }[] }).columnsForTest;
  assert.ok(!columns.some((column) => column.field === "detail"));
  assert.match(columns.find((column) => column.field === "req")?.filterValueGetter?.({ data: {
    req: "REQ123", project: "Project", microservices: "", detail: "Short request",
  } }) ?? "", /Short request/);
  ui.toggle();
  assert.match(ui.cell.innerHTML, /Short &lt;request&gt;/);
});

test("the table has no redundant refresh control and retains scheduled updates", () => {
  assert.doesNotMatch(fs.readFileSync("web/index.html", "utf8"), /id="refresh-button"/);
  assert.doesNotMatch(frontendSource(), /elements\.refresh|#refresh-button/);
  assert.match(frontendSource(), /window\.setInterval\(\(\) => \{/);
  assert.match(frontendSource(), /loadDashboard\(true\)/);
});

test("every REQ row offers the lock action regardless of portal status", () => {
  const ui = dashboardHarness();
  for (const result of [{}, { status: "En curso" }, { status: "Finalizado" }]) {
    ui.render(result);
    assert.match(ui.list.innerHTML, /data-lock="REQ123" data-locked="false"/);
    assert.match(ui.list.innerHTML, /aria-label="Bloquear REQ123"/);
  }
});

test("only manually assigned missing tags appear in the row and details editor", () => {
  const ui = dashboardHarness();
  ui.render({ description: "Documentación MD y ejemplo de consumo" });
  assert.doesNotMatch(ui.list.innerHTML, /Falta MD de documentación/);
  ui.setMissingTags({ REQ123: ["documentation_md", "consumption_example"] });
  ui.render({ description: "Documentación MD y ejemplo de consumo" });
  assert.match(ui.list.innerHTML, /Falta MD de documentación/);
  assert.match(ui.list.innerHTML, /Falta ejemplo de consumo/);
  assert.doesNotMatch(ui.list.innerHTML, /Falta estándar de logs/);
  ui.toggle();
  assert.match(ui.panel.innerHTML, /name="missingTag" value="documentation_md" checked/);
  assert.match(ui.panel.innerHTML, /name="missingTag" value="consumption_example" checked/);
  assert.match(ui.panel.innerHTML, /name="missingTag" value="logging_standard"/);
  assert.doesNotMatch(ui.panel.innerHTML, /name="missingTag" value="logging_standard" checked/);
});

test("stored conversation history appears in the details dialog without exposing markup", () => {
  const ui = dashboardHarness();
  ui.render({ comments: [
    { author: "Solicitante", date: "10 nov 2026, 09:00", text: "Primera respuesta", attachments: [] },
    { author: "<Operaciones>", date: null, text: "Segunda <respuesta>\nOtra línea", attachments: [{ name: "archivo<script>.pdf" }] },
  ] });
  assert.doesNotMatch(ui.list.innerHTML, /Primera respuesta|Segunda/);
  ui.toggle();
  assert.equal(ui.dialog.open, true);
  assert.match(ui.cell.innerHTML, /Historial de la conversación/);
  assert.ok(ui.cell.innerHTML.indexOf("Primera respuesta") < ui.cell.innerHTML.indexOf("Segunda &lt;respuesta&gt;"));
  assert.match(ui.cell.innerHTML, /&lt;Operaciones&gt;/);
  assert.match(ui.cell.innerHTML, /Fecha no disponible/);
  assert.match(ui.cell.innerHTML, /archivo&lt;script&gt;\.pdf/);
  assert.doesNotMatch(ui.cell.innerHTML, /<Operaciones>|<respuesta>|<script>/);

  ui.render({});
  ui.toggle();
  assert.match(ui.cell.innerHTML, /Historial no disponible en los datos guardados/);
  ui.render({ comments: [] });
  ui.toggle();
  assert.match(ui.cell.innerHTML, /No hay comentarios guardados/);
});

test("Operations messages remove enclosing quotes and preserve readable paragraph breaks", () => {
  const ui = dashboardHarness();
  const text = '"👋 Saludo\n1. Revisar "RES_MS" <script>\n2. Confirmar"';
  const operations = { author: "Operations", date: null, text, isResponse: true, attachments: [] };
  ui.render({ comments: [
    { author: "Requester", date: null, text: '"Keep requester quotes"', isResponse: false, attachments: [] },
    operations,
  ], latestOperationsComment: operations });
  ui.toggle();
  assert.match(ui.cell.innerHTML, /<p>&quot;Keep requester quotes&quot;<\/p>/);
  assert.match(ui.cell.innerHTML, /<p class="operations-message">👋 Saludo\n\n1\. Revisar &quot;RES_MS&quot; &lt;script&gt;\n\n2\. Confirmar<\/p>/);
  assert.doesNotMatch(ui.cell.innerHTML, /<script>|<p class="operations-message">&quot;|Confirmar&quot;<\/p>/);
  ui.renderQuery({ status: "Pending", latestOperationsComment: operations });
  assert.match(ui.query.innerHTML, /<p>👋 Saludo\n\n1\. Revisar &quot;RES_MS&quot; &lt;script&gt;\n\n2\. Confirmar<\/p>/);
});

test("Operations reviewer signature replaces the profile owner only in rendered messages", () => {
  const ui = dashboardHarness();
  const operations = { author: "Profile Owner", date: null, isResponse: true,
    text: "Please review.\n--Revisa: Cesar Carreño\nBefore Friday", attachments: [] };
  ui.render({ comments: [operations, { author: "Requester", date: null, isResponse: false,
    text: "I responded", attachments: [] }], latestOperationsComment: operations });
  ui.toggle();
  assert.match(ui.cell.innerHTML, /<strong>Cesar Carreño<\/strong>/);
  assert.equal(operations.author, "Profile Owner", "stored author must not change");
  ui.renderQuery({ latestOperationsComment: operations });
  assert.match(ui.query.innerHTML, /<dt>Operaciones<\/dt><dd>Cesar Carreño<\/dd>/);
  ui.render({ comments: [{ ...operations, text: "No signature" }] });
  ui.toggle();
  assert.match(ui.cell.innerHTML, /<strong>Profile Owner<\/strong>/);
});

test("missing values stay unavailable and stored text and links cannot inject markup", () => {
  const ui = dashboardHarness();
  ui.render({ status: "<img src=x onerror=alert(1)>", title: "<svg onload=alert(1)>", detailUrl: "javascript:alert(1)", description: "<script>alert(1)</script>", requesterEmail: '" onfocus="alert(1)' });
  assert.doesNotMatch(ui.list.innerHTML, /<img|<svg[^>]*onload|href="javascript:/);
  assert.match(ui.list.innerHTML, /&lt;img/);
  ui.toggle();
  assert.match(ui.cell.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.cell.innerHTML, /<script|onfocus="alert/);
  assert.match(ui.cell.innerHTML, /No disponible/);
});

test("observed project appears beside microservice and REQ and in accessible stored details", () => {
  const ui = dashboardHarness();
  assert.match(frontendSource(), /headerName: "REQ \/ Microservicio"/);
  ui.render({ projectName: "Proyecto Sintético", microservices: ["servicio-demo"] });
  assert.match(ui.list.innerHTML, /Proyecto Sintético/);
  assert.match(ui.list.innerHTML, /servicio-demo/);
  assert.match(ui.list.innerHTML, /REQ123/);
  ui.toggle();
  assert.match(ui.cell.innerHTML, /<dt>Proyecto<\/dt><dd>Proyecto Sintético<\/dd>/);
  assert.equal(ui.dialog.open, true);
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

function filterHarness() {
  const fields = new Map<string, { textContent: string; value: string; innerHTML: string; hidden: boolean; open?: boolean }>();
  const stub = (selector: string) => {
    if (!fields.has(selector)) fields.set(selector, { textContent: "", value: "", innerHTML: "", hidden: false });
    return fields.get(selector);
  };
  const panel = { innerHTML: "" };
  const dialog = { open: false, dataset: {} as { req?: string }, showModal() { this.open = true; }, close() { this.open = false; } };
  const list = { innerHTML: "" };
  const detailsButton = {
    dataset: { details: "REQ100" },
  };
  const document = {
    querySelector: (selector: string) => {
      if (selector === "#req-grid") return list;
      if (selector === "#query-result") return stub(selector);
      if (selector === "#req-details-dialog") return dialog;
      if (selector === "#req-details-content") return panel;
      return stub(selector);
    },
  };
  const grid = mockGrid(list);
  const context = vm.createContext({ document, URL, console, agGrid: grid.agGrid });
  const script = frontendSource().split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(
    `${script}\nthis.renderRowsForTest = renderRows; this.toggleDetailsForTest = toggleDetails; this.setFiltersForTest = (text, status) => { this.testFilters = { text, status }; gridApi.setGridOption('quickFilterText', text); gridApi.setFilterModel(status === 'all' ? null : { status: { filter: status } }); }; this.getFiltersForTest = () => this.testFilters; this.clearTableFiltersForTest = clearTableFilters; this.selectedReqsForTest = selectedReqs; this.setDashboardForTest = (reqs) => { state.dashboard = { reqs }; };`,
    context,
  );
  const typed = context as unknown as {
    renderRowsForTest: (reqs: string[], results: object[]) => void;
    toggleDetailsForTest: (button: object) => void;
    setFiltersForTest: (text: string, status: string) => void;
    clearTableFiltersForTest: () => void;
    selectedReqsForTest: () => string[];
    getFiltersForTest: () => { text: string; status: string };
    setDashboardForTest: (reqs: string[]) => void;
  };
  const rows = () => [
    { req: "REQ100", status: "En curso", projectName: "Proyecto Alfa", microservices: ["servicio-pagos"] },
    { req: "REQ200", status: "Asignado por mesa", projectName: "Proyecto Beta", microservices: ["servicio-envios"] },
    { req: "REQ300", status: null, projectName: null, microservices: [] },
  ];
  const renderAll = () => { typed.setDashboardForTest(["REQ100", "REQ200", "REQ300"]); typed.renderRowsForTest(["REQ100", "REQ200", "REQ300"], rows()); };
  return { fields, list, panel, dialog, cell: panel, detailsButton, typed, renderAll, stub, grid };
}

test("searchable filter suggestions follow monitored REQs without clearing a current choice", () => {
  const ui = filterHarness();
  ui.typed.setDashboardForTest(["REQ100", "REQ200"]);
  ui.typed.renderRowsForTest(["REQ100", "REQ200"], [
    { req: "REQ100", projectName: "Alpha", microservices: ["shared", "billing"], status: "Pending",
      requestDetails: { requestType: "Static" } },
    { req: "REQ200", projectName: "Beta", microservices: ["shared"], status: "Completed",
      requestDetails: { requestType: "Validation" } },
    { req: "REQ999", projectName: "Unmonitored", microservices: ["unused"], status: "Other" },
  ]);
  assert.match(ui.stub("#filter-project-options").innerHTML, /Alpha.*Beta/);
  assert.doesNotMatch(ui.stub("#filter-project-options").innerHTML, /Unmonitored/);
  assert.equal((ui.stub("#filter-microservice-options").innerHTML.match(/>shared<\/div>/g) ?? []).length, 1);
  ui.stub("#filter-project").value = "Alpha";
  ui.typed.setDashboardForTest(["REQ200"]);
  ui.typed.renderRowsForTest(["REQ200"], [{ req: "REQ200", projectName: "Gamma", microservices: ["new"],
    status: "In progress", requestDetails: { requestType: "Support" } }]);
  assert.match(ui.stub("#filter-project-options").innerHTML, /role="option"[^>]*>Gamma<\/div>/);
  assert.doesNotMatch(ui.stub("#filter-project-options").innerHTML, /Alpha|Beta/);
  assert.equal(ui.stub("#filter-project").value, "Alpha", "refresh must not overwrite typed selection");
});

test("inferred project shares the observed project's filter option", () => {
  const ui = filterHarness();
  const reqs = ["REQ100", "REQ101"];
  ui.typed.setDashboardForTest(reqs);
  ui.typed.renderRowsForTest(reqs, [
    { req: "REQ100", projectName: "Alpha", microservices: ["shared"] },
    { req: "REQ101", projectName: null, microservices: ["shared"] },
  ]);
  const options = ui.stub("#filter-project-options").innerHTML;
  assert.equal((options.match(/>Alpha<\/div>/g) ?? []).length, 1);
  assert.doesNotMatch(options, /Alpha \(inferido\)/);
  assert.match(ui.list.innerHTML, /Alpha \(inferido\)/, "the row retains its inference provenance");
});

test("text filter matches REQ number, observed project and microservice without portal queries", () => {
  const ui = filterHarness();
  assert.equal(typeof (ui.typed as unknown as Record<string, unknown>).renderRowsForTest, "function");
  ui.typed.setFiltersForTest("pagos", "all");
  ui.renderAll();
  assert.match(ui.list.innerHTML, /REQ100/);
  assert.doesNotMatch(ui.list.innerHTML, /REQ200/);
  ui.typed.setFiltersForTest("beta", "all");
  ui.renderAll();
  assert.match(ui.list.innerHTML, /REQ200/);
  assert.doesNotMatch(ui.list.innerHTML, /REQ100/);
  ui.typed.setFiltersForTest("req300", "all");
  ui.renderAll();
  assert.match(ui.list.innerHTML, /REQ300/);
  assert.doesNotMatch(ui.list.innerHTML, /REQ100/);
});

test("missing project is inferred only from unambiguous shared microservices in configured REQs", () => {
  const ui = filterHarness();
  const reqs = ["REQ100", "REQ200", "REQ300", "REQ400"];
  const target = { req: "REQ300", projectName: null, microservices: [" SharedApi "] };
  const donor = { req: "REQ100", projectName: "Project Alpha", microservices: ["sharedapi"] };
  const other = { req: "REQ200", projectName: "Project Beta", microservices: ["OtherApi"] };
  const show = (results: object[]) => {
    ui.typed.setDashboardForTest(reqs);
    ui.typed.renderRowsForTest(reqs, results);
    ui.typed.toggleDetailsForTest({ dataset: { details: "REQ300" } });
  };
  show([donor, other, target]);
  assert.match(ui.list.innerHTML, /Project Alpha/);
  assert.match(ui.panel.innerHTML, /Proyecto \(inferido de otras REQ\)<\/dt><dd>Project Alpha<\/dd>/);
  assert.equal(target.projectName, null, "inference must not overwrite the portal result");

  show([donor, other, { ...target, microservices: ["SharedApi", "OtherApi"] }]);
  assert.match(ui.panel.innerHTML, /<dt>Proyecto<\/dt><dd>No disponible<\/dd>/,
    "conflicting projects must not be guessed");
  show([donor, other, { ...target, microservices: ["UnknownApi"] }]);
  assert.match(ui.panel.innerHTML, /<dt>Proyecto<\/dt><dd>No disponible<\/dd>/);
  show([donor, other, { ...target, projectName: "Explicit Project" }]);
  assert.match(ui.panel.innerHTML, /<dt>Proyecto<\/dt><dd>Explicit Project<\/dd>/);
  show([{ req: "REQ999", projectName: "Outside Project", microservices: ["SharedApi"] }, target]);
  assert.match(ui.panel.innerHTML, /<dt>Proyecto<\/dt><dd>No disponible<\/dd>/,
    "only configured REQs may provide a project");
});

test("status selector filters literal portal status including unavailable", () => {
  const ui = filterHarness();
  ui.typed.setFiltersForTest("", "En curso");
  ui.renderAll();
  assert.match(ui.list.innerHTML, /REQ100/);
  assert.doesNotMatch(ui.list.innerHTML, /REQ200|REQ300/);
  ui.typed.setFiltersForTest("", "Estado no disponible");
  ui.renderAll();
  assert.match(ui.list.innerHTML, /REQ300/);
  assert.doesNotMatch(ui.list.innerHTML, /REQ100|REQ200/);
});

test("table result count follows filtered rows across pages and clear filters restores it without metric cards", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.doesNotMatch(html, /class="summary"|id="count-(?:total|pending|answered|validation|finished)"/);
  const ui = filterHarness();
  const reqs = Array.from({ length: 13 }, (_, index) => `REQ${index + 100}`);
  const results = reqs.map((req, index) => ({ req,
    projectName: index === 0 ? "Payments" : "Other",
    microservices: [], status: index === 0 ? "En curso" : "Finalizado",
    conversationStatus: index === 0 ? "Pendiente de respuesta" : index === 1 ? "Respondida" :
      index === 2 ? "En validación" : "Finalizada" }));
  ui.typed.setDashboardForTest(reqs);
  ui.typed.renderRowsForTest(reqs, results);
  assert.match(String(ui.fields.get("#filter-count")?.textContent ?? ""), /13.*13/);
  ui.typed.setFiltersForTest("Payments", "all");
  assert.match(String(ui.fields.get("#filter-count")?.textContent ?? ""), /1.*13/);
  ui.typed.setFiltersForTest("", "Finalizado");
  assert.match(String(ui.fields.get("#filter-count")?.textContent ?? ""), /12.*13/, "count includes filtered rows beyond the first page");
  ui.typed.setFiltersForTest("sin-coincidencias", "Finalizado");
  assert.match(String(ui.fields.get("#filter-count")?.textContent ?? ""), /0.*13/);
  assert.equal(ui.stub("#empty-state").hidden, false);
  assert.match(ui.stub("#empty-state").textContent, /sin coincidencias/i);
  ui.typed.clearTableFiltersForTest();
  assert.match(String(ui.fields.get("#filter-count")?.textContent ?? ""), /13.*13/);
  assert.match(ui.list.innerHTML, /REQ100/);
  ui.grid.select("REQ100");
  ui.typed.setFiltersForTest("Other", "all");
  ui.typed.clearTableFiltersForTest();
  assert.deepEqual(Array.from(ui.typed.selectedReqsForTest()), ["REQ100"], "clearing filters must not change selection");
});

test("filters persist across re-render and detail controls follow the filtered rows", () => {
  const ui = filterHarness();
  ui.typed.setFiltersForTest("pagos", "all");
  ui.renderAll();
  ui.renderAll();
  assert.equal(ui.typed.getFiltersForTest().text, "pagos");
  assert.equal(ui.typed.getFiltersForTest().status, "all");
  assert.match(ui.list.innerHTML, /REQ100/);
  assert.doesNotMatch(ui.list.innerHTML, /REQ200/);
  ui.typed.toggleDetailsForTest(ui.detailsButton);
  assert.equal(ui.dialog.open, true);
  assert.match(ui.cell.innerHTML, /Proyecto Alfa/);
});

test("clear filters control is available", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.match(html, /id="clear-filters-button"[^>]*>Limpiar filtros<\/button>/);
  assert.match(html, /id="filter-count"/);
  assert.match(frontendSource(), /elements\.clearFilters\.addEventListener\("click", clearTableFilters\)/);
});
