import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ActiveDeadline } from "./deadline.js";

const PENDING_STATUS = "Pendiente de respuesta";
const DEFAULT_REQ_FILE = process.env.REQ_FILE ?? "reqs.txt";
const DEFAULT_RESULTS_FILE = "artifacts/monitor-results.json";
const DEFAULT_STATE_FILE = "artifacts/req-status.json";
const PORTAL_URL =
  "https://miasistencia360-dwp.claro.com.co/dwp/app/#/catalog";

type ConversationStatus =
  | "Finalizada"
  | "En validación"
  | "Respondida"
  | "Pendiente de respuesta"
  | "Sin comentario de operaciones";

type Comment = {
  author: string;
  date: string | null;
  text: string;
  attachments: Array<{
    name: string;
    url: string | null;
    size: string | null;
  }>;
};

type ReqResult = {
  req: string;
  checkedAt: string;
  conversationStatus: ConversationStatus;
  status: string | null;
  title: string | null;
  microservices: string[];
  pullRequestUrls: string[];
  detailUrl: string | null;
  latestOperationsComment: Comment | null;
  activeDeadline: ActiveDeadline | null;
  error?: string;
};

type StoredState = Record<
  string,
  {
    conversationStatus: ConversationStatus;
    lastChecked: string;
    lastNotified?: string;
    latestOperationsCommentKey?: string;
    lastReminder?: { sourceKey: string; day: string };
  }
>;

type Options = {
  file: string;
  output: string;
  state: string;
  dryRun: boolean;
  testNotification: boolean;
};

function printHelp(): void {
  console.log(`
Uso:
  pnpm monitor-req
  pnpm monitor-req --file reqs.txt
  pnpm monitor-req --dry-run
  pnpm monitor-req --test-notification

Opciones:
  --file <ruta>          Archivo con una REQ por línea
  --output <ruta>        Resultado detallado de la consulta
  --state <ruta>         Estado usado para evitar alertas repetidas
  --dry-run              Mostrar alertas sin enviarlas ni guardar estado
  --test-notification    Enviar una notificación de prueba y salir
  --help                 Mostrar esta ayuda
`);
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    file: DEFAULT_REQ_FILE,
    output: DEFAULT_RESULTS_FILE,
    state: DEFAULT_STATE_FILE,
    dryRun: false,
    testNotification: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--test-notification") {
      options.testNotification = true;
      continue;
    }
    if (["--file", "--output", "--state"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Falta el valor de ${arg}`);
      }
      index += 1;
      if (arg === "--file") options.file = value;
      if (arg === "--output") options.output = value;
      if (arg === "--state") options.state = value;
      continue;
    }
    throw new Error(`Opción desconocida: ${arg}`);
  }
  return options;
}

function loadState(file: string): StoredState {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as StoredState;
}

function saveState(file: string, state: StoredState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function runReqCheck(options: Options): ReqResult[] {
  if (!fs.existsSync(options.file)) {
    throw new Error(`No existe ${options.file}. Usa reqs.txt.example como referencia`);
  }
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  const temporaryOutput = `${options.output}.tmp`;
  fs.rmSync(temporaryOutput, { force: true });

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    pnpm,
    ["check-req", "--file", options.file, "--output", temporaryOutput],
    { stdio: "inherit", env: process.env },
  );

  if (result.error) throw result.error;
  if (!fs.existsSync(temporaryOutput)) {
    throw new Error(`La consulta no generó ${temporaryOutput}`);
  }

  const results = JSON.parse(fs.readFileSync(temporaryOutput, "utf8")) as ReqResult[];
  fs.renameSync(temporaryOutput, options.output);
  if (result.status !== 0) {
    console.warn("La consulta terminó con errores; se procesarán solo las REQ válidas");
  }
  return results;
}

function trimToTeamsLimit(message: string): string {
  const suffix = "\n\n[Mensaje recortado por límite de Teams]";
  let trimmed = message;
  while (Buffer.byteLength(trimmed + suffix, "utf8") > 27_000) {
    trimmed = trimmed.slice(0, Math.floor(trimmed.length * 0.9));
  }
  return trimmed === message ? message : `${trimmed}${suffix}`;
}

function buildNotification(result: ReqResult): string {
  const comment = result.latestOperationsComment;
  const finalized = result.conversationStatus === "Finalizada";
  const attachments = comment?.attachments
    .map((attachment) =>
      attachment.url
        ? `- ${attachment.name}${attachment.size ? ` (${attachment.size})` : ""}: ${attachment.url}`
        : `- ${attachment.name}${attachment.size ? ` (${attachment.size})` : ""}`,
    )
    .join("\n");

  return trimToTeamsLimit(
    [
      finalized
        ? `REQ finalizada: ${result.req}`
        : `REQ pendiente de respuesta: ${result.req}`,
      result.title ? `Título: ${result.title}` : null,
      result.microservices.length > 0
        ? `${result.microservices.length === 1 ? "Microservicio" : "Microservicios"}: ${result.microservices.join(", ")}`
        : null,
      result.pullRequestUrls.length > 0
        ? `${result.pullRequestUrls.length === 1 ? "Pull Request" : "Pull Requests"}:\n${result.pullRequestUrls.map((url) => `- ${url}`).join("\n")}`
        : null,
      `Estado del portal: ${result.status ?? "Desconocido"}`,
      comment
        ? `${finalized ? "Última respuesta de Operaciones" : "Operaciones"}: ${comment.author}`
        : null,
      comment?.date ? `Fecha: ${comment.date}` : null,
      comment?.text ? `\nComentario:\n${comment.text}` : null,
      attachments ? `\nAdjuntos:\n${attachments}` : null,
      `\nAbrir REQ: ${result.detailUrl ?? PORTAL_URL}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  );
}

function operationsCommentKey(comment: Comment | null): string | undefined {
  if (!comment) return undefined;
  return [comment.author, comment.date ?? "", comment.text].join("|");
}

function colombianPublicHolidays(year: number): Set<string> {
  const holidays = new Set<string>();
  const date = (month: number, day: number) => new Date(Date.UTC(year, month - 1, day));
  const add = (value: Date, moveToMonday = false) => {
    const day = new Date(value);
    if (moveToMonday) day.setUTCDate(day.getUTCDate() + (8 - day.getUTCDay()) % 7);
    holidays.add(day.toISOString().slice(0, 10));
  };
  for (const [month, day] of [[1, 1], [5, 1], [7, 20], [8, 7], [12, 8], [12, 25]]) {
    add(date(month, day));
  }
  for (const [month, day] of [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]]) {
    add(date(month, day), true);
  }
  // Gregorian Easter determines Holy Week and the three moved Colombian observances.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easterMonth = Math.floor((h + l - 7 * m + 114) / 31);
  const easterDay = (h + l - 7 * m + 114) % 31 + 1;
  const easter = date(easterMonth, easterDay);
  for (const offset of [-3, -2, 39, 60, 68]) {
    const observance = new Date(easter);
    observance.setUTCDate(observance.getUTCDate() + offset);
    add(observance, offset > 0);
  }
  return holidays;
}

/** Only 08:00–11:59 in Colombia qualifies; UTC dates must never control deduplication. */
export function reminderDay(now: Date): string | null {
  if (Number.isNaN(now.valueOf())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  const hour = Number(part("hour"));
  if (hour < 8 || hour >= 12 || ["Sat", "Sun"].includes(part("weekday"))) return null;
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  return colombianPublicHolidays(Number(part("year"))).has(day) ? null : day;
}

type ReqState = StoredState[string];

/** Send one alert at most per run; only accepted deliveries advance deduplication state. */
export async function processReqResult(
  result: ReqResult,
  previous: ReqState | undefined,
  now: Date,
  dryRun: boolean,
  send: (message: string, actionUrl: string, pullRequestUrls: string[]) => Promise<void>,
  notificationsEnabled = true,
): Promise<ReqState> {
  const currentCommentKey = operationsCommentKey(result.latestOperationsComment);
  const pendingAlert = result.conversationStatus === PENDING_STATUS &&
    (previous?.conversationStatus !== PENDING_STATUS || previous?.latestOperationsCommentKey !== currentCommentKey || !previous?.lastNotified);
  const finalizedAlert = result.conversationStatus === "Finalizada" &&
    (previous?.conversationStatus !== "Finalizada" || !previous?.lastNotified);
  const day = reminderDay(now);
  const deadline = result.activeDeadline;
  const awaitingDeadline = result.conversationStatus === PENDING_STATUS && deadline && day;
  const reminder = !pendingAlert && !finalizedAlert && awaitingDeadline &&
    (previous?.lastReminder?.sourceKey !== deadline.sourceKey || previous?.lastReminder?.day !== day);
  const next: ReqState = {
    conversationStatus: result.conversationStatus,
    lastChecked: result.checkedAt,
    ...(previous?.lastNotified ? { lastNotified: previous.lastNotified } : {}),
    ...(currentCommentKey ? { latestOperationsCommentKey: currentCommentKey } : {}),
    ...(previous?.lastReminder ? { lastReminder: previous.lastReminder } : {}),
  };

  if (!notificationsEnabled && !dryRun) {
    if (pendingAlert || finalizedAlert) delete next.lastNotified;
    console.log(`${result.req}: ${result.conversationStatus}, notificaciones desactivadas`);
    return next;
  }

  if (pendingAlert || finalizedAlert || reminder) {
    const message = reminder && deadline
      ? trimToTeamsLimit(`Recordatorio: REQ pendiente de respuesta: ${result.req}\nPlazo indicado: ${new Intl.DateTimeFormat("es-CO", {
        timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short",
      }).format(new Date(deadline.dueAt))}\nAbrir REQ: ${result.detailUrl ?? PORTAL_URL}`)
      : buildNotification(result);
    await send(message, result.detailUrl ?? PORTAL_URL, result.pullRequestUrls);
    if (!dryRun) {
      next.lastNotified = now.toISOString();
      if (awaitingDeadline && deadline && day) next.lastReminder = { sourceKey: deadline.sourceKey, day };
    }
    console.log(`${result.req}: ${reminder ? "recordatorio" : "alerta"} ${dryRun ? "simulada" : "enviada"}`);
  } else {
    console.log(`${result.req}: ${result.conversationStatus}, sin alerta nueva`);
  }
  return next;
}

function buildTeamsPayload(
  message: string,
  actionUrl: string,
  pullRequestUrls: string[],
): Record<string, unknown> {
  const [title, ...details] = message.split("\n");
  const isTest = title.startsWith("Prueba de notificación");
  const isFinalized = title.startsWith("REQ finalizada");
  const style = isTest ? "accent" : isFinalized ? "good" : "attention";
  const color = isTest ? "Accent" : isFinalized ? "Good" : "Attention";
  const banner = isTest
    ? "✓ Integración activa"
    : isFinalized
      ? "✓ REQ finalizada"
      : "⚠ Acción requerida";
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body: [
            {
              type: "Container",
              style,
              bleed: true,
              items: [
                {
                  type: "TextBlock",
                  text: banner,
                  weight: "Bolder",
                  size: "Medium",
                },
              ],
            },
            {
              type: "TextBlock",
              text: title,
              color,
              weight: "Bolder",
              size: "Large",
              wrap: true,
              spacing: "Large",
            },
            {
              type: "TextBlock",
              text: details.join("\n"),
              wrap: true,
              spacing: "Medium",
            },
            {
              type: "TextBlock",
              text: "MiAsistencia360 · Monitor automático de REQ",
              size: "Small",
              isSubtle: true,
              separator: true,
              spacing: "Large",
            },
          ],
          actions: [
            {
              type: "Action.OpenUrl",
              title: "Abrir REQ",
              url: actionUrl,
            },
            ...pullRequestUrls.slice(0, 4).map((url, index) => ({
              type: "Action.OpenUrl",
              title: pullRequestUrls.length === 1 ? "Abrir Pull Request" : `Abrir PR ${index + 1}`,
              url,
            })),
          ],
        },
      },
    ],
  };
}

async function postToTeams(
  message: string,
  dryRun: boolean,
  actionUrl = PORTAL_URL,
  pullRequestUrls: string[] = [],
): Promise<void> {
  if (dryRun) {
    console.log(`\n[DRY RUN]\n${message}\n`);
    return;
  }

  const webhook = process.env.TEAMS_WEBHOOK_URL?.trim();
  if (!webhook) {
    throw new Error("Falta TEAMS_WEBHOOK_URL; configúralo para usar --test-notification");
  }
  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    throw new Error("TEAMS_WEBHOOK_URL no es una URL válida");
  }
  if (url.protocol !== "https:") {
    throw new Error("TEAMS_WEBHOOK_URL debe usar HTTPS");
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildTeamsPayload(message, actionUrl, pullRequestUrls)),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 3) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Teams respondió HTTP ${response.status}: ${detail}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : 1_000 * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function main(): Promise<void> {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const options = parseArgs(process.argv.slice(2));
  if (options.testNotification) {
    await postToTeams(
      `Prueba de notificación MiAsistencia360 (${new Date().toISOString()})`,
      options.dryRun,
    );
    console.log(
      options.dryRun
        ? "Notificación de prueba simulada"
        : "Notificación de prueba aceptada por workflow",
    );
    return;
  }

  const previous = loadState(options.state);
  const next: StoredState = { ...previous };
  const results = runReqCheck(options);
  let failed = false;

  for (const result of results) {
    if (result.error) {
      failed = true;
      console.error(`${result.req}: ${result.error}`);
      continue;
    }

    try {
      next[result.req] = await processReqResult(result, previous[result.req], new Date(), options.dryRun,
        (message, actionUrl, urls) => postToTeams(message, options.dryRun, actionUrl, urls),
        options.dryRun || Boolean(process.env.TEAMS_WEBHOOK_URL?.trim()));
    } catch (error) {
      failed = true;
      console.error(`${result.req}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!options.dryRun) saveState(options.state, next);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.basename(process.argv[1]) === "monitor-req.ts") {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
