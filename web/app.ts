import { operationsReviewerName } from "../operations-reviewer.js";

const document: any = globalThis.document;
declare const agGrid: any;

type StoredAttachment = { name?: string | null; size?: string | null; url?: string | null };
type StoredResult = {
  req: string;
  status?: string | null;
  conversationStatus?: string | null;
  comments?: Array<{ author?: string | null; date?: string | null; text?: string | null; isResponse?: boolean;
    attachments?: StoredAttachment[] | null }> | null;
  attachments?: StoredAttachment[] | null;
  closureOutcome?: "approved" | "needs_correction" | "unknown" | null;
  latestOperationsComment?: { author: string; date: string | null; text: string } | null;
  title?: string | null;
  description?: string | null;
  instructions?: string | null;
  projectName?: string | null;
  microservices?: string[] | null;
  checkedAt?: string | null;
  detailUrl?: string | null;
  error?: string | null;
  activeDeadline?: { dueAt?: string | null } | null;
  statedDeadlineDate?: string | null;
  estimatedDeadlineDate?: string | null;
  deadlineOrderKnown?: boolean;
  requestDetails?: Record<string, string | null> | null;
  requester?: string | null;
  requesterUserId?: string | null;
  requesterEmail?: string | null;
  requesterPhone?: string | null;
  sentAt?: string | null;
  updatedAt?: string | null;
};

type DashboardPayload = {
  reqs: string[];
  results: StoredResult[];
  lockedReqs?: string[];
  missingTags?: Record<string, string[]>;
  monitor: {
    running: boolean;
    activeTask?: "monitor" | "query" | "auth" | null;
    selectedReqs?: string[] | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    exitCode?: number | null;
    authRequired?: boolean;
  };
  progress?: { startedAt: string | null; items?: Record<string, string> } | null;
  schedule?: { allowed: boolean; reason?: string; intervalMinutes?: number } | null;
  settings?: { allowOutsideHoursRuns?: boolean; intervalMinutes?: number };
  auth?: { localSessionAvailable?: boolean; username?: string | null };
};

type DashboardState = {
  dashboard: DashboardPayload | null;
  resultsByReq: Map<string, StoredResult>;
  missingTags: Record<string, string[]>;
  accessPromptedRun: string | null;
  alertedMonitorRun: string | null;
  outsideHoursSaving: boolean;
  runRequestPending: boolean;
  queryPendingReq: string | null;
};

const state: DashboardState = {
  dashboard: null, resultsByReq: new Map<string, StoredResult>(),
  missingTags: {},
  accessPromptedRun: null, alertedMonitorRun: null,
  outsideHoursSaving: false,
  runRequestPending: false,
  queryPendingReq: null,
};
let dashboardRequestSequence = 0;
let progressPollTimer: number | null = null;
let toastTimeout: number | null = null;
let gridApi: any = null;
const dateSortDirections = new Map<string, "asc" | "desc">();
let activeDateSortControl = "date";

const MISSING_TAG_OPTIONS = [
  { id: "documentation_md", label: "Falta MD de documentación" },
  { id: "logging_standard", label: "Falta estándar de logs" },
  { id: "consumption_example", label: "Falta ejemplo de consumo" },
];

const elements = {
  list: document.querySelector("#req-grid"),
  empty: document.querySelector("#empty-state"),
  run: document.querySelector("#run-button"),
  runAll: document.querySelector("#run-all-button"),
  selectionCount: document.querySelector("#selection-count"),
  outsideHours: document.querySelector("#outside-hours-button"),
  intervalForm: document.querySelector("#interval-form"),
  intervalInput: document.querySelector("#interval-minutes"),
  addForm: document.querySelector("#add-form"),
  queryForm: document.querySelector("#query-form"),
  queryResult: document.querySelector("#query-result"),
  detailsDialog: document.querySelector("#req-details-dialog"),
  detailsContent: document.querySelector("#req-details-content"),
  filterCount: document.querySelector("#filter-count"),
  clearFilters: document.querySelector("#clear-filters-button"),
  tableFilters: Object.fromEntries(["project", "microservice", "req", "type", "status", "blocked"]
    .map((field) => [field, document.querySelector(`#filter-${field}`)])),
  filterOptions: Object.fromEntries(["project", "microservice", "req", "type", "status"]
    .map((field) => [field, document.querySelector(`#filter-${field}-options`)])),
  sortDate: document.querySelector("#sort-date"),
  liveProgress: document.querySelector("#live-progress"),
  credentialsButton: document.querySelector("#credentials-button"),
  credentialsDialog: document.querySelector("#credentials-dialog"),
  credentialsForm: document.querySelector("#credentials-form"),
  toast: document.querySelector("#toast"),
  createReqButton: document.querySelector("#create-req-button"),
  createReqDialog: document.querySelector("#create-req-dialog"),
  createReqChoices: document.querySelector("#create-req-choices"),
  staticAnalysisGuide: document.querySelector("#static-analysis-guide"),
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
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0V5"/>',
  details: '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  query: '<path d="M20 11a8 8 0 0 0-14-4L4 9m0-5v5h5M4 13a8 8 0 0 0 14 4l2-2m0 5v-5h-5"/>',
  delete: '<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6m4-6v6"/>',
  portal: '<path d="M13 5h6v6m0-6-9 9m9-1v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

function actionIcon(name) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${actionIcons[name]}</svg>`;
}

function setLoading(button, loading) {
  button?.setAttribute?.("aria-busy", String(loading));
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

function formatActivityDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Fecha no disponible";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function statedDeadline(result, tableDateOnly = false) {
  if (result?.conversationStatus === "Finalizada") return "Plazo inactivo";
  const dateOnly = result?.statedDeadlineDate;
  if (typeof dateOnly === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    const [year, month, day] = dateOnly.split("-");
    if (!result.deadlineOrderKnown) {
      return tableDateOnly ? dateOnly : `${day}/${month}/${year} (vigencia sin confirmar; sin hora)`;
    }
    if (result.conversationStatus === "Pendiente de respuesta" || result.conversationStatus === "En validación") {
      return tableDateOnly ? dateOnly : `${day}/${month}/${year} (sin hora)`;
    }
  }
  if (result && result.conversationStatus !== "Pendiente de respuesta" && result.conversationStatus !== "En validación") {
    return "Plazo inactivo";
  }
  const dueAt = result?.activeDeadline?.dueAt;
  if (!dueAt || Number.isNaN(new Date(dueAt).valueOf())) {
    const estimate = result?.estimatedDeadlineDate;
    if (typeof estimate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(estimate)) {
      if (tableDateOnly) return `Estimado: ${estimate} (3 días hábiles)`;
      const [year, month, day] = estimate.split("-");
      return `${day}/${month}/${year} (estimado: 3 días hábiles)`;
    }
    return "Sin plazo indicado";
  }
  if (tableDateOnly) return formatActivityDate(dueAt);
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", day: "numeric", month: "numeric", year: "numeric",
    ...(tableDateOnly ? {} : { hour: "numeric", minute: "2-digit", hourCycle: "h12" }),
  }).format(new Date(dueAt));
}

function deadlineSignal(result, now = Date.now()) {
  const dateOnly = result?.statedDeadlineDate;
  if (result?.deadlineOrderKnown === false && typeof dateOnly === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    const nextDay = Date.parse(`${dateOnly}T00:00:00-05:00`) + 24 * 60 * 60 * 1000;
    return Number.isFinite(nextDay) && now >= nextDay ? "date-past-unconfirmed" : null;
  }
  if (result?.conversationStatus !== "Pendiente de respuesta") return null;
  const dueAt = result.activeDeadline?.dueAt;
  if (!dueAt || !Number.isFinite(Date.parse(dueAt))) return null;
  const remaining = Date.parse(dueAt) - now;
  if (remaining <= 0) return "overdue";
  return remaining <= 24 * 60 * 60 * 1000 ? "near" : null;
}

function parseCommentTimestamp(value) {
  const months = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11 };
  const slash = value?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2})\s*([ap])\.\s*m\.$/i);
  const match = value?.match(/^(\d{1,2})\s+([a-záéíóú]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})$/i);
  if (!slash && !match) return null;
  const month = slash ? Number(slash[2]) - 1 : months[match[2].slice(0, 3).toLowerCase()];
  const day = Number(slash?.[1] ?? match[1]);
  const year = Number(slash?.[3] ?? match[3]);
  const minute = Number(slash?.[5] ?? match[5]);
  let hour = Number(slash?.[4] ?? match[4]);
  if (slash) hour = hour % 12 + (slash[6].toLowerCase() === "p" ? 12 : 0);
  const time = Date.UTC(year, month, day, hour, minute);
  const parsed = new Date(time);
  if (month === undefined || month < 0 || month > 11 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day || hour > 23 || minute > 59 || (slash && (Number(slash[4]) < 1 || Number(slash[4]) > 12))) return null;
  return { time, value: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function latestRequesterReplyTime(result) {
  const comments = Array.isArray(result?.comments) ? result.comments : [];
  const requester = result?.requester?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!requester) return "Fecha no disponible";
  const replies = comments.filter((comment) => comment?.isResponse === false &&
    comment.author?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase() === requester);
  if (!replies.length) return "Sin respuesta registrada";
  const dated = replies.map((comment) => parseCommentTimestamp(comment.date));
  if (dated.some((entry) => !entry)) return "Fecha no disponible";
  return dated.reduce((latest, entry) => entry.time > latest.time ? entry : latest).value;
}

function latestOperationsReplyTime(result) {
  if (!result?.latestOperationsComment) return "Sin respuesta registrada";
  return parseCommentTimestamp(result.latestOperationsComment.date)?.value ?? "Fecha no disponible";
}

function mostRecentReply(result, requesterLabel, operationsLabel) {
  const requesterTime = sortTimestamp(requesterLabel);
  const operationsTime = sortTimestamp(operationsLabel);
  if (!requesterTime && !operationsTime) return { time: 0, label: "Sin respuesta con fecha", author: null };
  return operationsTime >= requesterTime
    ? { time: operationsTime, label: operationsLabel, author: operationsReviewerName(result?.latestOperationsComment) }
    : { time: requesterTime, label: requesterLabel, author: result?.requester ?? null };
}

function normalizeReq(value) {
  return value.trim().toUpperCase();
}

function parseReqList(value) {
  return [...new Set(value.split(/[\s,;]+/).map(normalizeReq).filter(Boolean))];
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
  const dialogs = document.querySelectorAll?.("dialog[open]");
  const activeDialog = dialogs?.length
    ? [...dialogs].find((dialog) => dialog.contains(document.activeElement)) ?? dialogs[dialogs.length - 1]
    : null;
  if (activeDialog) activeDialog.append(elements.toast);
  else document.body?.append(elements.toast);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  if (toastTimeout !== null) window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => elements.toast.classList.remove("visible"), 3500);
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

function errorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message) : String(error);
}

async function api<T = unknown>(url: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<T> {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers };
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body as T;
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
          ? (schedule.reason === "fuera de horario habilitado" ? "Fuera de horario habilitado" : "Monitor disponible")
          : "Fuera de horario";
  document.querySelector("#monitor-label").textContent = label;
  const currentProgress = monitor?.running && progress?.startedAt === monitor.startedAt;
  const runReqs = monitor.selectedReqs ?? reqs;
  const analyzed = currentProgress ? runReqs.filter((req) => progress.items?.[req] === "success").length : 0;
  const activeReq = currentProgress ? runReqs.find((req) => progress.items?.[req] === "running") : null;
  const monitorTime = currentProgress
    ? `Analizadas ${analyzed} de ${runReqs.length}${activeReq ? ` · Ahora: ${activeReq}` : ""}`
    : !busy && schedule && !schedule.allowed
      ? schedule.reason
      : "";
  const lastReview = monitor.finishedAt
    ? `Última revisión del monitor: ${formatActivityDate(monitor.finishedAt)}` : "Aún sin ejecución registrada";
  const timeElement = document.querySelector("#monitor-time");
  const timeLabel = monitorTime ? `${monitorTime} · ${lastReview}` : lastReview;
  if (timeElement.textContent !== timeLabel) timeElement.textContent = timeLabel;
  const scheduledAccess = schedule?.allowed !== false;
  document.querySelector("#status-dot").className = `status-dot ${busy ? "running" : scheduledAccess ? "ready" : "off"}`;
  elements.outsideHours.disabled = busy || state.outsideHoursSaving;
  updateRunSelection();
  elements.queryForm.querySelector("button").disabled = busy || Boolean(state.queryPendingReq);
}

function selectedReqs() {
  const selected = new Set(gridApi?.getSelectedRows?.().map((row) => row.req) ?? []);
  return eligibleDashboardReqs().filter((req) => selected.has(req));
}

function eligibleDashboardReqs() {
  const locked = new Set(state.dashboard?.lockedReqs ?? []);
  return state.dashboard?.reqs.filter((req) => !locked.has(req)) ?? [];
}

function updateRunSelection() {
  const count = selectedReqs().length;
  const total = eligibleDashboardReqs().length;
  const unavailable = Boolean(state.dashboard?.monitor?.activeTask) || state.dashboard?.schedule?.allowed === false || state.runRequestPending;
  elements.selectionCount.textContent = count ? `${count} REQ seleccionadas` :
    state.dashboard?.reqs.length && !total ? "Todas las REQ están bloqueadas" : "Seleccioná REQ en la tabla";
  elements.run.disabled = !count || unavailable;
  elements.runAll.disabled = !gridApi || !total || unavailable;
  const running = state.runRequestPending || state.dashboard?.monitor?.activeTask === "monitor" || state.dashboard?.monitor?.running === true;
  setLoading(elements.run, running);
  setLoading(elements.runAll, running);
}

async function runManualMonitor(reqs) {
  if (!reqs.length) { toast("Seleccioná al menos una REQ"); return; }
  if (state.runRequestPending || state.dashboard?.monitor?.activeTask || state.dashboard?.schedule?.allowed === false) return;
  state.runRequestPending = true;
  updateRunSelection();
  try {
    await api("/api/monitor/run", { method: "POST", body: JSON.stringify({ reqs }) });
    await loadDashboard();
    toast("Monitor iniciado");
  } catch (error) { toast(errorMessage(error)); }
  finally { state.runRequestPending = false; updateRunSelection(); }
}

async function runAllReqs() {
  const total = eligibleDashboardReqs().length;
  if (!gridApi || !total || state.runRequestPending || state.dashboard!.monitor?.activeTask || state.dashboard!.schedule?.allowed === false) return;
  gridApi.selectAll();
  const reqs = selectedReqs();
  if (reqs.length !== total) { toast("No se pudieron seleccionar todas las REQ disponibles"); return; }
  await runManualMonitor(reqs);
}

function portalStatusLabel(result) {
  return result?.status?.trim() ? result.status : "Estado no disponible";
}

function portalStatusTone(result) {
  const status = result?.status?.trim().toLowerCase();
  if (!status) return "unavailable";
  if (result?.conversationStatus === "Finalizada" && result?.closureOutcome === "needs_correction") return "warning";
  if (result?.conversationStatus === "Finalizada" && result?.closureOutcome !== "approved") return "neutral";
  if (/^(pendiente|pending)(\b|$)/.test(status)) return "warning";
  if (/^(rechazad[oa]|rejected|cancelad[oa]|cancelled)(\b|$)/.test(status)) return "danger";
  if (/^(finalizad[oa]|completad[oa]|completed|closed|cerrad[oa])(\b|$)/.test(status)) return "success";
  if (/^(en curso|in progress|asignad[oa]|assigned)(\b|$)/.test(status)) return "info";
  return "neutral";
}

function closureLabel(result) {
  if (result?.conversationStatus !== "Finalizada") return null;
  if (result.closureOutcome === "approved") return "Cierre aprobado";
  if (result.closureOutcome === "needs_correction") return "Cerrada con observaciones";
  return "Cierre sin resultado claro";
}

function closureBadge(result) {
  const label = closureLabel(result);
  if (!label) return "";
  const tone = result.closureOutcome === "approved" ? "success" :
    result.closureOutcome === "needs_correction" ? "warning" : "neutral";
  return `<span class="badge closure-outcome ${tone}">${escapeHtml(label)}</span>`;
}

function updateFilterCount(total, shown) {
  if (elements.filterCount) elements.filterCount.textContent = `Mostrando ${shown} de ${total}`;
}

function sortTimestamp(value) {
  if (!value) return 0;
  const local = parseCommentTimestamp(value);
  if (local) return local.time;
  const portalTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value);
  const iso = portalTime ? Date.parse(`${value.replace(" ", "T")}-05:00`) :
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(iso) ? iso : 0;
}

function compareDateSort(a, b, _first, _second, descending) {
  if (!a || !b) return a === b ? 0 : (a ? -1 : 1) * (descending ? -1 : 1);
  return a - b;
}

const dateSortFields = ["sentAt", "requesterReply", "operationsReply", "checkedAt", "deadline", "activity"];

const triageLabels = { pending: "Pendientes de respuesta", recent: "Respuesta reciente", due: "Plazos en riesgo" };
const filterLabels = {
  search: "Buscar", conversation: "Conversación", portal: "Portal", project: "Proyecto",
  microservice: "Microservicio", req: "REQ", type: "Tipo de REQ", status: "Estado del portal",
  blocked: "REQ bloqueadas",
};
const columnFilterLabels = { req: "REQ / Microservicio", conversationStatus: "Conversación", status: "Portal", deadline: "Plazo", activity: "Última actividad" };
const primaryFilters = {
  search: document.querySelector("#filter-search"),
  conversation: document.querySelector("#filter-conversation"),
  portal: document.querySelector("#filter-portal"),
};
let selectedTriage = "all";

function matchesTriage(data, group, now = Date.now()) {
  if (group === "pending") return data.conversationStatus === "Pendiente de respuesta";
  if (group === "due") return data.deadlineSignal === "near" || data.deadlineSignal === "overdue";
  if (group === "recent") {
    const time = data.activity.time;
    return time > 0 && time <= now && now - time <= 7 * 24 * 60 * 60 * 1000;
  }
  return true;
}

function renderTriage(rows) {
  const now = Date.now();
  for (const button of document.querySelectorAll?.("[data-triage]") ?? []) {
    const group = button.dataset.triage;
    button.querySelector("output").textContent = String(rows.filter((row) => matchesTriage(row, group, now)).length);
  }
  for (const [field, property] of [["conversation", "conversationStatus"], ["portal", "status"]] as const) {
    const input = primaryFilters[field];
    if (!input?.options) continue;
    const selected = input.value;
    const values = [...new Set<string>(rows.map((row) => row[property]))];
    if (selected && !values.includes(selected)) values.push(selected);
    values.sort((a, b) => a.localeCompare(b, "es-CO"));
    const options = values.map((value) => `<option>${escapeHtml(value)}</option>`).join("");
    const markup = `<option value="">${field === "portal" ? "Todo estado del portal" : "Toda conversación"}</option>${options}`;
    if (input.dataset.options !== markup) {
      input.innerHTML = markup;
      input.dataset.options = markup;
      input.value = selected;
    }
  }
}

function renderFilterChips() {
  const container = document.querySelector("#active-filters");
  if (!container?.dataset) return;
  const filters = Object.entries({ ...primaryFilters, ...elements.tableFilters })
    .flatMap(([key, input]: [string, any]) => {
      if (!input?.value || input.value === "all") return [];
      return [[key, filterLabels[key], input.selectedOptions?.[0]?.textContent || input.value]];
    });
  for (const key of Object.keys(gridApi?.getFilterModel?.() ?? {})) {
    if (columnFilterLabels[key]) filters.push([`column:${key}`, columnFilterLabels[key], ""]);
  }
  if (selectedTriage !== "all") filters.unshift(["triage", triageLabels[selectedTriage], ""]);
  const markup = filters.map(([key, label, value]) =>
    `<button type="button" class="filter-chip" data-remove-filter="${key}" aria-label="Quitar filtro: ${escapeHtml(label)}">${escapeHtml(label)}${value ? `: <span>${escapeHtml(value)}</span>` : ""}<b aria-hidden="true">×</b></button>`).join("");
  if (container.dataset.markup !== markup) {
    container.innerHTML = markup;
    container.dataset.markup = markup;
  }
  for (const button of document.querySelectorAll("[data-triage]")) {
    button.setAttribute("aria-pressed", String(button.dataset.triage === selectedTriage));
  }
}

function matchesTableFilters(data) {
  const filters = elements.tableFilters;
  const includes = (field, value) => String(value ?? "").toLocaleLowerCase("es-CO")
    .includes(String(filters[field]?.value ?? "").trim().toLocaleLowerCase("es-CO"));
  const blocked = filters.blocked?.value;
  const search = String(primaryFilters.search?.value ?? "").trim().toLocaleLowerCase("es-CO");
  return (!search || [data.req, data.project, data.microservices].some((value) => String(value ?? "").toLocaleLowerCase("es-CO").includes(search))) &&
    (!primaryFilters.conversation?.value || primaryFilters.conversation.value === data.conversationStatus) &&
    (!primaryFilters.portal?.value || primaryFilters.portal.value === data.status) && matchesTriage(data, selectedTriage) &&
    includes("project", data.project) && includes("microservice", data.microservices) &&
    includes("req", data.req) && includes("type", data.requestType) && includes("status", data.status) &&
    (blocked !== "only" || data.locked) && (blocked !== "hide" || !data.locked);
}

const searchableFilterFields = ["project", "microservice", "req", "type", "status"];
const searchChoices: Record<string, string[]> = {};
const visibleSearchChoices: Record<string, string[]> = {};
let availableFilterRows = [];
let openSearchField: string | null = null;
let activeSearchIndex = -1;

function renderSearchOptions(field, query = "") {
  const list = elements.filterOptions[field];
  if (!list) return;
  const matches = (searchChoices[field] ?? []).filter((value) =>
    value.toLocaleLowerCase("es-CO").includes(query.trim().toLocaleLowerCase("es-CO")));
  visibleSearchChoices[field] = matches;
  list.innerHTML = matches.length ? matches.map((value, index) =>
    `<div id="filter-${field}-option-${index}" role="option" data-index="${index}" aria-selected="${value === elements.tableFilters[field]?.value}">${escapeHtml(value)}</div>`).join("") :
    '<div class="search-filter-empty">Sin coincidencias</div>';
}

function closeSearchOptions() {
  if (!openSearchField) return;
  const input = elements.tableFilters[openSearchField];
  elements.filterOptions[openSearchField].hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  openSearchField = null;
  activeSearchIndex = -1;
}

function showSearchOptions(field) {
  if (openSearchField && openSearchField !== field) closeSearchOptions();
  const input = elements.tableFilters[field];
  renderSearchOptions(field, input.value);
  elements.filterOptions[field].hidden = false;
  input.setAttribute("aria-expanded", "true");
  openSearchField = field;
  activeSearchIndex = -1;
}

function updateFilterOptions(rows) {
  availableFilterRows = rows;
  const projectQuery = (elements.tableFilters.project?.value ?? "").trim().toLocaleLowerCase("es-CO");
  const projectRows = projectQuery ? rows.filter((row) =>
    row.project.toLocaleLowerCase("es-CO").includes(projectQuery)) : rows;
  const values: Record<string, string[]> = {
    project: rows.map((row) => row.project.replace(/ \(inferido\)$/, "")),
    microservice: projectRows.flatMap((row) => Array.isArray(row.result?.microservices)
      ? row.result.microservices.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()) : []),
    req: projectRows.map((row) => row.req),
    type: projectRows.map((row) => row.requestType),
    status: rows.map((row) => row.status),
  };
  for (const [field, options] of Object.entries(values)) {
    searchChoices[field] = [...new Set(options.filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "es-CO", { numeric: true }));
    renderSearchOptions(field, openSearchField === field ? elements.tableFilters[field].value : "");
  }
  if (openSearchField) {
    activeSearchIndex = -1;
    elements.tableFilters[openSearchField].removeAttribute("aria-activedescendant");
  }
}

const narrowGrid = globalThis.matchMedia?.("(max-width: 960px)");
const secondaryGridColumns = ["conversationStatus", "status", "deadline", "activity"];
const gridOptions = {
  styleNonce: document.querySelector('meta[name="ag-grid-style-nonce"]')?.getAttribute?.("content"),
  theme: typeof agGrid !== "undefined" ? agGrid.themeQuartz.withParams({
    accentColor: "var(--accent)", backgroundColor: "var(--surface)", foregroundColor: "var(--text)",
    headerBackgroundColor: "var(--surface-raised)", headerTextColor: "var(--muted)", borderColor: "var(--line)",
    rowHoverColor: "var(--hover)", selectedRowBackgroundColor: "var(--selected)",
    fontFamily: "inherit", fontSize: 14, spacing: 6,
  }) : undefined,
  postSortRows: ({ nodes }) => {
    let priorityCount = 0;
    for (let index = 0; index < nodes.length; index++) {
      if (nodes[index].data?.operationsComment && !nodes[index].data.locked) {
        nodes.splice(priorityCount, 0, nodes.splice(index, 1)[0]);
        priorityCount++;
      }
    }
  },
  columnDefs: [
    { headerName: "REQ / Microservicio", field: "req", minWidth: 118, flex: 2, autoHeight: true,
      filterValueGetter: ({ data }) => data ? [data.req, data.project, data.microservices, data.detail].join(" ") : "",
      cellRenderer: ({ data }) => {
        if (!data) return "";
        const metadata = [data.project, data.requestType].filter(Boolean).join(" · ");
        const services = escapeHtml(data.microservices);
        const serviceLabel = data.microservices.includes(",") ? "Copiar microservicios" : "Copiar microservicio";
        const service = services
          ? `<button class="req-service service-copy" data-copy="${services}" type="button" aria-label="${serviceLabel}: ${services}" title="${serviceLabel}: ${services}"><span>${services}</span>${actionIcon("copy")}</button>`
          : `<span class="req-service" title="${escapeHtml(data.detail)}">${escapeHtml(data.detail)}</span>`;
        return `<div class="req-identity"><div class="req-id-line"><button class="req-number req-copy" data-copy="${escapeHtml(data.req)}" type="button" aria-label="Copiar ${escapeHtml(data.req)}" title="Copiar número de REQ">${escapeHtml(data.req)}</button>${data.locked ? `<span class="locked-mark" role="img" aria-label="Bloqueada" title="Bloqueada">${actionIcon("lock")}</span>` : ""}</div>${service}<span class="req-title" title="${escapeHtml(metadata)}">${escapeHtml(metadata)}</span>
        ${data.missingTags.length ? `<div class="req-missing-tags">${data.missingTags.map((label) => `<span class="missing-tag">${escapeHtml(label)}</span>`).join("")}</div>` : ""}
        ${narrowGrid?.matches ? `<div class="compact-row-meta">${conversationCell(data)}${portalCell(data)}${deadlineCell(data)}${activityCell(data)}</div>` : ""}</div>`;
      } },
    { headerName: "Conversación", field: "conversationStatus", hide: narrowGrid?.matches, minWidth: 168, flex: 1.2,
      cellRenderer: ({ data }) => data ? conversationCell(data) : "" },
    { headerName: "Portal", field: "status", hide: narrowGrid?.matches, minWidth: 146, flex: 1,
      cellRenderer: ({ data }) => data ? portalCell(data) : "" },
    { headerName: "Plazo", colId: "deadline", hide: narrowGrid?.matches, minWidth: 160, flex: 1,
      valueGetter: ({ data }) => data?.dateSort.deadline ?? 0, comparator: compareDateSort,
      filterValueGetter: ({ data }) => data ? [data.deadline, deadlineAlert(data)].join(" ") : "",
      cellRenderer: ({ data }) => data ? deadlineCell(data) : "" },
    { headerName: "Última actividad", colId: "activity", hide: narrowGrid?.matches, minWidth: 164, flex: 1,
      valueGetter: ({ data }) => data?.activity.time ?? 0, comparator: compareDateSort,
      filterValueGetter: ({ data }) => data ? [data.activity.label, data.activity.author, data.requesterReplyTime, data.operationsReplyTime].join(" ") : "",
      cellRenderer: ({ data }) => data ? activityCell(data) : "" },
    ...dateSortFields.filter((field) => field !== "deadline" && field !== "activity").map((field) => ({ colId: field, hide: true, filter: false,
      sort: field === "sentAt" ? "desc" : undefined,
      valueGetter: ({ data }) => data?.dateSort?.[field] ?? 0, comparator: compareDateSort })),
    { headerName: "Acciones", colId: "actions", width: 98, minWidth: 98, sortable: false, filter: false, resizable: false,
      cellRenderer: ({ data }) => {
        if (!data) return "";
        const req = escapeHtml(data.req);
        const menuId = `actions-${req}`;
        const url = data.result?.detailUrl ? safeUrl(data.result.detailUrl) : "#";
        const portal = url === "#"
          ? `<button class="menu-item" type="button" aria-label="Enlace de MiAsistencia360 no disponible" disabled>${actionIcon("portal")} Portal no disponible</button>`
          : `<a class="menu-item" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="Abrir ${req} en MiAsistencia360">${actionIcon("portal")} Abrir en el portal</a>`;
        return `<div class="row-actions">
          <button class="icon-action" data-details="${req}" type="button" aria-label="Ver detalles de ${req}" title="Ver detalles">${actionIcon("details")}</button>
          <button class="icon-action" type="button" aria-label="Más acciones para ${req}" title="Más acciones" popovertarget="${menuId}">${actionIcon("more")}</button>
          <div class="row-menu" id="${menuId}" popover aria-label="Acciones para ${req}">
            <button class="menu-item" data-query="${req}" type="button" aria-label="Consultar ${req}" aria-busy="${state.queryPendingReq === data.req}" ${state.queryPendingReq === data.req ? "disabled" : ""}>${actionIcon("query")} Consultar ahora</button>
            ${portal}
            <button class="menu-item" data-lock="${req}" data-locked="${data.locked}" type="button" aria-label="${data.locked ? "Desbloquear" : "Bloquear"} ${req}" ${data.lockActionDisabled ? "disabled" : ""}>${actionIcon(data.locked ? "lock" : "unlock")} ${data.locked ? "Desbloquear" : "Bloquear"}</button>
            <button class="menu-item menu-danger" data-delete="${req}" type="button" aria-label="Borrar ${req}">${actionIcon("delete")} Eliminar del monitoreo</button>
          </div>
        </div>`;
      } },
  ],
  defaultColDef: { sortable: true, filter: true, resizable: true, suppressKeyboardEvent: ({ event }) =>
    event.target instanceof HTMLElement && Boolean(event.target.closest("button, a, [popover]")) },
  onCellKeyDown: ({ event }) => {
    if (event.key !== "Enter" || !event.target.matches(".ag-cell")) return;
    const control = event.target.querySelector("button:not(:disabled), a[href]");
    if (control) {
      event.preventDefault();
      control.focus();
    }
  },
  isExternalFilterPresent: () => selectedTriage !== "all" || Object.values({ ...primaryFilters, ...elements.tableFilters }).some((input: any) =>
    input?.value && input.value !== "all"),
  doesExternalFilterPass: ({ data }) => Boolean(data && matchesTableFilters(data)),
  rowSelection: { mode: "multiRow", checkboxes: ({ node }) => !node.data?.locked,
    isRowSelectable: (node) => Boolean(node.data && !node.data.locked), headerCheckbox: true,
    selectAll: "all", enableClickSelection: false },
  selectionColumnDef: { width: 42, pinned: "left", headerTooltip: "Seleccionar REQ para ejecución manual" },
  onSelectionChanged: () => updateRunSelection(),
  rowClassRules: {
    "req-active": ({ data }) => data?.active === true,
    "req-due-soon": ({ data }) => data?.deadlineSignal === "near",
    "req-overdue": ({ data }) => data?.deadlineSignal === "overdue",
  },
  getRowId: ({ data }) => data.req,
  pagination: true,
  paginationPageSize: 10,
  paginationPageSizeSelector: [10, 25, 50],
  animateRows: false,
  domLayout: "autoHeight",
  rowHeight: 61,
  localeText: { noRowsToShow: "No hay REQ para mostrar", page: "Página", of: "de", to: "a", filterOoo: "Filtrar...", contains: "Contiene", equals: "Igual a" },
  onModelUpdated: () => updateGridCount(),
};

function conversationCell(data) {
  const label = data.operationsOrderUnknown ? "Orden de mensajes sin confirmar" :
    data.operationsComment && data.conversationStatus === "Respondida" ? "Ya respondiste" :
    data.operationsComment && data.conversationStatus === "Pendiente de respuesta" ? "Te toca responder" :
    data.conversationStatus;
  return `<div class="status-stack">
        <span class="conversation-status ${statusClass(data.conversationStatus)}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      </div>`;
}

function portalCell(data) {
  return `<div class="status-stack"><span class="badge portal-status ${portalStatusTone(data.result)}" title="${escapeHtml(data.status)}">${escapeHtml(data.status)}</span>${closureBadge(data.result)}</div>`;
}

function deadlineAlert(data) {
  return data.deadlineSignal === "near" ? "Vence en menos de 24 horas" :
    data.deadlineSignal === "overdue" ? "Plazo vencido" :
    data.deadlineSignal === "date-past-unconfirmed" ? "Fecha indicada ya pasó · vigencia sin confirmar" : "";
}

function deadlineCell(data) {
  const alert = deadlineAlert(data);
  return `<div class="cell-stack"><span class="req-review-date" title="${escapeHtml(data.deadline)}">${escapeHtml(data.deadline)}</span>
    ${alert ? `<span class="deadline-note ${escapeHtml(data.deadlineSignal)}" title="${escapeHtml(alert)}">${data.deadlineSignal === "near" ? actionIcon("clock") : ""}${escapeHtml(alert)}</span>` : ""}</div>`;
}

function activityCell(data) {
  const { label, author } = data.activity;
  return `<div class="cell-stack"><span class="activity-date" title="${escapeHtml(label)}">${escapeHtml(label)}${data.progressLabel
    ? `<span class="review-indicator ${data.progressClass}" role="img" aria-label="Monitoreo: ${escapeHtml(data.progressLabel)}" title="Monitoreo: ${escapeHtml(data.progressLabel)}"></span>` : ""}</span>
    ${author ? `<span class="activity-author" title="${escapeHtml(author)}">${escapeHtml(author)}</span>` : ""}</div>`;
}

gridApi = typeof agGrid !== "undefined" && agGrid.createGrid
  ? agGrid.createGrid(elements.list, gridOptions) : null;

function updateGridCount() {
  if (!gridApi || !state.dashboard) return;
  let shown = 0;
  gridApi.forEachNodeAfterFilter((node) => {
    if (node.data) shown++;
  });
  updateFilterCount(state.dashboard.reqs.length, shown);
  renderFilterChips();
  elements.empty.hidden = state.dashboard.reqs.length > 0 && shown > 0;
  elements.empty.textContent = state.dashboard.reqs.length ? "Sin coincidencias para los filtros aplicados." : "No hay REQ configuradas.";
}

function clearTableFilters() {
  if (!gridApi) return;
  closeSearchOptions();
  selectedTriage = "all";
  for (const input of Object.values(primaryFilters)) if (typeof input?.value === "string") input.value = "";
  for (const [field, input] of Object.entries(elements.tableFilters)) {
    if (input) (input as HTMLInputElement).value = field === "blocked" ? "hide" : "";
  }
  gridApi.setFilterModel(null);
  gridApi.setGridOption("quickFilterText", "");
  updateFilterOptions(availableFilterRows);
  gridApi.onFilterChanged();
}

function inferredProject(result: StoredResult | null, configuredReqs: string[], byReq: Map<string, StoredResult>): string | null {
  if (!result || result.projectName?.trim() || !Array.isArray(result.microservices)) return null;
  const names = new Set(result.microservices.filter((name) => typeof name === "string")
    .map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (!names.size) return null;
  let project: string | null = null;
  for (const req of configuredReqs) {
    if (req === result.req) continue;
    const donor = byReq.get(req);
    if (donor?.error || !donor?.projectName?.trim() || !Array.isArray(donor.microservices) ||
      !donor.microservices.some((name) => typeof name === "string" && names.has(name.trim().toLowerCase()))) continue;
    const candidate = donor.projectName.trim();
    if (project && project.toLowerCase() !== candidate.toLowerCase()) return null;
    project = candidate;
  }
  return project;
}

function renderRows(reqs: string[], results: StoredResult[], progress: DashboardPayload["progress"] = null, monitor: DashboardPayload["monitor"] | null = null) {
  const byReq = new Map<string, StoredResult>(results.map((result) => [result.req, result]));
  state.resultsByReq = byReq;
  const currentProgress = monitor?.running && progress?.startedAt === monitor.startedAt;
  const runReqs = monitor?.selectedReqs ?? reqs;
  const activeReq = currentProgress ? runReqs.find((req) => progress!.items?.[req] === "running") : null;
  const analyzed = currentProgress ? runReqs.filter((req) => progress!.items?.[req] === "success").length : 0;
  elements.liveProgress.hidden = !currentProgress;
  const liveMessage = currentProgress
    ? `${activeReq ? `Monitoreando ahora: ${activeReq}` : "Preparando siguiente REQ"} · ${analyzed} de ${runReqs.length} revisadas`
    : "";
  if (elements.liveProgress.textContent !== liveMessage) elements.liveProgress.textContent = liveMessage;
  if (!gridApi) {
    elements.empty.hidden = false;
    elements.empty.textContent = "Tabla no disponible. Actualizá la página para volver a cargar AG Grid.";
    updateFilterCount(reqs.length, 0);
    return;
  }
  const rowData = [...reqs].reverse().map((req) => {
    const result = byReq.get(req) || null;
    const comments = result?.comments ?? [];
    const selectedTags = Array.isArray(state.missingTags[req]) ? state.missingTags[req] : [];
    const inferred = inferredProject(result, reqs, byReq);
    const inRun = progress?.startedAt && progress.startedAt === monitor?.startedAt;
    const inScope = !monitor?.selectedReqs || monitor.selectedReqs.includes(req);
    const checked = inRun && inScope ? progress.items?.[req] : null;
    const requesterReplyTime = latestRequesterReplyTime(result);
    const operationsReplyTime = latestOperationsReplyTime(result);
    const requesterTime = sortTimestamp(requesterReplyTime);
    const operationsTime = sortTimestamp(operationsReplyTime);
    const activity = mostRecentReply(result, requesterReplyTime, operationsReplyTime);
    return {
      req, result,
      missingTags: MISSING_TAG_OPTIONS.filter((option) => selectedTags.includes(option.id)).map((option) => option.label),
      locked: Boolean(state.dashboard?.lockedReqs?.includes(req)),
      lockActionDisabled: Boolean(state.dashboard?.monitor?.activeTask),
      project: result?.projectName?.trim() || (inferred ? `${inferred} (inferido)` : "Proyecto no disponible"),
      microservices: Array.isArray(result?.microservices)
        ? result.microservices.filter(Boolean).join(", ").replace(/,\s*/g, ", ") : "",
      status: portalStatusLabel(result), conversationStatus: result?.conversationStatus || "Sin datos de conversación",
      operationsComment: Boolean(result?.latestOperationsComment),
      operationsOrderUnknown: Boolean(result?.latestOperationsComment && comments.length > 1 &&
        comments.some((comment) => !comment.date)),
       deadline: statedDeadline(result, true), deadlineSignal: deadlineSignal(result), requesterReplyTime,
       operationsReplyTime, activity,
       sentAt: result?.sentAt || "Fecha no disponible",
       requestType: result?.requestDetails?.requestType || "Tipo no disponible",
       dateSort: {
         sentAt: sortTimestamp(result?.sentAt), requesterReply: requesterTime,
         operationsReply: operationsTime,
         checkedAt: sortTimestamp(result?.checkedAt),
         deadline: statedDeadline(result, true) === "Plazo inactivo" ? 0 :
            sortTimestamp(result?.activeDeadline?.dueAt || result?.statedDeadlineDate || result?.estimatedDeadlineDate),
       },
      detail: webError(result?.error) || result?.title || "Información no disponible",
      checkedAt: result?.checkedAt || null,
      active: Boolean(monitor?.running && checked === "running"),
      progressLabel: checked === "running" ? "En revisión" :
        checked === "success" ? "Revisada" : checked === "error" ? "Error de revisión" : "",
      progressClass: checked === "running" ? "running" : checked === "success" ? "success" :
        checked === "error" ? "error" : "waiting",
    };
  });
  renderTriage(rowData);
  updateFilterOptions(rowData);
  gridApi.setGridOption("rowData", rowData);
  gridApi.refreshCells({ force: true, columns: ["req", "conversationStatus", "status", "deadline", "activity", "actions"] });
  updateRunSelection();
  updateGridCount();
}

function available(value) {
  return value == null || String(value).trim() === "" ? "No disponible" : String(value);
}

function formatOperationsMessage(value) {
  let text = String(value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("“") && text.endsWith("”")) ||
      (text.startsWith("«") && text.endsWith("»"))) text = text.slice(1, -1).trim();
  return text.replace(/\r\n?/g, "\n").replace(/([^\n])\n(?=[^\n])/g, "$1\n\n");
}

function renderMessageLinks(text: string) {
  return text.split(/(https?:\/\/[^\s<>"']+)/g).map((part, index) => {
    if (!(index % 2)) return escapeHtml(part);
    const link = part.replace(/[.,;!?)]+$/, "");
    const url = safeUrl(link);
    return url === "#" ? escapeHtml(part) : `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a>${escapeHtml(part.slice(link.length))}`;
  }).join("");
}

function renderDetailsAttachment(attachment) {
  const name = available(attachment?.name);
  const size = attachment?.size || "Tamaño no disponible";
  const file = `<span class="file-type" aria-hidden="true">${escapeHtml(fileType(name))}</span><span class="file-details"><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><small>${escapeHtml(size)}</small></span>`;
  return typeof attachment?.url === "string" && /^https?:\/\//i.test(attachment.url) && safeUrl(attachment.url) !== "#"
    ? `<button class="attachment-card" type="button" data-download-url="${escapeHtml(attachment.url)}" data-download-name="${escapeHtml(name)}">${file}<span class="file-action">Descargar</span></button>`
    : `<div class="attachment-card">${file}</div>`;
}

function renderStoredConversation(result) {
  const comments = Array.isArray(result?.comments)
    ? result.comments.filter((comment) => comment && typeof comment === "object") : null;
  return `<section class="details-section details-conversation">
    <h3>Historial de la conversación</h3>
    ${comments === null ? `<p class="conversation-empty">Historial no disponible en los datos guardados.</p>`
      : comments.length === 0 ? `<p class="conversation-empty">No hay comentarios guardados para esta REQ.</p>`
      : `<ul class="conversation-list">${comments.map((comment) => {
        const attachments = Array.isArray(comment.attachments) ? comment.attachments : [];
        return `<li class="conversation-entry ${comment.isResponse === true ? "from-operations" : "from-requester"}">
          <div class="conversation-entry-header">
            <div><span class="conversation-role">${comment.isResponse === true ? "Operaciones" : "Solicitante"}</span>
            <strong>${escapeHtml(available(comment.isResponse === true ? operationsReviewerName(comment) : comment.author))}</strong></div>
            <time>${escapeHtml(comment.date || "Fecha no disponible")}</time>
          </div>
          <p${comment.isResponse === true ? ' class="operations-message"' : ""}>${renderMessageLinks(comment.isResponse === true
            ? formatOperationsMessage(available(comment.text)) : available(comment.text))}</p>
          ${attachments.length ? `<div class="conversation-files"><span>Adjuntos</span><ul>
            ${attachments.map((attachment) => `<li>${renderDetailsAttachment(attachment)}</li>`).join("")}
          </ul></div>` : ""}
        </li>`;
      }).join("")}</ul>`}
  </section>`;
}

function renderStoredDetails(result) {
  const inferred = inferredProject(result, state.dashboard?.reqs ?? [], state.resultsByReq);
  const statusFields = [
    ["Estado del portal", result?.status],
    ["Estado de conversación (calculado)", result?.conversationStatus],
    ...(closureLabel(result) ? [["Resultado del cierre (calculado)", closureLabel(result)]] : []),
  ];
  const requestFields = [
    [inferred ? "Proyecto (inferido de otras REQ)" : "Proyecto", result?.projectName?.trim() || inferred],
    ["Microservicios detectados", result?.microservices?.length ? result.microservices.join(", ") : null],
    ["Tipo de operación", result?.requestDetails?.operationType],
    ["Aplicación", result?.requestDetails?.application],
    ["Tipo de solicitud", result?.requestDetails?.requestType],
    ["Tipo de cliente", result?.requestDetails?.clientType],
  ];
  const requesterFields = [
    ["Solicitante", result?.requester],
    ["ID de usuario", result?.requesterUserId],
    ["Correo electrónico", result?.requesterEmail],
    ["Teléfono", result?.requesterPhone],
  ];
  const trackingFields = [
    ["Enviado", result?.sentAt],
    ["Última actualización", result?.updatedAt],
    ["Última revisión", result?.checkedAt ? formatDate(result.checkedAt) : null],
    ["Última respuesta del usuario", latestRequesterReplyTime(result)],
    ["Última respuesta de Operaciones", latestOperationsReplyTime(result)],
    [result?.estimatedDeadlineDate ? "Plazo estimado" : "Plazo indicado", statedDeadline(result)],
    ...(typeof result?.error === "string" && result.error.trim()
      ? [["Error de consulta", webError(result.error)]] : []),
  ];
  const detailsSection = (heading, fields) => `<details class="details-section details-disclosure">
    <summary>${heading}</summary>
    <dl class="result-grid">${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(available(value))}</dd></div>`).join("")}</dl>
  </details>`;
  const service = result?.microservices?.filter(Boolean).join(", ") || result?.title;
  const project = result?.projectName?.trim() || inferred;
  const summaryBits = [project, result?.requestDetails?.requestType].filter(Boolean);
  const activity = mostRecentReply(result, latestRequesterReplyTime(result), latestOperationsReplyTime(result));
  const signal = deadlineSignal(result);
  const alert = deadlineAlert({ deadlineSignal: signal });
  const attachments = [...new Map<string, StoredAttachment>(
    [...(result.attachments ?? []), ...(result.comments ?? []).flatMap((comment) => comment?.attachments ?? [])]
      .filter((file) => file?.url || file?.name).map((file) => [file.url || file.name, file]),
  ).values()];
  return `<div class="stored-details" aria-label="Detalles de la REQ">
    <div class="details-intro">
      <button type="button" class="req-number req-copy" data-copy="${escapeHtml(result.req)}" title="Copiar número de REQ">${escapeHtml(result.req)}</button>
      <h3>${escapeHtml(available(service))}</h3>
      ${summaryBits.length ? `<p>${escapeHtml(summaryBits.join(" · "))}</p>` : ""}
      <div class="details-badges"><span class="badge ${statusClass(result?.conversationStatus)}">${escapeHtml(available(result?.conversationStatus))}</span><span class="badge portal-status ${portalStatusTone(result)}">Portal: ${escapeHtml(portalStatusLabel(result))}</span>${closureBadge(result)}</div>
      <dl class="detail-highlights">
        <div><dt>Plazo</dt><dd>${escapeHtml(statedDeadline(result))}</dd>${alert ? `<span class="deadline-note ${signal}">${escapeHtml(alert)}</span>` : ""}</div>
        <div><dt>Última actividad</dt><dd>${escapeHtml(activity.label)}</dd>${activity.author ? `<span class="activity-author">${escapeHtml(activity.author)}</span>` : ""}</div>
      </dl>
    </div>
    <section class="details-section details-missing-tags">
      <h3>Faltantes</h3>
      <p>Marcá únicamente los faltantes confirmados para esta REQ.</p>
      <form class="missing-tags-form">
        <div class="missing-tag-options">${MISSING_TAG_OPTIONS.map((option) => `<label class="missing-tag-option">
          <input type="checkbox" name="missingTag" value="${option.id}" ${state.missingTags[result.req]?.includes(option.id) ? "checked" : ""}>
          <span>${escapeHtml(option.label)}</span>
        </label>`).join("")}</div>
        <button class="secondary" type="submit">Guardar faltantes</button>
      </form>
    </section>
    <details class="details-section details-disclosure">
      <summary>Archivos adjuntos (${attachments.length})</summary>
      ${attachments.length ? `<div class="attachment-grid compact">${attachments.map(renderDetailsAttachment).join("")}</div>` :
        '<p class="conversation-empty">No hay archivos adjuntos en los datos guardados.</p>'}
    </details>
    ${detailsSection("Seguimiento y plazos", [...statusFields, ...trackingFields])}
    ${detailsSection("Datos de la solicitud", [["Título", result?.title], ...requestFields])}
    ${detailsSection("Solicitante", requesterFields)}
    ${renderStoredConversation(result)}
    <details class="details-section details-narrative details-disclosure">
      <summary>Descripción e instrucciones</summary>
      <div class="detail-text"><h4>Descripción detallada de la solicitud</h4><p>${escapeHtml(available(result?.description))}</p></div>
      <div class="detail-text"><h4>Instrucciones</h4><p>${escapeHtml(available(result?.instructions))}</p></div>
    </details>
  </div>`;
}

function toggleDetails(button) {
  const req = button.dataset.details;
  const result = state.resultsByReq.get(req);
  if (!result) return;
  elements.detailsDialog.dataset.req = req;
  elements.detailsContent.innerHTML = renderStoredDetails(result);
  elements.detailsDialog.showModal();
}

function renderDashboard(data: DashboardPayload) {
  state.dashboard = data;
  state.missingTags = data.missingTags ?? {};
  renderAuthStatus(data.auth);
  updateMonitor(data.monitor, data.schedule, data.progress, data.reqs);
  const outsideHoursEnabled = data.settings?.allowOutsideHoursRuns === true;
  elements.outsideHours.setAttribute("aria-pressed", String(outsideHoursEnabled));
  elements.outsideHours.textContent = outsideHoursEnabled ? "Restringir a horario laboral" : "Habilitar fuera de horario";
  if (elements.intervalInput && document.activeElement !== elements.intervalInput) {
    elements.intervalInput.value = String(data.settings?.intervalMinutes ?? data.schedule?.intervalMinutes ?? 15);
  }
  renderRows(data.reqs, data.results, data.progress, data.monitor);
  updateProgressPolling(Boolean(data.monitor?.running));
  const monitor = data.monitor;
  if (monitor?.startedAt && !monitor.running && monitor.exitCode !== null &&
    data.progress?.startedAt === monitor.startedAt && state.alertedMonitorRun !== monitor.startedAt) {
    state.alertedMonitorRun = monitor.startedAt;
    const runReqs = monitor.selectedReqs ?? data.reqs;
    const total = runReqs.length;
    const notReviewed = runReqs.filter((req) => data.progress!.items?.[req] !== "success").length;
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
    const data = await api<DashboardPayload>("/api/dashboard");
    if (request === dashboardRequestSequence) renderDashboard(data);
  } catch (error) {
    if (!silent && request === dashboardRequestSequence) toast(errorMessage(error));
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
    <div class="lookup-result-heading"><span class="req-number">${escapeHtml(result.req)}</span>
    <h3>${escapeHtml(result.microservices?.filter(Boolean).join(", ") || result.title || "Resultado de consulta")}</h3></div>
    ${result.error ? `<p>${escapeHtml(webError(result.error))}</p>` : `
      <dl class="result-grid">
        <div><dt>Estado de conversación (calculado)</dt><dd><span class="badge ${statusClass(result.conversationStatus)}">${escapeHtml(available(result.conversationStatus))}</span></dd></div>
        <div><dt>Estado del portal</dt><dd>${escapeHtml(result.status?.trim() ? result.status : "Estado no disponible")}</dd></div>
        ${closureLabel(result) ? `<div><dt>Resultado del cierre (calculado)</dt><dd>${closureBadge(result)}</dd></div>` : ""}
        <div><dt>Consultada</dt><dd>${escapeHtml(formatDate(result.checkedAt))}</dd></div>
        <div><dt>Título</dt><dd>${escapeHtml(result.title || "Sin título")}</dd></div>
        <div><dt>Proyecto</dt><dd>${escapeHtml(result.projectName?.trim() ? result.projectName : "Proyecto no disponible")}</dd></div>
        <div><dt>Microservicios</dt><dd>${escapeHtml((result.microservices || []).join(", ") || "No disponibles")}</dd></div>
        <div><dt>Operaciones</dt><dd>${escapeHtml(operationsReviewerName(comment) || "Sin comentario")}</dd></div>
      </dl>
      ${comment?.text ? `<section class="result-comment" aria-label="Último comentario de Operaciones">
        <h3>Último comentario de Operaciones</h3>
         <p>${escapeHtml(formatOperationsMessage(comment.text))}</p>
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
  elements.queryResult.scrollIntoView({ block: "nearest" });
}

async function downloadAttachment(url, name, button) {
  button.disabled = true;
  setLoading(button, true);
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
    if (!handleAccessError(errorMessage(error))) toast(errorMessage(error));
  } finally {
    button.disabled = false;
    setLoading(button, false);
    if (action) action.textContent = originalText;
  }
}

async function queryReq(req, rowButton: any = null) {
  if (state.queryPendingReq || state.dashboard?.monitor?.activeTask) return;
  state.queryPendingReq = req;
  const button = elements.queryForm.querySelector("button");
  button.disabled = true;
  setLoading(button, true);
  if (rowButton) {
    rowButton.disabled = true;
    setLoading(rowButton, true);
  }
  button.textContent = "Consultando...";
  try {
    const data = await api<{ results: StoredResult[] }>("/api/reqs/query", { method: "POST", body: JSON.stringify({ req }) });
    if (!handleAccessError(data.results[0]?.error)) {
      renderQueryResult(data.results[0]);
      elements.queryResult.scrollIntoView?.({ block: "nearest" });
      toast(data.results[0]?.error ? "No se pudo consultar la REQ" : "Consulta completada");
    }
  } catch (error) {
    if (!handleAccessError(errorMessage(error))) toast(errorMessage(error));
  } finally {
    state.queryPendingReq = null;
    button.disabled = Boolean(state.dashboard?.monitor?.activeTask);
    setLoading(button, false);
    if (rowButton) {
      rowButton.disabled = false;
      setLoading(rowButton, false);
    }
    gridApi?.refreshCells?.({ force: true, columns: ["actions"] });
    button.textContent = "Consultar REQ";
    await loadDashboard(true);
  }
}

elements.credentialsButton.addEventListener("click", () => {
  openCredentialsDialog();
});

const copyStatus = document.querySelector("#create-req-copy-status");
const messagePreview = document.querySelector(".creation-message");
const messageEditor = document.querySelector("#creation-message-editor");
const messageInput = document.querySelector("#creation-message-input");
const messageActions = document.querySelector("#creation-message-actions");
const defaultMessage = messagePreview.textContent.trim();
const messageStorageKey = "req-monitor:static-analysis-message:v1";

function closeMessageEditor() {
  messageEditor.hidden = true;
  messagePreview.hidden = false;
  messageActions.hidden = false;
}

elements.createReqButton.addEventListener("click", () => {
  try {
    const saved = localStorage.getItem(messageStorageKey);
    messagePreview.textContent = saved?.trim() ? saved : defaultMessage;
  } catch { messagePreview.textContent = defaultMessage; }
  elements.createReqDialog.showModal();
});
document.querySelector("#create-req-close").addEventListener("click", () => elements.createReqDialog.close());
document.querySelector("#create-req-edit").addEventListener("click", () => {
  messageInput.value = messagePreview.textContent.trim();
  messagePreview.hidden = true;
  messageActions.hidden = true;
  messageEditor.hidden = false;
  copyStatus.textContent = "";
  delete copyStatus.dataset.state;
  messageInput.setSelectionRange(0, 0);
  messageInput.focus({ preventScroll: true });
});
document.querySelector("#create-req-cancel-edit").addEventListener("click", () => {
  closeMessageEditor();
  copyStatus.textContent = "";
  document.querySelector("#create-req-edit").focus();
});
document.querySelector("#create-req-save").addEventListener("click", () => {
  const message = messageInput.value.trim();
  if (!message) {
    copyStatus.dataset.state = "error";
    copyStatus.textContent = "Ingresa un mensaje antes de guardar";
    return;
  }
  try {
    localStorage.setItem(messageStorageKey, message);
    messagePreview.textContent = message;
    closeMessageEditor();
    copyStatus.dataset.state = "success";
    copyStatus.textContent = "Plantilla guardada";
    document.querySelector("#create-req-edit").focus();
  } catch {
    copyStatus.dataset.state = "error";
    copyStatus.textContent = "No se pudo guardar la plantilla";
  }
});
document.querySelector("#create-req-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(messagePreview.textContent.trim());
    copyStatus.dataset.state = "success";
    copyStatus.textContent = "Mensaje copiado";
  } catch {
    copyStatus.dataset.state = "error";
    copyStatus.textContent = "No se pudo copiar el mensaje";
  }
});
document.querySelector("#static-analysis-choice").addEventListener("click", () => {
  elements.createReqChoices.hidden = true;
  elements.staticAnalysisGuide.hidden = false;
  document.querySelector("#create-req-back").focus();
});
document.querySelector("#create-req-back").addEventListener("click", () => {
  copyStatus.textContent = "";
  delete copyStatus.dataset.state;
  closeMessageEditor();
  elements.staticAnalysisGuide.hidden = true;
  elements.createReqChoices.hidden = false;
  document.querySelector("#static-analysis-choice").focus();
});
elements.createReqDialog.addEventListener("close", () => {
  copyStatus.textContent = "";
  delete copyStatus.dataset.state;
  closeMessageEditor();
  elements.staticAnalysisGuide.hidden = true;
  elements.createReqChoices.hidden = false;
  elements.createReqButton.focus();
});

document.querySelector("#req-details-close").addEventListener("click", () => elements.detailsDialog.close());

elements.detailsDialog.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.matches(".missing-tags-form")) return;
  event.preventDefault();
  const req = elements.detailsDialog.dataset.req;
  if (!req) return;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  const tags = [...form.querySelectorAll('input[name="missingTag"]:checked')].map((input) => input.value);
  button.disabled = true;
  setLoading(button, true);
  try {
    await api(`/api/reqs/${encodeURIComponent(req)}/missing-tags`, {
      method: "PUT", body: JSON.stringify({ tags }),
    });
    elements.detailsDialog.close();
    await loadDashboard();
    toast("Faltantes guardados");
  } catch (error) { toast(errorMessage(error)); }
  finally { button.disabled = false; setLoading(button, false); }
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
  setLoading(submit, true);
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
    toast(errorMessage(error));
  } finally {
    password.value = "";
    submit.disabled = false;
    setLoading(submit, false);
    submit.textContent = "Renovar acceso";
  }
});

elements.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#add-req");
  const reqs = parseReqList(input.value);
  if (!reqs.length) { toast("Ingresa al menos una REQ"); return; }
  const button = elements.addForm.querySelector('button[type="submit"]');
  if (button?.disabled) return;
  button.disabled = true;
  setLoading(button, true);
  try {
    await api("/api/reqs", { method: "POST", body: JSON.stringify({ reqs }) });
    input.value = "";
    document.querySelector("#add-dialog")?.close?.();
    await loadDashboard();
    toast(`${reqs.length} REQ agregadas al monitoreo`);
  } catch (error) { toast(errorMessage(error)); }
  finally { button.disabled = false; setLoading(button, false); }
});

elements.intervalForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = Number(elements.intervalInput.value);
  if (!Number.isInteger(value) || value < 0 || value > 1440) {
    toast("El intervalo debe ser un número entero entre 0 y 1440 minutos");
    return;
  }
  const button = elements.intervalForm.querySelector('button[type="submit"]');
  button.disabled = true;
  setLoading(button, true);
  try {
    await api("/api/settings/interval", { method: "PUT", body: JSON.stringify({ intervalMinutes: value }) });
    await loadDashboard(true);
    toast(value === 0 ? "Monitor automático pausado" : `Intervalo automático: ${value} minutos`);
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    button.disabled = false;
    setLoading(button, false);
  }
});

elements.queryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  queryReq(normalizeReq(document.querySelector("#query-req").value));
});

for (const container of [elements.queryResult, elements.detailsContent]) {
  container.addEventListener("click", (event) => {
    const button = event.target.closest("[data-download-url]");
    if (button) downloadAttachment(button.dataset.downloadUrl, button.dataset.downloadName, button);
    const copy = event.target.closest("[data-copy]");
    if (copy) copyReq(copy.dataset.copy);
  });
}

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
    queryButton.closest("[popover]")?.hidePopover();
    const lookup = document.querySelector("#lookup-dialog");
    if (!lookup.open) lookup.showModal();
    document.querySelector("#query-req").value = queryButton.dataset.query;
    queryReq(queryButton.dataset.query, queryButton);
    return;
  }
  const lockButton = event.target.closest("[data-lock]");
  if (lockButton) {
    if (state.runRequestPending || state.dashboard?.monitor?.activeTask) return;
    lockButton.disabled = true;
    setLoading(lockButton, true);
    state.runRequestPending = true;
    updateRunSelection();
    try {
      const locked = lockButton.dataset.locked !== "true";
      await api(`/api/reqs/${encodeURIComponent(lockButton.dataset.lock)}/lock`, {
        method: "PUT", body: JSON.stringify({ locked }),
      });
      await loadDashboard();
      toast(locked ? "REQ bloqueada" : "REQ desbloqueada");
    } catch (error) { toast(errorMessage(error)); }
    finally { state.runRequestPending = false; updateRunSelection(); lockButton.disabled = false; setLoading(lockButton, false); }
    return;
  }
  const deleteButton = event.target.closest("[data-delete]");
  if (!deleteButton || !window.confirm(`¿Dejar de monitorear ${deleteButton.dataset.delete}?`)) return;
  deleteButton.disabled = true;
  setLoading(deleteButton, true);
  try {
    await api(`/api/reqs/${encodeURIComponent(deleteButton.dataset.delete)}`, { method: "DELETE" });
    await loadDashboard();
    toast("REQ eliminada del monitoreo");
  } catch (error) { toast(errorMessage(error)); }
  finally { deleteButton.disabled = false; setLoading(deleteButton, false); }
});

elements.run.addEventListener("click", () => runManualMonitor(selectedReqs()));
elements.runAll.addEventListener("click", runAllReqs);
elements.clearFilters.addEventListener("click", clearTableFilters);
const themeButton = document.querySelector("#theme-button");
function setTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === "dark" ? "Tema claro" : "Tema oscuro";
  themeButton.setAttribute("aria-pressed", String(theme === "light"));
}
try { setTheme(window.localStorage.getItem("req-workspace-theme") === "light" ? "light" : "dark"); }
catch { setTheme("dark"); }
themeButton.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  setTheme(theme);
  try { window.localStorage.setItem("req-workspace-theme", theme); } catch { /* theme is still applied */ }
});
narrowGrid?.addEventListener("change", ({ matches }) => {
  gridApi?.setColumnsVisible(secondaryGridColumns, !matches);
  gridApi?.refreshCells({ force: true, columns: ["req"] });
  gridApi?.resetRowHeights();
});
for (const input of Object.values(primaryFilters)) input?.addEventListener("input", () => gridApi?.onFilterChanged());
for (const button of document.querySelectorAll("[data-triage]")) {
  button.addEventListener("click", () => {
    const group = button.dataset.triage;
    selectedTriage = selectedTriage === group ? "all" : group;
    gridApi?.onFilterChanged();
  });
}
document.querySelector("#active-filters").addEventListener("click", async (event) => {
  const key = event.target.closest("[data-remove-filter]")?.dataset.removeFilter;
  if (!key) return;
  if (key === "triage") selectedTriage = "all";
  else if (key.startsWith("column:")) await gridApi?.setColumnFilterModel(key.slice(7), null);
  else {
    const input = primaryFilters[key] ?? elements.tableFilters[key];
    if (!input) return;
    input.value = key === "blocked" ? "all" : "";
    if (key === "project") updateFilterOptions(availableFilterRows);
  }
  gridApi?.onFilterChanged();
  primaryFilters.search?.focus();
});
for (const field of searchableFilterFields) {
  const input = elements.tableFilters[field];
  const list = elements.filterOptions[field];
  input.addEventListener("focus", () => { if (openSearchField !== field) showSearchOptions(field); });
  input.addEventListener("click", () => { if (openSearchField !== field) showSearchOptions(field); });
  input.addEventListener("input", () => {
    if (openSearchField === field) {
      renderSearchOptions(field, input.value);
      activeSearchIndex = -1;
      input.removeAttribute("aria-activedescendant");
    }
    if (field === "project") updateFilterOptions(availableFilterRows);
    gridApi?.onFilterChanged();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeSearchOptions(); return; }
    if (event.key === "Tab") { closeSearchOptions(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    if (openSearchField !== field) showSearchOptions(field);
    const choices = visibleSearchChoices[field] ?? [];
    if (!choices.length) return;
    event.preventDefault();
    if (event.key === "Enter") {
      if (activeSearchIndex < 0) return;
      input.value = choices[activeSearchIndex];
      closeSearchOptions();
      if (field === "project") updateFilterOptions(availableFilterRows);
      gridApi?.onFilterChanged();
      return;
    }
    activeSearchIndex = event.key === "ArrowDown"
      ? (activeSearchIndex + 1) % choices.length : (activeSearchIndex + choices.length - 1) % choices.length;
    const option = list.querySelector(`[data-index="${activeSearchIndex}"]`);
    list.querySelector(".is-active")?.classList.remove("is-active");
    option.classList.add("is-active");
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  });
  list.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-index]")) event.preventDefault();
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-index]");
    if (!option || !list.contains(option)) return;
    input.value = visibleSearchChoices[field][Number(option.dataset.index)];
    input.focus({ preventScroll: true });
    closeSearchOptions();
    if (field === "project") updateFilterOptions(availableFilterRows);
    gridApi?.onFilterChanged();
  });
  document.querySelector(`[data-filter-toggle="${field}"]`).addEventListener("click", () => {
    if (openSearchField === field) closeSearchOptions();
    else {
      showSearchOptions(field);
      input.focus({ preventScroll: true });
    }
  });
}
elements.tableFilters.blocked.addEventListener("change", () => gridApi?.onFilterChanged());
document.addEventListener("pointerdown", (event) => {
  if (openSearchField && !event.target.closest(`.search-filter[data-filter="${openSearchField}"]`)) closeSearchOptions();
});
function updateDateSort() {
  updateDateSortButtons();
  if (!gridApi) return;
  const field = elements.sortDate.value;
  if (!dateSortFields.includes(field)) return;
  gridApi.applyColumnState({ state: [{ colId: field, sort: dateSortDirections.get(`${activeDateSortControl}:${field}`) ?? "desc" }],
    defaultState: { sort: null } });
}
const dateSortButtons = Array.from(document.querySelectorAll("[data-date-order]") as NodeListOf<HTMLButtonElement>);
function updateDateSortButtons() {
  const date = elements.sortDate.selectedOptions?.[0]?.textContent?.trim() ?? "fecha elegida";
  const field = elements.sortDate.value;
  for (const button of dateSortButtons) {
    const filter = button.closest(".search-filter, .filter-sort-control")?.querySelector("label")?.textContent?.trim() ?? "filtro";
    const direction = dateSortDirections.get(`${button.dataset.dateOrder}:${field}`) ?? "desc";
    const next = direction === "desc" ? "más antigua primero" : "más reciente primero";
    button.textContent = direction === "desc" ? "↓" : "↑";
    button.setAttribute("aria-label", `Ordenar REQ por ${date} desde ${filter}: cambiar a ${next}`);
    button.title = `Ordenar por ${date}: ${next}`;
    button.setAttribute("aria-pressed", String(button.dataset.dateOrder === activeDateSortControl));
  }
}
elements.sortDate.addEventListener("change", updateDateSort);
for (const button of dateSortButtons) button.addEventListener("click", () => {
  const field = elements.sortDate.value;
  const control = button.dataset.dateOrder ?? "date";
  const key = `${control}:${field}`;
  dateSortDirections.set(key, (dateSortDirections.get(key) ?? "desc") === "desc" ? "asc" : "desc");
  activeDateSortControl = control;
  updateDateSort();
});
updateDateSortButtons();

elements.outsideHours.addEventListener("click", async () => {
  if (state.outsideHoursSaving) return;
  const enabled = elements.outsideHours.getAttribute("aria-pressed") === "true";
  state.outsideHoursSaving = true;
  elements.outsideHours.disabled = true;
  setLoading(elements.outsideHours, true);
  try {
    const saved = await api<{ allowOutsideHoursRuns: boolean }>("/api/settings/outside-hours", {
      method: "PUT", body: JSON.stringify({ allowOutsideHoursRuns: !enabled }),
    });
    elements.outsideHours.setAttribute("aria-pressed", String(saved.allowOutsideHoursRuns));
    elements.outsideHours.textContent = saved.allowOutsideHoursRuns ? "Restringir a horario laboral" : "Habilitar fuera de horario";
    await loadDashboard();
    toast(enabled ? "Monitor restringido a horario laboral" : "Monitor habilitado fuera de horario (manual y automático)");
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    state.outsideHoursSaving = false;
    elements.outsideHours.disabled = Boolean(state.dashboard?.monitor?.activeTask);
    setLoading(elements.outsideHours, false);
  }
});

async function start() {
  try {
    await loadDashboard();
  } catch (error) {
    toast(errorMessage(error));
  }
}

start();
window.setInterval(() => {
  if (!state.dashboard?.monitor?.running) loadDashboard(true);
}, 15_000);

export {};
