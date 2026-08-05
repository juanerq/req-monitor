import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import Holidays from "date-holidays";
import { chromium } from "playwright";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const HOST = process.env.MONITOR_API_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MONITOR_API_PORT ?? "8787");
const REQ_FILE = path.resolve(process.env.REQ_FILE ?? "reqs.txt");
const ARTIFACTS_DIR = path.resolve(process.env.ARTIFACTS_DIR ?? "artifacts");
const LOG_FILE = path.join(ARTIFACTS_DIR, "monitor.log");
const RESULTS_FILE = path.join(ARTIFACTS_DIR, "monitor-results.json");
const WEB_DIR = path.resolve("web");
const SETTINGS_FILE = path.resolve(
  process.env.MONITOR_SETTINGS_FILE ?? path.join(path.dirname(REQ_FILE), "settings.json"),
);
const LEGACY_API_TOKEN_FILE = path.join(path.dirname(REQ_FILE), "api-token");
const AUTH_FILE = path.resolve(
  process.env.AUTH_FILE ?? "playwright/.auth/miasistencia.json",
);
const APP_URL = process.env.APP_URL ??
  "https://miasistencia360-dwp.claro.com.co/dwp/app/#/catalog";
const PORTAL_ORIGIN = new URL(APP_URL).origin;
const REQ_PATTERN = /^REQ\d+$/i;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_REQS = 10;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const INTERVAL_MINUTES = Number(process.env.MONITOR_INTERVAL_MINUTES ?? "15");
const RUN_ON_START = process.env.MONITOR_RUN_ON_START !== "false";
const MONITOR_TIME_ZONE = process.env.MONITOR_TIME_ZONE ?? "America/Bogota";
const colombianHolidays = new Holidays("CO", {
  languages: ["es"],
  timezone: MONITOR_TIME_ZONE,
});
const holidayCache = new Map<number, Map<string, string>>();

type MonitorStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
};

type MonitorSettings = {
  teamsWebhookUrl?: string;
};

type ScheduleDecision = {
  allowed: boolean;
  reason: string;
};

let child: ChildProcess | null = null;
let activeTask: "monitor" | "query" | "auth" | null = null;
const monitorStatus: MonitorStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
};

function colombiaTime(date: Date): {
  date: string;
  year: number;
  weekday: string;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MONITOR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(value("year"));
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    year,
    weekday: value("weekday"),
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

function publicHolidays(year: number): Map<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const holidays = new Map(
    colombianHolidays
      .getHolidays(year)
      .filter((holiday) => holiday.type === "public")
      .map((holiday) => [holiday.date.slice(0, 10), holiday.name]),
  );
  holidayCache.set(year, holidays);
  return holidays;
}

function scheduleDecision(now = new Date()): ScheduleDecision {
  const local = colombiaTime(now);
  if (["Sat", "Sun"].includes(local.weekday)) {
    return { allowed: false, reason: "fin de semana" };
  }
  const holiday = publicHolidays(local.year).get(local.date);
  if (holiday) return { allowed: false, reason: `festivo: ${holiday}` };
  const morning = local.minutes >= 8 * 60 && local.minutes <= 12 * 60;
  const afternoon = local.minutes >= 14 * 60 && local.minutes <= 18 * 60;
  return (morning || afternoon)
    ? { allowed: true, reason: "horario laboral" }
    : { allowed: false, reason: "fuera del horario laboral" };
}

function scheduleError(decision: ScheduleDecision): string {
  return `Consulta no permitida: ${decision.reason}. Horario: lunes a viernes, 08:00-12:00 y 14:00-18:00, excepto festivos de Colombia`;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function serveWeb(response: ServerResponse, file: string, contentType: string): void {
  const filePath = path.join(WEB_DIR, file);
  if (!fs.existsSync(filePath)) {
    json(response, 404, { error: "Interfaz no encontrada" });
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(fs.readFileSync(filePath));
}

function readReqs(): string[] {
  if (!fs.existsSync(REQ_FILE)) return [];
  return fs
    .readFileSync(REQ_FILE, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().toUpperCase())
    .filter((line) => line && !line.startsWith("#"));
}

function validateReqs(values: unknown): string[] {
  if (!Array.isArray(values)) throw new Error("reqs debe ser un arreglo");
  const reqs = [...new Set(values.map((value) => String(value).trim().toUpperCase()))];
  const invalid = reqs.filter((req) => !REQ_PATTERN.test(req));
  if (invalid.length > 0) throw new Error(`REQ inválida: ${invalid.join(", ")}`);
  return reqs;
}

function writeReqs(reqs: string[]): void {
  fs.mkdirSync(path.dirname(REQ_FILE), { recursive: true });
  const temporary = `${REQ_FILE}.tmp`;
  fs.writeFileSync(temporary, reqs.length > 0 ? `${reqs.join("\n")}\n` : "", "utf8");
  fs.renameSync(temporary, REQ_FILE);
}

function mergeReqLists(current: string[], requested: string[]): string[] {
  return [...new Set([...current, ...requested])];
}

function readResults(): unknown[] {
  if (!fs.existsSync(RESULTS_FILE)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readSettings(): MonitorSettings {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  const value = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Configuración inválida en ${SETTINGS_FILE}`);
  }
  return value as MonitorSettings;
}

function validateTeamsWebhook(value: unknown): string {
  if (typeof value !== "string" || value.length > 8_192) {
    throw new Error("TEAMS_WEBHOOK_URL inválida");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("TEAMS_WEBHOOK_URL inválida");
  }
  if (url.protocol !== "https:") {
    throw new Error("TEAMS_WEBHOOK_URL debe usar HTTPS");
  }
  return url.href;
}

function loadRuntimeSettings(): void {
  const settings = readSettings();
  if (settings.teamsWebhookUrl !== undefined) {
    process.env.TEAMS_WEBHOOK_URL = validateTeamsWebhook(settings.teamsWebhookUrl);
  }
}

function saveTeamsWebhook(value: unknown): void {
  const teamsWebhookUrl = validateTeamsWebhook(value);
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const temporary = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ teamsWebhookUrl }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, SETTINGS_FILE);
  process.env.TEAMS_WEBHOOK_URL = teamsWebhookUrl;
}

function webhookStatus(): { configured: boolean; source: "runtime" | "environment" | "none" } {
  return {
    configured: Boolean(process.env.TEAMS_WEBHOOK_URL),
    source: fs.existsSync(SETTINGS_FILE)
      ? "runtime"
      : process.env.TEAMS_WEBHOOK_URL
        ? "environment"
        : "none",
  };
}

function validateAttachmentUrl(value: unknown): URL {
  if (typeof value !== "string") throw new Error("URL de adjunto inválida");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL de adjunto inválida");
  }
  const attachmentPath = /^\/dwp\/rest\/v2\/service_request\/activity_log\/srm\/[^/]+\/file\/[^/]+$/;
  if (url.origin !== PORTAL_ORIGIN || !attachmentPath.test(url.pathname)) {
    throw new Error("URL de adjunto no permitida");
  }
  return url;
}

async function downloadAttachment(value: unknown, response: ServerResponse): Promise<void> {
  const url = validateAttachmentUrl(value);
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error("No existe sesión MiAsistencia360; ejecuta pnpm run auth");
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: AUTH_FILE });
    const page = await context.newPage();
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const deadline = Date.now() + 60_000;
    let upstream = await context.request.get(url.href, { failOnStatusCode: false });
    while (upstream.status() === 401 && Date.now() < deadline) {
      await upstream.dispose();
      if (
        page.url().includes("-rsso.") ||
        await page.locator('input[type="password"]:visible').count() > 0
      ) {
        throw new Error("Sesión MiAsistencia360 expirada; ejecuta pnpm run auth");
      }
      await page.waitForTimeout(500);
      upstream = await context.request.get(url.href, { failOnStatusCode: false });
    }
    if (upstream.status() === 401) {
      throw new Error("Sesión MiAsistencia360 expirada; ejecuta pnpm run auth");
    }
    const contentType = upstream.headers()["content-type"] ?? "application/octet-stream";
    const contentLength = Number(upstream.headers()["content-length"] ?? "0");
    const returnedToSso = new URL(upstream.url()).origin !== PORTAL_ORIGIN;
    if (returnedToSso || contentType.includes("text/html")) {
      throw new Error("Sesión MiAsistencia360 expirada; ejecuta pnpm run auth");
    }
    if (!upstream.ok()) {
      throw new Error(`MiAsistencia360 respondió HTTP ${upstream.status()}`);
    }
    if (contentLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("Adjunto demasiado grande; límite 50 MB");
    }
    const body = await upstream.body();
    if (body.length > MAX_ATTACHMENT_BYTES) {
      throw new Error("Adjunto demasiado grande; límite 50 MB");
    }
    if (
      body.length < 4_096 &&
      body.toString("utf8").includes("MOBILITY_ERROR_SESSION_EXPIRED")
    ) {
      throw new Error("Sesión MiAsistencia360 expirada; ejecuta pnpm run auth");
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": upstream.headers()["content-disposition"] ?? "attachment",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function renewPortalSession(usernameValue: unknown, passwordValue: unknown): Promise<void> {
  const username = typeof usernameValue === "string" ? usernameValue.trim() : "";
  const password = typeof passwordValue === "string" ? passwordValue : "";
  if (!username || !password) throw new Error("Usuario y contraseña son obligatorios");
  if (username.length > 256 || password.length > 1_024) {
    throw new Error("Credenciales inválidas");
  }
  if (child || activeTask) throw new Error("Monitor ocupado; intenta nuevamente al finalizar");

  activeTask = "auth";
  const browser = await chromium.launch({ headless: true }).catch((error: unknown) => {
    activeTask = null;
    throw error;
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const usernameInput = page.locator("#user_login");
    const passwordInput = page.locator("#login_user_password");
    await usernameInput.waitFor({ state: "visible", timeout: 30_000 });
    await usernameInput.fill(username);
    await passwordInput.fill(password);
    await page.getByRole("button", { name: /log in|iniciar sesi[oó]n|ingresar/i }).click();
    try {
      await page.waitForURL(
        (url) => url.origin === PORTAL_ORIGIN && !url.hostname.includes("-rsso."),
        { timeout: 60_000 },
      );
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    } catch {
      throw new Error("No fue posible iniciar sesión; verifica usuario y contraseña");
    }
    if (page.url().includes("-rsso.") || await passwordInput.isVisible().catch(() => false)) {
      throw new Error("No fue posible iniciar sesión; verifica usuario y contraseña");
    }
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    await context.storageState({ path: AUTH_FILE });
  } finally {
    await browser.close().catch(() => undefined);
    activeTask = null;
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Cuerpo demasiado grande");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("JSON inválido");
  }
}

function runMonitor(source = "manual"): boolean {
  if (child || activeTask) return false;
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const log = fs.createWriteStream(LOG_FILE, { flags: "a" });
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");

  monitorStatus.running = true;
  monitorStatus.startedAt = new Date().toISOString();
  monitorStatus.finishedAt = null;
  monitorStatus.exitCode = null;
  activeTask = "monitor";
  log.write(`\n[${monitorStatus.startedAt}] Inicio ${source}\n`);

  child = spawn(process.execPath, [tsxCli, "monitor-req.ts"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("error", (error) => log.write(`Error iniciando monitor: ${error.message}\n`));
  child.on("close", (code) => {
    monitorStatus.running = false;
    monitorStatus.finishedAt = new Date().toISOString();
    monitorStatus.exitCode = code;
    log.end(`[${monitorStatus.finishedAt}] Fin, código ${code}\n`);
    child = null;
    activeTask = null;
  });
  return true;
}

function runScheduledMonitor(logSkipped = false): void {
  const decision = scheduleDecision();
  if (!decision.allowed) {
    if (logSkipped) console.log(`Ciclo inicial omitido: ${decision.reason}`);
    return;
  }
  if (!runMonitor("programado")) {
    console.log("Ciclo omitido: monitor todavía ejecutándose");
  }
}

function scheduleNextMonitor(): void {
  const intervalMs = INTERVAL_MINUTES * 60_000;
  const now = Date.now();
  const next = Math.floor(now / intervalMs + 1) * intervalMs;
  setTimeout(() => {
    runScheduledMonitor();
    scheduleNextMonitor();
  }, next - now);
}

async function queryReqs(reqs: string[]): Promise<unknown[]> {
  if (child || activeTask) throw new Error("El monitor está ocupado");
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const output = path.join(ARTIFACTS_DIR, `manual-query-${Date.now()}.json`);
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
  const args = [tsxCli, "check-req.ts", ...reqs.flatMap((req) => ["--req", req]), "--output", output];
  let stderr = "";
  activeTask = "query";

  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      child = null;
      activeTask = null;
      fs.rmSync(output, { force: true });
      reject(error);
    });
    child.on("close", () => {
      child = null;
      activeTask = null;
      try {
        if (!fs.existsSync(output)) {
          throw new Error(stderr.trim() || "La consulta no produjo resultados");
        }
        const value = JSON.parse(fs.readFileSync(output, "utf8")) as unknown;
        if (!Array.isArray(value)) throw new Error("Resultado de consulta inválido");
        resolve(value);
      } catch (error) {
        reject(error);
      } finally {
        fs.rmSync(output, { force: true });
      }
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (request.method === "GET" && url.pathname === "/") {
    serveWeb(response, "index.html", "text/html; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    serveWeb(response, "app.js", "text/javascript; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/styles.css") {
    serveWeb(response, "styles.css", "text/css; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    json(response, 200, { localOnly: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/reqs") {
    json(response, 200, { reqs: readReqs() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const schedule = scheduleDecision();
    json(response, 200, {
      reqs: readReqs(),
      results: readResults(),
      monitor: { ...monitorStatus, activeTask },
      schedule: {
        ...schedule,
        timeZone: MONITOR_TIME_ZONE,
        intervalMinutes: INTERVAL_MINUTES,
      },
      settings: { teamsWebhook: webhookStatus() },
    });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/settings/teams-webhook") {
    const body = await readBody(request) as { url?: unknown };
    saveTeamsWebhook(body.url);
    json(response, 200, { teamsWebhook: webhookStatus() });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/reqs") {
    const body = await readBody(request) as { reqs?: unknown };
    const currentReqs = readReqs();
    const requestedReqs = validateReqs(body.reqs);
    const forceReplace = url.searchParams.get("replace") === "true";
    const wouldShrink = requestedReqs.length < currentReqs.length;
    const reqs = forceReplace || !wouldShrink
      ? requestedReqs
      : mergeReqLists(currentReqs, requestedReqs);
    writeReqs(reqs);
    json(response, 200, {
      reqs,
      replaced: forceReplace,
      protectedFromShrink: !forceReplace && wouldShrink,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/reqs") {
    const body = await readBody(request) as { req?: unknown; reqs?: unknown };
    const additions = validateReqs(body.reqs ?? [body.req]);
    const reqs = [...new Set([...readReqs(), ...additions])];
    writeReqs(reqs);
    json(response, 201, { reqs });
    return;
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/reqs/")) {
    const req = decodeURIComponent(url.pathname.slice("/api/reqs/".length)).toUpperCase();
    if (!REQ_PATTERN.test(req)) throw new Error(`REQ inválida: ${req}`);
    const reqs = readReqs().filter((item) => item !== req);
    writeReqs(reqs);
    json(response, 200, { reqs });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/monitor/run") {
    const decision = scheduleDecision();
    if (!decision.allowed) {
      json(response, 409, { error: scheduleError(decision) });
      return;
    }
    const started = runMonitor("manual desde API");
    json(response, started ? 202 : 409, {
      started,
      ...(started ? {} : { error: "El monitor ya está ejecutándose" }),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/reqs/query") {
    if (child || activeTask) {
      json(response, 409, { error: "Monitor ocupado; intenta nuevamente al finalizar" });
      return;
    }
    const body = await readBody(request) as { req?: unknown; reqs?: unknown };
    const reqs = validateReqs(body.reqs ?? [body.req]);
    if (reqs.length === 0) throw new Error("Debes indicar al menos una REQ");
    if (reqs.length > MAX_QUERY_REQS) {
      throw new Error(`Puedes consultar máximo ${MAX_QUERY_REQS} REQ a la vez`);
    }
    json(response, 200, { results: await queryReqs(reqs) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/attachments/download") {
    const body = await readBody(request) as { url?: unknown };
    await downloadAttachment(body.url, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/renew") {
    if (child || activeTask) {
      json(response, 409, { error: "Monitor ocupado; intenta nuevamente al finalizar" });
      return;
    }
    const body = await readBody(request) as { username?: unknown; password?: unknown };
    await renewPortalSession(body.username, body.password);
    json(response, 200, { authenticated: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/monitor/status") {
    json(response, 200, { ...monitorStatus, activeTask });
    return;
  }
  json(response, 404, { error: "Ruta no encontrada" });
}

async function main(): Promise<void> {
  fs.rmSync(LEGACY_API_TOKEN_FILE, { force: true });
  loadRuntimeSettings();
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
    throw new Error(`Puerto inválido: ${PORT}`);
  }
  if (!Number.isFinite(INTERVAL_MINUTES) || INTERVAL_MINUTES < 0) {
    throw new Error(`MONITOR_INTERVAL_MINUTES inválido: ${INTERVAL_MINUTES}`);
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      json(response, /inválida|arreglo|grande|JSON/i.test(message) ? 400 : 500, {
        error: message,
      });
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`Monitor API disponible en http://${HOST}:${PORT}`);
    if (INTERVAL_MINUTES > 0) {
      console.log(
        `Monitor programado cada ${INTERVAL_MINUTES} minutos, lunes a viernes 08:00-12:00 y 14:00-18:00 (${MONITOR_TIME_ZONE}), excepto festivos de Colombia`,
      );
      scheduleNextMonitor();
    }
    if (RUN_ON_START) setTimeout(() => runScheduledMonitor(true), 2_000);
  });

  const shutdown = (): void => {
    child?.kill("SIGTERM");
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
