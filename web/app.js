const state = {
  dashboard: null, resultsByReq: new Map(),
  accessPromptedRun: null, alertedMonitorRun: null,
};
let dashboardRequestSequence = 0;
let progressPollTimer = null;

const elements = {
  list: document.querySelector("#req-grid"),
  empty: document.querySelector("#empty-state"),
  run: document.querySelector("#run-button"),
  refresh: document.querySelector("#refresh-button"),
  addForm: document.querySelector("#add-form"),
  queryForm: document.querySelector("#query-form"),
  queryResult: document.querySelector("#query-result"),
  filterCount: document.querySelector("#filter-count"),
  credentialsButton: document.querySelector("#credentials-button"),
  credentialsDialog: document.querySelector("#credentials-dialog"),
  credentialsForm: document.querySelector("#credentials-form"),
  toast: document.querySelector("#toast"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? escapeHtml(url.href) : "#";
  } catch {
    return "#";
  }
}

const actionIcons = {
  details: '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  query: '<path d="M20 11a8 8 0 0 0-14-4L4 9m0-5v5h5M4 13a8 8 0 0 0 14 4l2-2m0 5v-5h-5"/>',
  delete: '<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6m4-6v6"/>',
  portal: '<path d="M13 5h6v6m0-6-9 9m9-1v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
};

function actionIcon(name) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${actionIcons[name]}</svg>`;
}

function statusClass(status) {
  return {
    "Pendiente de respuesta": "pending",
    Respondida: "answered",
    "En validación": "validation",
    Finalizada: "finished",
  }[status] || "";
}

function formatDate(value) {
  if (!value) return "Sin revisión";
  const date = new Date(typeof value === "string" ? value.replace(" at ", " ") : value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
}

function statedDeadline(result) {
  if (result && result.conversationStatus !== "Pendiente de respuesta" && result.conversationStatus !== "En validación") {
    return "Plazo inactivo";
  }
  const dueAt = result?.activeDeadline?.dueAt;
  if (!dueAt || Number.isNaN(new Date(dueAt).valueOf())) return "Sin plazo indicado";
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", day: "numeric", month: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hourCycle: "h12",
  }).format(new Date(dueAt));
}

function normalizeReq(value) {
  return value.trim().toUpperCase();
}

function fileType(name) {
  const extension = String(name).split(".").pop();
  return extension && extension !== name ? extension.toUpperCase().slice(0, 5) : "FILE";
}

function attachmentsWithDates(result, attachments) {
  const dates = new Map();
  for (const comment of result.comments || []) {
    for (const attachment of comment.attachments || []) {
      const key = attachment.url || attachment.name;
      if (!dates.has(key)) dates.set(key, comment.date);
    }
  }
  return attachments.map((attachment) => ({
    ...attachment,
    uploadedAt: dates.get(attachment.url || attachment.name) || null,
  }));
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(toast.timeout);
  toast.timeout = window.setTimeout(() => elements.toast.classList.remove("visible"), 3500);
}

async function copyReq(req) {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(req);
      copied = true;
    }
  } catch { /* Fall back for browsers without clipboard permission. */ }
  if (!copied && typeof document.execCommand === "function") {
    const source = document.createElement("textarea");
    const previousFocus = document.activeElement;
    source.className = "clipboard-source";
    source.value = req;
    document.body.append(source);
    source.select();
    try { copied = document.execCommand("copy"); } catch { /* Report the failure below. */ }
    finally {
      source.remove();
      previousFocus?.focus?.();
    }
  }
  toast(copied ? `${req} copiada al portapapeles` : `No se pudo copiar ${req}. Revisá los permisos del navegador.`);
}

function isAccessError(message) {
  const text = String(message ?? "").trim();
  return /(?:^|[\r\n])(?:Error: |REQ\d+: )?La sesión expiró\.(?:[\r\n]|$)/i.test(text) ||
    /(?:^|[\r\n])(?:Error: )?No existe [^\r\n]+\. Ejecuta: pnpm run auth(?:[\r\n]|$)/i.test(text) ||
    /^(?:No existe sesión MiAsistencia360|Sesión MiAsistencia360 expirada); usa Acceso$/i.test(text);
}

function openCredentialsDialog() {
  if (elements.credentialsDialog.open) return;
  elements.credentialsDialog.showModal();
  document.querySelector("#credentials-username").focus();
}

function handleAccessError(message) {
  if (!isAccessError(message)) return false;
  openCredentialsDialog();
  toast("Renová el acceso a MiAsistencia360 para continuar");
  return true;
}

function webError(message) {
  return isAccessError(message) ? "Se necesita renovar el acceso a MiAsistencia360" : message;
}

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers };
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function updateSummary(reqs, results) {
  const statuses = new Map(results.map((result) => [result.req, result.conversationStatus]));
  const count = (status) => reqs.filter((req) => statuses.get(req) === status).length;
  document.querySelector("#count-total").textContent = reqs.length;
  document.querySelector("#count-pending").textContent = count("Pendiente de respuesta");
  document.querySelector("#count-answered").textContent = count("Respondida");
  document.querySelector("#count-validation").textContent = count("En validación");
  document.querySelector("#count-finished").textContent = count("Finalizada");
}

function updateMonitor(monitor, schedule, progress, reqs) {
  const busy = Boolean(monitor.activeTask);
  const label = monitor.activeTask === "query"
    ? "Consultando REQ"
    : monitor.activeTask === "monitor"
      ? "Ejecutando monitor"
      : monitor.activeTask === "auth"
        ? "Renovando sesión"
        : schedule?.allowed
          ? "Monitor disponible"
          : "Fuera de horario";
  document.querySelector("#monitor-label").textContent = label;
  const currentProgress = monitor?.running && progress?.startedAt === monitor.startedAt;
  const analyzed = currentProgress ? reqs.filter((req) => progress.items?.[req] === "success").length : 0;
  const activeReq = currentProgress ? reqs.find((req) => progress.items?.[req] === "running") : null;
  const monitorTime = currentProgress
    ? `Analizadas ${analyzed} de ${reqs.length}${activeReq ? ` · Ahora: ${activeReq}` : ""}`
    : !busy && schedule && !schedule.allowed
      ? schedule.reason
      : monitor.finishedAt
        ? `Última ejecución: ${formatDate(monitor.finishedAt)}`
        : "Aún sin ejecución registrada";
  const timeElement = document.querySelector("#monitor-time");
  if (timeElement.textContent !== monitorTime) timeElement.textContent = monitorTime;
  const scheduledAccess = schedule?.allowed !== false;
  document.querySelector("#status-dot").className = `status-dot ${busy ? "running" : scheduledAccess ? "ready" : "off"}`;
  elements.run.disabled = busy || !scheduledAccess;
  elements.queryForm.querySelector("button").disabled = busy;
}

function portalStatusLabel(result) {
  return result?.status?.trim() ? result.status : "Estado no disponible";
}

function portalStatusTone(result) {
  const status = result?.status?.trim().toLowerCase();
  if (!status) return "unavailable";
  if (/^(pendiente|pending)(\b|$)/.test(status)) return "warning";
  if (/^(rechazad[oa]|rejected|cancelad[oa]|cancelled)(\b|$)/.test(status)) return "danger";
  if (/^(finalizad[oa]|completad[oa]|completed|closed|cerrad[oa])(\b|$)/.test(status)) return "success";
  if (/^(en curso|in progress|asignad[oa]|assigned)(\b|$)/.test(status)) return "info";
  return "neutral";
}

function updateFilterCount(total, shown) {
  if (elements.filterCount) elements.filterCount.textContent = `Mostrando ${shown} de ${total}`;
}

const gridOptions = {
  styleNonce: document.querySelector('meta[name="ag-grid-style-nonce"]')?.getAttribute?.("content"),
  theme: typeof agGrid !== "undefined" ? agGrid.themeQuartz.withParams({ browserColorScheme: "dark", accentColor: "#efb64d", backgroundColor: "#111b23", foregroundColor: "#edf4f4" }) : undefined,
  columnDefs: [
    { headerName: "Proyecto / Microservicio / REQ", field: "req", minWidth: 250, flex: 2, autoHeight: true,
      filterValueGetter: ({ data }) => data ? [data.req, data.project, data.microservices].join(" ") : "",
      cellRenderer: ({ data }) => {
        if (!data) return "";
        return `<div class="req-identity"><span class="req-project">${escapeHtml(data.project)}</span>${data.microservices ? `<span class="req-service">${escapeHtml(data.microservices)}</span>` : ""}<div class="req-id-line"><button class="req-number req-copy" data-copy="${escapeHtml(data.req)}" type="button" aria-label="Copiar ${escapeHtml(data.req)}" title="Copiar número de REQ">${escapeHtml(data.req)}</button>${data.monitorProgress ? `<span class="monitor-progress ${data.progressClass}" aria-label="Monitoreo: ${data.monitorProgress}">${data.monitorProgress}</span>` : ""}</div></div>`;
      } },
    { headerName: "Estado del portal", field: "status", minWidth: 170, flex: 1,
      cellRenderer: ({ data }) => data ? `<span class="badge portal-status ${portalStatusTone(data.result)}">${escapeHtml(data.status)}</span>` : "" },
    { headerName: "Detalle", field: "detail", minWidth: 250, flex: 2,
      cellRenderer: ({ data }) => data ? `<div class="req-title">${escapeHtml(data.detail)}</div>` : "" },
    { headerName: "Plazo y revisión", field: "checkedAt", minWidth: 230, flex: 1, autoHeight: true,
      comparator: (a, b) => (Date.parse(a) || 0) - (Date.parse(b) || 0),
      filterValueGetter: ({ data }) => data ? [data.deadline, formatDate(data.checkedAt), data.checkedAt, data.progressLabel].join(" ") : "",
      cellRenderer: ({ data }) => data ? `<div class="req-review">
        <div class="req-review-line"><span class="req-review-label">Plazo:</span> ${escapeHtml(data.deadline)}</div>
        <div class="req-review-line"><span class="req-review-label">Última revisión:</span> ${escapeHtml(formatDate(data.checkedAt))}${data.progressLabel
          ? `<span class="review-indicator ${data.progressClass}" role="img" aria-label="Monitoreo: ${escapeHtml(data.progressLabel)}" title="Monitoreo: ${escapeHtml(data.progressLabel)}"></span>` : ""}</div>
      </div>` : "" },
    { headerName: "Acciones", colId: "actions", minWidth: 205, sortable: false, filter: false, autoHeight: true,
      cellRenderer: ({ data }) => {
        if (!data) return "";
        const url = data.result?.detailUrl ? safeUrl(data.result.detailUrl) : "#";
        const portal = url === "#"
          ? `<button class="secondary icon-action" type="button" aria-label="Enlace de MiAsistencia360 no disponible" title="Enlace no disponible" disabled>${actionIcon("portal")}</button>`
          : `<a class="secondary icon-action" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="Abrir ${escapeHtml(data.req)} en MiAsistencia360" title="Abrir en MiAsistencia360">${actionIcon("portal")}</a>`;
        return `<div class="row-actions">
          <button class="secondary icon-action" data-details="${escapeHtml(data.req)}" type="button" aria-expanded="false" aria-label="Ver detalles de ${escapeHtml(data.req)}" title="Ver detalles">${actionIcon("details")}</button>
          <button class="secondary icon-action" data-query="${escapeHtml(data.req)}" type="button" aria-label="Consultar ${escapeHtml(data.req)}" title="Consultar">${actionIcon("query")}</button>
          ${portal}
          <button class="danger-button icon-action" data-delete="${escapeHtml(data.req)}" type="button" aria-label="Borrar ${escapeHtml(data.req)}" title="Borrar">${actionIcon("delete")}</button>
        </div><div class="grid-details" hidden></div>`;
      } },
  ],
  defaultColDef: { sortable: true, filter: true, resizable: true },
  getRowId: ({ data }) => data.req,
  pagination: true,
  paginationPageSize: 10,
  paginationPageSizeSelector: [10, 25, 50],
  animateRows: false,
  domLayout: "autoHeight",
  rowHeight: 84,
  localeText: { noRowsToShow: "No hay REQ para mostrar", page: "Página", of: "de", to: "a", filterOoo: "Filtrar...", contains: "Contiene", equals: "Igual a" },
  onModelUpdated: () => updateGridCount(),
};
let gridApi = typeof agGrid !== "undefined" && agGrid.createGrid
  ? agGrid.createGrid(elements.list, gridOptions) : null;

function updateGridCount() {
  if (!gridApi || !state.dashboard) return;
  const shown = gridApi.getDisplayedRowCount();
  updateFilterCount(state.dashboard.reqs.length, shown);
  elements.empty.hidden = state.dashboard.reqs.length > 0 && shown > 0;
  elements.empty.textContent = state.dashboard.reqs.length ? "Sin coincidencias para los filtros aplicados." : "No hay REQ configuradas.";
}

function renderRows(reqs, results, progress = null, monitor = null) {
  const byReq = new Map(results.map((result) => [result.req, result]));
  state.resultsByReq = byReq;
  if (!gridApi) {
    elements.empty.hidden = false;
    elements.empty.textContent = "Tabla no disponible. Actualizá la página para volver a cargar AG Grid.";
    updateFilterCount(reqs.length, 0);
    return;
  }
  const rowData = reqs.map((req) => {
    const result = byReq.get(req) || null;
    const inRun = progress?.startedAt && progress.startedAt === monitor?.startedAt;
    const checked = inRun ? progress.items?.[req] : null;
    return {
      req, result,
      project: result?.projectName?.trim() || "Proyecto no disponible",
      microservices: Array.isArray(result?.microservices) ? result.microservices.filter(Boolean).join(", ") : "",
      status: portalStatusLabel(result), deadline: statedDeadline(result),
      detail: webError(result?.error) || result?.title || "Información no disponible",
      checkedAt: result?.checkedAt || null,
      monitorProgress: monitor?.running && inRun
        ? checked === "running" ? "Analizando" : checked === "success" ? "Analizada" :
          checked === "error" ? "Error" : "En espera"
        : "",
      progressLabel: !inRun ? "" : checked === "running" ? "En revisión" :
        checked === "success" ? monitor?.running ? "Consultada · resultados al finalizar" : "Revisada" :
          checked === "error" ? "Error de revisión" : monitor?.running ? "Pendiente" : "No revisada",
      progressClass: checked === "running" ? "running" : checked === "success" ? "success" :
        checked === "error" ? "error" : "waiting",
    };
  });
  gridApi.setGridOption("rowData", rowData);
  updateGridCount();
}

function available(value) {
  return value == null || String(value).trim() === "" ? "No disponible" : String(value);
}

function renderStoredDetails(result) {
  const fields = [
    ["Estado del portal", result?.status],
    ["Estado de conversación (calculado)", result?.conversationStatus],
    ["Título", result?.title],
    ["Proyecto", result?.projectName],
    ["Microservicios detectados", result?.microservices?.length ? result.microservices.join(", ") : null],
    ["Tipo de operación", result?.requestDetails?.operationType],
    ["Aplicación", result?.requestDetails?.application],
    ["Tipo de solicitud", result?.requestDetails?.requestType],
    ["Tipo de cliente", result?.requestDetails?.clientType],
    ["Solicitante", result?.requester],
    ["ID de usuario", result?.requesterUserId],
    ["Correo electrónico", result?.requesterEmail],
    ["Teléfono", result?.requesterPhone],
    ["Enviado", result?.sentAt],
    ["Última actualización", result?.updatedAt],
    ["Última revisión", result?.checkedAt ? formatDate(result.checkedAt) : null],
    ["Plazo indicado", statedDeadline(result)],
    ["Error de consulta", webError(result?.error)],
  ];
  return `<div class="stored-details" aria-label="Detalles de la REQ">
    <h3>Información guardada de la REQ</h3>
    <dl class="result-grid">${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(available(value))}</dd></div>`).join("")}</dl>
    <div class="detail-text"><h4>Descripción detallada de la solicitud</h4><p>${escapeHtml(available(result?.description))}</p></div>
    <div class="detail-text"><h4>Instrucciones</h4><p>${escapeHtml(available(result?.instructions))}</p></div>
  </div>`;
}

function toggleDetails(button) {
  const req = button.dataset.details;
  const result = state.resultsByReq.get(req);
  if (!result) return;
  const panel = button.parentElement?.nextElementSibling;
  if (!panel) return;
  const open = panel.hidden;
  panel.hidden = !open;
  panel.innerHTML = open ? renderStoredDetails(result) : "";
  button.setAttribute("aria-expanded", String(open));
  const label = open ? "Ocultar detalles" : "Ver detalles";
  button.setAttribute("aria-label", `${label} de ${req}`);
  button.title = label;
  gridApi?.resetRowHeights();
}

function renderDashboard(data) {
  state.dashboard = data;
  renderAuthStatus(data.auth);
  updateSummary(data.reqs, data.results);
  updateMonitor(data.monitor, data.schedule, data.progress, data.reqs);
  renderRows(data.reqs, data.results, data.progress, data.monitor);
  updateProgressPolling(Boolean(data.monitor?.running));
  const monitor = data.monitor;
  if (monitor?.startedAt && !monitor.running && monitor.exitCode !== null &&
    data.progress?.startedAt === monitor.startedAt && state.alertedMonitorRun !== monitor.startedAt) {
    state.alertedMonitorRun = monitor.startedAt;
    const total = data.reqs.length;
    const notReviewed = data.reqs.filter((req) => data.progress.items?.[req] !== "success").length;
    if (total && notReviewed === total) toast("No se pudo revisar ninguna REQ en esta ejecución");
    else if (notReviewed) toast(`No se pudieron revisar ${notReviewed} de ${total} REQ`);
    else if (monitor.exitCode !== 0) toast("El monitoreo terminó con errores");
  }
  if (data.monitor?.authRequired && !data.monitor.running && data.monitor.startedAt &&
    state.accessPromptedRun !== data.monitor.startedAt) {
    state.accessPromptedRun = data.monitor.startedAt;
    handleAccessError("La sesión expiró.");
  }
}

function renderAuthStatus(auth) {
  const username = auth?.localSessionAvailable ? auth.username : null;
  const status = auth?.localSessionAvailable
    ? `Sesión local disponible, sin verificar en el portal${username ? ` · Usuario guardado (sin verificar): ${username}` : ""}`
    : "Sin sesión local disponible · Inicia sesión desde Acceso";
  document.querySelector("#auth-status").textContent = status;
  document.querySelector("#credentials-session-status").textContent = status;
  if (!elements.credentialsDialog.open) {
    document.querySelector("#credentials-username").value = username || "";
  }
}

async function loadDashboard(silent = false) {
  const request = ++dashboardRequestSequence;
  try {
    const data = await api("/api/dashboard");
    if (request === dashboardRequestSequence) renderDashboard(data);
  } catch (error) {
    if (!silent && request === dashboardRequestSequence) toast(error.message);
  }
}

function updateProgressPolling(running) {
  if (!running) {
    if (progressPollTimer !== null) window.clearTimeout(progressPollTimer);
    progressPollTimer = null;
    return;
  }
  if (progressPollTimer !== null) return;
  progressPollTimer = window.setTimeout(async () => {
    progressPollTimer = null;
    await loadDashboard(true);
    if (state.dashboard?.monitor?.running) updateProgressPolling(true);
  }, 2_000);
}

function renderQueryResult(result) {
  const comment = result.latestOperationsComment;
  const attachments = attachmentsWithDates(
    result,
    result.attachments || comment?.attachments || [],
  );
  const parseAttachmentDate = (value) => {
    if (!value) return Number.NaN;
    const parsed = new Date(String(value).replace(" at ", " "));
    return parsed.valueOf();
  };
  const downloadableAttachments = attachments
    .filter((attachment) => attachment.url)
    .sort((left, right) => {
      const leftTime = parseAttachmentDate(left.uploadedAt);
      const rightTime = parseAttachmentDate(right.uploadedAt);
      if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
      if (Number.isNaN(leftTime)) return 1;
      if (Number.isNaN(rightTime)) return -1;
      return rightTime - leftTime;
    });
  const latestAttachment = downloadableAttachments[0] || null;
  const olderAttachments = downloadableAttachments.slice(1);
  const links = [
    ...(result.detailUrl ? [{ label: "Abrir REQ", url: result.detailUrl }] : []),
    ...(result.pullRequestUrls || []).map((url, index) => ({ label: `Pull Request ${index + 1}`, url })),
  ];
  elements.queryResult.hidden = false;
  elements.queryResult.innerHTML = `
    <p class="eyebrow">RESULTADO MANUAL</p>
    <h2>${escapeHtml(result.req)}</h2>
    ${result.error ? `<p>${escapeHtml(webError(result.error))}</p>` : `
      <dl class="result-grid">
        <div><dt>Estado de conversación (calculado)</dt><dd><span class="badge ${statusClass(result.conversationStatus)}">${escapeHtml(available(result.conversationStatus))}</span></dd></div>
        <div><dt>Estado del portal</dt><dd>${escapeHtml(result.status?.trim() ? result.status : "Estado no disponible")}</dd></div>
        <div><dt>Consultada</dt><dd>${escapeHtml(formatDate(result.checkedAt))}</dd></div>
        <div><dt>Título</dt><dd>${escapeHtml(result.title || "Sin título")}</dd></div>
        <div><dt>Proyecto</dt><dd>${escapeHtml(result.projectName?.trim() ? result.projectName : "Proyecto no disponible")}</dd></div>
        <div><dt>Microservicios</dt><dd>${escapeHtml((result.microservices || []).join(", ") || "No disponibles")}</dd></div>
        <div><dt>Operaciones</dt><dd>${escapeHtml(comment?.author || "Sin comentario")}</dd></div>
      </dl>
      ${comment?.text ? `<section class="result-comment" aria-label="Último comentario de Operaciones">
        <h3>Último comentario de Operaciones</h3>
        <p>${escapeHtml(comment.text)}</p>
      </section>` : ""}
      <div class="result-resources">
        <div class="external-links">
          <span class="resource-label">Enlaces externos</span>
          <div>${links.map((link) => `<a class="external-link" href="${safeUrl(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join("")}</div>
        </div>
        ${attachments.some((attachment) => attachment.url) ? `
          <div class="attachment-section">
            <span class="resource-label">Archivos adjuntos <b>${downloadableAttachments.length}</b></span>
            ${latestAttachment ? `
              <div class="latest-attachment">
                <span class="latest-attachment-label">Ultimo adjunto</span>
                <button class="attachment-card" type="button" data-download-url="${escapeHtml(latestAttachment.url)}" data-download-name="${escapeHtml(latestAttachment.name)}">
                  <span class="file-type">${escapeHtml(fileType(latestAttachment.name))}</span>
                  <span class="file-details">
                    <strong>${escapeHtml(latestAttachment.name)}</strong>
                    <small>${escapeHtml(latestAttachment.size || "Tamaño no disponible")}</small>
                    <small class="file-date">Subido: ${escapeHtml(latestAttachment.uploadedAt ? formatDate(latestAttachment.uploadedAt) : "Fecha no disponible")}</small>
                  </span>
                  <span class="file-action">Descargar</span>
                </button>
              </div>
            ` : ""}
            ${olderAttachments.length > 0 ? `
              <details class="older-attachments">
                <summary>Ver ${olderAttachments.length} adjunto${olderAttachments.length === 1 ? "" : "s"} anterior${olderAttachments.length === 1 ? "" : "es"}</summary>
                <div class="attachment-grid compact">
                  ${olderAttachments.map((attachment) => `
                    <button class="attachment-card" type="button" data-download-url="${escapeHtml(attachment.url)}" data-download-name="${escapeHtml(attachment.name)}">
                      <span class="file-type">${escapeHtml(fileType(attachment.name))}</span>
                      <span class="file-details">
                        <strong>${escapeHtml(attachment.name)}</strong>
                        <small>${escapeHtml(attachment.size || "Tamaño no disponible")}</small>
                        <small class="file-date">Subido: ${escapeHtml(attachment.uploadedAt ? formatDate(attachment.uploadedAt) : "Fecha no disponible")}</small>
                      </span>
                      <span class="file-action">Descargar</span>
                    </button>
                  `).join("")}
                </div>
              </details>
            ` : ""}
          </div>
        ` : ""}
      </div>
    `}`;
  elements.queryResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function downloadAttachment(url, name, button) {
  button.disabled = true;
  const action = button.querySelector(".file-action");
  const originalText = action?.textContent;
  if (action) action.textContent = "Descargando...";
  try {
    const headers = { "Content-Type": "application/json" };
    const response = await fetch("/api/attachments/download", {
      method: "POST",
      headers,
      body: JSON.stringify({ url }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = name || "adjunto";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
    toast("Descarga iniciada");
  } catch (error) {
    if (!handleAccessError(error.message)) toast(error.message);
  } finally {
    button.disabled = false;
    if (action) action.textContent = originalText;
  }
}

async function queryReq(req) {
  const button = elements.queryForm.querySelector("button");
  button.disabled = true;
  button.textContent = "Consultando...";
  try {
    const data = await api("/api/reqs/query", { method: "POST", body: JSON.stringify({ req }) });
    if (!handleAccessError(data.results[0]?.error)) {
      renderQueryResult(data.results[0]);
      elements.queryResult.scrollIntoView?.({ behavior: "smooth", block: "start" });
      toast(data.results[0]?.error ? "No se pudo consultar la REQ" : "Consulta completada");
    }
  } catch (error) {
    if (!handleAccessError(error.message)) toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Consultar REQ";
    loadDashboard(true);
  }
}

elements.credentialsButton.addEventListener("click", () => {
  openCredentialsDialog();
});

document.querySelector("#credentials-cancel").addEventListener("click", () => {
  document.querySelector("#credentials-password").value = "";
  elements.credentialsDialog.close();
});

elements.credentialsDialog.addEventListener("close", () => {
  document.querySelector("#credentials-password").value = "";
});

elements.credentialsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.querySelector("#credentials-username");
  const password = document.querySelector("#credentials-password");
  const submit = elements.credentialsForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Renovando...";
  try {
    await api("/api/auth/renew", {
      method: "POST",
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    password.value = "";
    elements.credentialsDialog.close();
    toast("Sesión MiAsistencia360 renovada");
    await loadDashboard(true);
  } catch (error) {
    toast(error.message);
  } finally {
    password.value = "";
    submit.disabled = false;
    submit.textContent = "Renovar acceso";
  }
});

elements.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#add-req");
  try {
    await api("/api/reqs", { method: "POST", body: JSON.stringify({ req: normalizeReq(input.value) }) });
    input.value = "";
    await loadDashboard();
    toast("REQ agregada al monitoreo");
  } catch (error) { toast(error.message); }
});

elements.queryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  queryReq(normalizeReq(document.querySelector("#query-req").value));
});

elements.queryResult.addEventListener("click", (event) => {
  const button = event.target.closest("[data-download-url]");
  if (!button) return;
  downloadAttachment(button.dataset.downloadUrl, button.dataset.downloadName, button);
});

elements.list.addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    await copyReq(copyButton.dataset.copy);
    return;
  }
  const detailsButton = event.target.closest("[data-details]");
  if (detailsButton) {
    toggleDetails(detailsButton);
    return;
  }
  const queryButton = event.target.closest("[data-query]");
  if (queryButton) {
    document.querySelector("#query-req").value = queryButton.dataset.query;
    queryReq(queryButton.dataset.query);
    return;
  }
  const deleteButton = event.target.closest("[data-delete]");
  if (!deleteButton || !window.confirm(`¿Dejar de monitorear ${deleteButton.dataset.delete}?`)) return;
  try {
    await api(`/api/reqs/${encodeURIComponent(deleteButton.dataset.delete)}`, { method: "DELETE" });
    await loadDashboard();
    toast("REQ eliminada del monitoreo");
  } catch (error) { toast(error.message); }
});

elements.run.addEventListener("click", async () => {
  try {
    await api("/api/monitor/run", { method: "POST" });
    await loadDashboard();
    toast("Monitor iniciado");
  } catch (error) { toast(error.message); }
});

elements.refresh.addEventListener("click", () => loadDashboard());

async function start() {
  try {
    await loadDashboard();
  } catch (error) {
    toast(error.message);
  }
}

start();
window.setInterval(() => {
  if (!state.dashboard?.monitor?.running) loadDashboard(true);
}, 15_000);
