const state = { dashboard: null, visibleResults: [] };

const elements = {
  list: document.querySelector("#req-list"),
  empty: document.querySelector("#empty-state"),
  run: document.querySelector("#run-button"),
  refresh: document.querySelector("#refresh-button"),
  addForm: document.querySelector("#add-form"),
  queryForm: document.querySelector("#query-form"),
  queryResult: document.querySelector("#query-result"),
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

function updateMonitor(monitor, schedule) {
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
  document.querySelector("#monitor-time").textContent = !busy && schedule && !schedule.allowed
    ? schedule.reason
    : monitor.finishedAt
      ? `Última ejecución: ${formatDate(monitor.finishedAt)}`
      : "Aún sin ejecución registrada";
  const scheduledAccess = schedule?.allowed !== false;
  document.querySelector("#status-dot").className = `status-dot ${busy ? "running" : scheduledAccess ? "ready" : "off"}`;
  elements.run.disabled = busy || !scheduledAccess;
  elements.queryForm.querySelector("button").disabled = busy;
}

function renderRows(reqs, results) {
  const byReq = new Map(results.map((result) => [result.req, result]));
  state.visibleResults = reqs.map((req) => byReq.get(req) || null);
  elements.empty.hidden = reqs.length > 0;
  elements.list.innerHTML = reqs.map((req, index) => {
    const result = state.visibleResults[index];
    const status = result?.status?.trim() ? result.status : "Estado no disponible";
    const reqLink = result?.detailUrl
      ? `<a class="req-number" href="${safeUrl(result.detailUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(req)}</a>`
      : `<span class="req-number">${escapeHtml(req)}</span>`;
    const microservices = Array.isArray(result?.microservices) ? result.microservices.filter(Boolean).join(", ") : "";
    const detail = result?.error || result?.title || "Información no disponible";
    return `<tr>
      <td><div class="req-identity">${microservices ? `<span class="req-service">${escapeHtml(microservices)}</span>` : ""}${reqLink}</div></td>
      <td><span class="badge">${escapeHtml(status)}</span></td>
      <td class="deadline-cell" data-label="Plazo indicado">${escapeHtml(statedDeadline(result))}</td>
      <td><div class="req-title">${escapeHtml(detail)}</div></td>
      <td>${escapeHtml(formatDate(result?.checkedAt))}</td>
      <td><div class="row-actions">
        <button class="secondary" data-details="${index}" type="button" aria-expanded="false" aria-controls="req-details-${index}" aria-label="Ver detalles de ${escapeHtml(req)}">Ver detalles</button>
        <button class="secondary" data-query="${escapeHtml(req)}" type="button">Consultar</button>
        <button class="danger-button" data-delete="${escapeHtml(req)}" type="button">Borrar</button>
      </div></td>
    </tr><tr class="detail-row" id="req-details-${index}" data-detail-panel="${index}" hidden><td colspan="6"></td>
    </tr>`;
  }).join("");
}

function available(value) {
  return value == null || String(value).trim() === "" ? "No disponible" : String(value);
}

function renderStoredDetails(result) {
  const fields = [
    ["Estado del portal", result?.status],
    ["Estado de conversación (calculado)", result?.conversationStatus],
    ["Título", result?.title],
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
    ["Error de consulta", result?.error],
  ];
  return `<div class="stored-details" aria-label="Detalles de la REQ">
    <h3>Información guardada de la REQ</h3>
    <dl class="result-grid">${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(available(value))}</dd></div>`).join("")}</dl>
    <div class="detail-text"><h4>Descripción detallada de la solicitud</h4><p>${escapeHtml(available(result?.description))}</p></div>
    <div class="detail-text"><h4>Instrucciones</h4><p>${escapeHtml(available(result?.instructions))}</p></div>
  </div>`;
}

function toggleDetails(button) {
  const index = Number(button.dataset.details);
  if (!Number.isInteger(index) || index < 0 || index >= state.visibleResults.length) return;
  const panel = elements.list.querySelector(`[data-detail-panel="${index}"]`);
  if (!panel) return;
  const open = panel.hidden;
  panel.hidden = !open;
  panel.querySelector("td").innerHTML = open ? renderStoredDetails(state.visibleResults[index]) : "";
  button.setAttribute("aria-expanded", String(open));
  button.textContent = open ? "Ocultar detalles" : "Ver detalles";
  button.setAttribute("aria-label", `${button.textContent} de ${state.visibleResults[index]?.req || "la REQ"}`);
}

function renderDashboard(data) {
  state.dashboard = data;
  updateSummary(data.reqs, data.results);
  updateMonitor(data.monitor, data.schedule);
  renderRows(data.reqs, data.results);
}

async function loadDashboard(silent = false) {
  try {
    renderDashboard(await api("/api/dashboard"));
  } catch (error) {
    if (!silent) toast(error.message);
  }
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
    ${result.error ? `<p>${escapeHtml(result.error)}</p>` : `
      <dl class="result-grid">
        <div><dt>Estado de conversación (calculado)</dt><dd><span class="badge ${statusClass(result.conversationStatus)}">${escapeHtml(available(result.conversationStatus))}</span></dd></div>
        <div><dt>Estado del portal</dt><dd>${escapeHtml(result.status?.trim() ? result.status : "Estado no disponible")}</dd></div>
        <div><dt>Consultada</dt><dd>${escapeHtml(formatDate(result.checkedAt))}</dd></div>
        <div><dt>Título</dt><dd>${escapeHtml(result.title || "Sin título")}</dd></div>
        <div><dt>Microservicios</dt><dd>${escapeHtml((result.microservices || []).join(", ") || "No disponibles")}</dd></div>
        <div><dt>Operaciones</dt><dd>${escapeHtml(comment?.author || "Sin comentario")}</dd></div>
      </dl>
      ${comment?.text ? `<p class="result-comment">${escapeHtml(comment.text)}</p>` : ""}
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
    toast(error.message);
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
    renderQueryResult(data.results[0]);
    toast("Consulta completada");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Consultar REQ";
    loadDashboard(true);
  }
}

elements.credentialsButton.addEventListener("click", () => {
  elements.credentialsDialog.showModal();
  document.querySelector("#credentials-username").focus();
});

document.querySelector("#credentials-cancel").addEventListener("click", () => {
  elements.credentialsDialog.close();
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
window.setInterval(() => loadDashboard(true), 15_000);
