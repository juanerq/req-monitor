import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  error?: string;
};

type StoredState = Record<
  string,
  {
    conversationStatus: ConversationStatus;
    lastChecked: string;
    lastNotified?: string;
    latestOperationsCommentKey?: string;
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
  fs.rmSync(options.output, { force: true });

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    pnpm,
    ["check-req", "--file", options.file, "--output", options.output],
    { stdio: "inherit", env: process.env },
  );

  if (result.error) throw result.error;
  if (!fs.existsSync(options.output)) {
    throw new Error(`La consulta no generó ${options.output}`);
  }

  const results = JSON.parse(fs.readFileSync(options.output, "utf8")) as ReqResult[];
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

  const webhook = process.env.TEAMS_WEBHOOK_URL;
  if (!webhook) {
    throw new Error("Falta TEAMS_WEBHOOK_URL");
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

    const currentCommentKey = operationsCommentKey(result.latestOperationsComment);
    const pendingAlert =
      result.conversationStatus === PENDING_STATUS &&
      (previous[result.req]?.conversationStatus !== PENDING_STATUS ||
        previous[result.req]?.latestOperationsCommentKey !== currentCommentKey);
    const finalizedAlert =
      result.conversationStatus === "Finalizada" &&
      (previous[result.req]?.conversationStatus !== "Finalizada" ||
        !previous[result.req]?.lastNotified);
    const needsAlert = pendingAlert || finalizedAlert;
    let notifiedAt = previous[result.req]?.lastNotified;

    if (needsAlert) {
      try {
        await postToTeams(
          buildNotification(result),
          options.dryRun,
          result.detailUrl ?? PORTAL_URL,
          result.pullRequestUrls,
        );
        notifiedAt = new Date().toISOString();
        console.log(`${result.req}: alerta ${options.dryRun ? "simulada" : "enviada"}`);
      } catch (error) {
        failed = true;
        console.error(
          `${result.req}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    } else {
      console.log(`${result.req}: ${result.conversationStatus}, sin alerta nueva`);
    }

    next[result.req] = {
      conversationStatus: result.conversationStatus,
      lastChecked: result.checkedAt,
      ...(notifiedAt ? { lastNotified: notifiedAt } : {}),
      ...(currentCommentKey ? { latestOperationsCommentKey: currentCommentKey } : {}),
    };
  }

  if (!options.dryRun) saveState(options.state, next);
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
