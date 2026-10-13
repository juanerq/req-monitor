import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { conversationStatus, deriveCommentCycle, type ActiveDeadline } from "./deadline.js";
import { authFilePath, loadAuthEnvironment, saveAuthSession } from "./auth-session.js";

loadAuthEnvironment();
const APP_URL =
  process.env.APP_URL ??
  "https://miasistencia360-dwp.claro.com.co/dwp/app/#/catalog";
const AUTH_FILE = authFilePath();
const DEFAULT_OUTPUT = "artifacts/req-responses.json";
const REQ_PATTERN = /^REQ\d+$/i;

type Attachment = {
  name: string;
  url: string | null;
  type: string | null;
  size: string | null;
};

type Comment = {
  author: string;
  date: string | null;
  text: string;
  attachments: Attachment[];
  isResponse: boolean;
};

type ReqResult = {
  req: string;
  checkedAt: string;
  responded: boolean;
  conversationStatus:
    | "Finalizada"
    | "En validación"
    | "Respondida"
    | "Pendiente de respuesta"
    | "Sin comentario de operaciones";
  status: string | null;
  title: string | null;
  requester: string | null;
  microservices: string[];
  pullRequestUrls: string[];
  detailUrl: string | null;
  latestOperationsComment: Comment | null;
  activeDeadline: ActiveDeadline | null;
  requesterRepliesAfterOperations: Comment[];
  latestResponse: Comment | null;
  responses: Comment[];
  comments: Comment[];
  attachments: Attachment[];
  error?: string;
};

type Options = {
  reqs: string[];
  file?: string;
  output: string;
  headed: boolean;
  login: boolean;
};

function printHelp(): void {
  console.log(`
Uso:
  pnpm run auth
  pnpm check-req --req REQ000007780445
  pnpm check-req --file reqs.txt

Opciones:
  --req <numero>     REQ para consultar; puede repetirse
  --file <ruta>      Archivo con una REQ por línea
  --output <ruta>    JSON de salida (predeterminado: ${DEFAULT_OUTPUT})
  --headed           Mostrar navegador durante la consulta
  --login            Renovar la sesión autenticada
  --help             Mostrar esta ayuda
`);
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    reqs: [],
    output: DEFAULT_OUTPUT,
    headed: false,
    login: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--headed") {
      options.headed = true;
      continue;
    }
    if (arg === "--login") {
      options.login = true;
      options.headed = true;
      continue;
    }
    if (["--req", "--file", "--output"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Falta el valor de ${arg}`);
      }
      index += 1;
      if (arg === "--req") options.reqs.push(value);
      if (arg === "--file") options.file = value;
      if (arg === "--output") options.output = value;
      continue;
    }
    if (REQ_PATTERN.test(arg)) {
      options.reqs.push(arg);
      continue;
    }
    throw new Error(`Opción desconocida: ${arg}`);
  }

  const envReq = process.env.REQ_NUMBER;
  if (envReq) options.reqs.push(envReq);
  return options;
}

function loadReqs(options: Options): string[] {
  const reqs = [...options.reqs];
  if (options.file) {
    const lines = fs.readFileSync(options.file, "utf8").split(/\r?\n/);
    reqs.push(
      ...lines
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
  }

  const normalized = [...new Set(reqs.map((req) => req.toUpperCase()))];
  const invalid = normalized.filter((req) => !REQ_PATTERN.test(req));
  if (invalid.length > 0) {
    throw new Error(`REQ inválida: ${invalid.join(", ")}`);
  }
  return normalized;
}

async function isLoginPage(page: Page): Promise<boolean> {
  if (new URL(page.url()).hostname.includes("-rsso.")) return true;
  const loginButton = page.getByRole("button", { name: /iniciar sesi[oó]n/i });
  const password = page
    .getByLabel(/contrase[nñ]a|password/i)
    .or(page.locator('input[type="password"]:visible'));
  return (await loginButton.count()) > 0 || (await password.count()) > 0;
}

async function renewLogin(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log("Inicia sesión en el navegador y vuelve a esta terminal.");
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    await terminal.question("Cuando veas el catálogo, presiona Enter...");
    if (await isLoginPage(page)) {
      throw new Error("La sesión no se completó; la pantalla de acceso sigue visible");
    }
    const username = await terminal.question("Usuario para recordar (no verificado por el portal): ");
    await saveAuthSession(context, username, AUTH_FILE);
  } finally {
    terminal.close();
  }
  console.log("Sesión guardada");
}

async function assertAuthenticated(page: Page): Promise<void> {
  if (await isLoginPage(page)) {
    throw new Error("La sesión expiró.");
  }
}

function normalizeName(value: string | null): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isFinalizedStatus(status: string | null): boolean {
  return ["finalizado", "finalizada", "finalized", "completed"].includes(
    normalizeName(status),
  );
}

function isValidationComment(comment: Comment | null): boolean {
  if (!comment) return false;
  return /\b(?:en (?:proceso de )?validacion|validacion en curso|estamos validando|se inicia (?:la )?validacion|in validation|under validation|validation in progress|validating)\b/.test(
    normalizeName(comment.text),
  );
}

function uniqueAttachments(attachments: Attachment[]): Attachment[] {
  const unique = new Map<string, Attachment>();
  for (const attachment of attachments) {
    const key = attachment.url ?? attachment.name;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, attachment);
      continue;
    }
    const preferred = attachment.name.length > existing.name.length ? attachment : existing;
    unique.set(key, {
      ...preferred,
      type: attachment.type ?? existing.type,
      size: attachment.size ?? existing.size,
    });
  }
  return [...unique.values()];
}

async function openReq(page: Page, req: string): Promise<void> {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await assertAuthenticated(page);

  const search = page
    .getByRole("textbox")
    .or(page.locator('input[type="search"]'))
    .first();
  await search.waitFor({ state: "visible", timeout: 30_000 });
  await search.fill(req);
  const searchButton = page
    .getByRole("button", { name: /^(buscar|search)$/i })
    .or(page.getByText(/^(buscar|search)$/i))
    .last();
  await searchButton.click();

  await page.getByText(req, { exact: false }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });

  const details = page
    .getByRole("link", { name: /^(detalles|details)$/i })
    .or(page.locator('a[href*="#/events/details"]'))
    .last();
  if ((await details.count()) === 0) {
    throw new Error("La REQ no apareció en los resultados");
  }
  await details.click();
  await page.getByText(req, { exact: false }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByRole("heading", { name: /(comentarios|comments)/i }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

async function extractFromDom(page: Page): Promise<{
  status: string | null;
  title: string | null;
  requester: string | null;
  microservices: string[];
  pullRequestUrls: string[];
  comments: Omit<Comment, "isResponse">[];
}> {
  await page.evaluate("globalThis.__name = (target) => target");
  return page.evaluate(() => {
    const clean = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const cleanMultiline = (value: string | null | undefined): string =>
      (value ?? "")
        .split(/\r?\n/)
        .map((line) => clean(line))
        .filter(Boolean)
        .join("\n");
    const text = (element: Element | null): string => clean(element?.textContent);
    const all = [...document.querySelectorAll("body *")];
    const exact = (pattern: RegExp): Element | undefined =>
      all.find((element) => pattern.test(text(element)) && element.children.length === 0);
    const leafTexts = (element: Element): string[] =>
      [...element.querySelectorAll("*")]
        .filter((child) => child.children.length === 0)
        .map(text)
        .filter(Boolean);
    const valueAfter = (label: RegExp): string | null => {
      const element = exact(label);
      if (!element) return null;
      const sibling = element.nextElementSibling;
      if (sibling && text(sibling)) return leafTexts(sibling)[0] ?? text(sibling);
      const parent = element.parentElement;
      if (!parent) return null;
      const parts = [...parent.children].map(text).filter(Boolean);
      return parts.find((part) => !label.test(part)) ?? null;
    };
    const requesterAfter = (): string | null => {
      const requester = document.querySelector('[data-ta="headlineUserName"]');
      if (requester && text(requester)) return text(requester);
      const label = exact(/^(Petici[oó]n para|Requested? for)$/i);
      if (!label?.parentElement) return null;
      const candidates = leafTexts(label.parentElement).filter(
        (part) =>
          part.length > 1 &&
          !/^(Petici[oó]n para|Requested? for)$/i.test(part) &&
          !/^(ID de usuario|User ID)/i.test(part) &&
          !part.includes("@"),
      );
      return candidates[0] ?? null;
    };
    const extractMicroservices = (): string[] => {
      const label = exact(/^Descripci[oó]n Detallada de la Solicitud$/i);
      const description = label?.parentElement?.querySelector("dd");
      if (!description) return [];
      const matches = [...(description as HTMLElement).innerText.matchAll(
        /Microservicio(?:s|\s*\d+)?\s*:\s*([^\n\r]+)/gi,
      )];
      return [...new Set(
        matches.flatMap((match) =>
          match[1]
            .split(/[,;]/)
            .map((value) => clean(value))
            .filter(Boolean),
        ),
      )];
    };
    const extractPullRequestUrls = (): string[] => {
      const label = exact(/^Descripci[oó]n Detallada de la Solicitud$/i);
      const description = label?.parentElement?.querySelector("dd");
      if (!description) return [];
      return [...new Set(
        [...description.querySelectorAll("a[href]")]
          .map((link) => (link as HTMLAnchorElement).href)
          .filter((url) => /\/pullrequest\/\d+/i.test(url)),
      )];
    };

    const heading = all.find((element) => /^(Comentarios|Comments)\b/i.test(text(element)));
    if (!heading) {
      return {
        status: valueAfter(/^(Estado|Status)$/i),
        title: document.querySelector("h1, h2")?.textContent?.trim() ?? null,
        requester: requesterAfter(),
        microservices: extractMicroservices(),
        pullRequestUrls: extractPullRequestUrls(),
        comments: [],
      };
    }

    let section: Element = document.querySelector("dwp-comments") ?? heading;
    if (section === heading) {
      while (section.parentElement) {
        section = section.parentElement;
        const sectionText = text(section);
        if (/(Agregar comentario|Add comment)/i.test(sectionText) && section.querySelectorAll("a, button").length > 0) {
          break;
        }
      }
    }

    const datePattern = /(?:\b\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*\s+\d{4},\s*\d{1,2}:\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s+\d{4},?\s+(?:at\s+)?\d{1,2}:\d{2}(?:\s*[ap]m)?\b)/i;
    const dateElements = [...section.querySelectorAll("*")].filter(
      (element) => element.children.length === 0 && datePattern.test(text(element)),
    );

    const explicitCards = [...section.querySelectorAll(".comments__comment-block")];
    const cards: Element[] = [...explicitCards];
    if (cards.length === 0) {
      for (const dateElement of dateElements) {
        let card: Element = dateElement;
        while (card.parentElement && card.parentElement !== section) {
          const parent = card.parentElement;
          const dateCount = [...parent.querySelectorAll("*")].filter(
            (element) => element.children.length === 0 && datePattern.test(text(element)),
          ).length;
          if (dateCount !== 1 || text(parent).length > 8_000) break;
          card = parent;
        }
        if (!cards.some((existing) => existing === card || existing.contains(card))) cards.push(card);
      }
    }

    const comments = cards.map((card) => {
      const raw = clean(card.textContent);
      const date = raw.match(datePattern)?.[0] ?? null;
      const downloadLinks = [...card.querySelectorAll("a[download], [data-url], [data-href]")];
      const links = downloadLinks.length > 0
        ? downloadLinks
        : [...card.querySelectorAll("a[href]")].filter((element) => {
            const href = element.getAttribute("href") ?? "";
            return /\/file(?:\/|$)/i.test(href) || /\.(?:pdf|eml|docx?|xlsx?|pptx?|zip|txt|csv)(?:\s*\(|$)/i.test(text(element));
          });
      const attachments = links
        .map((element) => {
          const name = element.getAttribute("download") ?? text(element);
          const href =
            element.getAttribute("href") ??
            element.getAttribute("data-url") ??
            element.getAttribute("data-href");
          const url = href && !href.startsWith("javascript:")
            ? new URL(href, document.baseURI).href
            : null;
          const size = text(element).match(/\(([^)]*(?:KB|MB|GB|kB))\)/i)?.[1] ?? null;
          const fileName = clean(name.replace(/\s*\([^)]*(?:KB|MB|GB|kB)\)\s*$/i, ""));
          return { name: fileName, url, type: null, size };
        })
        .filter((attachment) => /\.[a-z0-9]{2,5}$/i.test(attachment.name) || attachment.url);

      const leafTexts = [...card.querySelectorAll("*")]
        .filter((element) => element.children.length === 0)
        .map(text)
        .filter(Boolean);
      const explicitAuthor = card.querySelector(".comments__user-name");
      const author = text(explicitAuthor) || (leafTexts.find(
        (part) =>
          part.length > 1 &&
          part !== date &&
          !/^(Agregar comentario|Add comment)$/i.test(part) &&
          !attachments.some((attachment) => part.includes(attachment.name)),
      ) ?? "Autor desconocido");
      const explicitContent = card.querySelector('[data-ta^="commentsPlainTextComment_"]');
      const content = explicitContent
        ? cleanMultiline((explicitContent as HTMLElement).innerText)
        : leafTexts
            .filter(
              (part) =>
                part !== author &&
                part !== date &&
                !attachments.some((attachment) => part.includes(attachment.name)),
            )
            .join("\n");

      return { author, date, text: content, attachments };
    });

    const titleCandidates = [...document.querySelectorAll("h1, h2, h3")]
      .map(text)
      .filter((value) => value && !/^(Detalles|Details|Comentarios|Comments)/i.test(value));

    return {
      status: valueAfter(/^(Estado|Status)$/i),
      title: titleCandidates[0] ?? null,
      requester: requesterAfter(),
      microservices: extractMicroservices(),
      pullRequestUrls: extractPullRequestUrls(),
      comments,
    };
  });
}

function findUrls(value: unknown, results: Attachment[]): void {
  if (Array.isArray(value)) {
    for (const item of value) findUrls(item, results);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const nameKeys = ["name", "fileName", "filename", "displayName", "originalName"];
  const urlKeys = ["url", "downloadUrl", "downloadURL", "href", "uri"];
  const name = nameKeys.map((key) => record[key]).find((item) => typeof item === "string");
  const url = urlKeys.map((key) => record[key]).find((item) => typeof item === "string");
  if (typeof name === "string" && typeof url === "string" && /attachment|download|file/i.test(url)) {
    results.push({
      name,
      url: new URL(url, APP_URL).href,
      type: typeof record.contentType === "string" ? record.contentType : null,
      size: typeof record.size === "string" ? record.size : null,
    });
  }
  for (const item of Object.values(record)) findUrls(item, results);
}

async function createDetailUrl(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(async () => {
      const selfLink = history.state?.selfLink;
      const resourceId = typeof selfLink === "string"
        ? selfLink.split("/").filter(Boolean).at(-1)
        : null;
      if (!resourceId) return null;

      const response = await fetch("/dwp/rest/sharehyperlink/", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Requested-By": "XMLHttpRequest",
        },
        body: JSON.stringify({
          uri: location.origin,
          resourceId,
          resourceType: "SB_REQUEST",
          providerSourceName: "srm",
        }),
      });
      if (!response.ok) return null;
      const body = await response.json() as { shareLink?: unknown };
      return typeof body.shareLink === "string" ? body.shareLink : null;
    });
  } catch {
    return null;
  }
}

async function inspectReq(page: Page, req: string): Promise<ReqResult> {
  const apiAttachments: Attachment[] = [];
  const onResponse = async (response: import("playwright").Response): Promise<void> => {
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("json")) return;
    try {
      findUrls(await response.json(), apiAttachments);
    } catch {
      // Some successful JSON responses are empty or streamed.
    }
  };
  page.on("response", onResponse);

  try {
    await openReq(page, req);
    const data = await extractFromDom(page);
    const detailUrl = await createDetailUrl(page);
    const requester = normalizeName(data.requester);
    const comments: Comment[] = data.comments.map((comment) => ({
      ...comment,
      attachments: uniqueAttachments(comment.attachments),
      isResponse: Boolean(requester) && normalizeName(comment.author) !== requester,
    }));
    const responses = comments.filter((comment) => comment.isResponse);
    const finalized = isFinalizedStatus(data.status);
    const cycle = deriveCommentCycle(comments, finalized);
    const { latestOperationsComment, requesterRepliesAfterOperations, activeDeadline } = cycle;
    const validating = isValidationComment(latestOperationsComment);
    const status = conversationStatus(cycle, finalized, validating);
    const responded = status === "Finalizada" || status === "Respondida";
    const attachments = uniqueAttachments([
      ...comments.flatMap((comment) => comment.attachments),
      ...apiAttachments,
    ]);

    return {
      req,
      checkedAt: new Date().toISOString(),
      responded,
      conversationStatus: status,
      status: data.status,
      title: data.title,
      requester: data.requester,
      microservices: data.microservices,
      pullRequestUrls: data.pullRequestUrls,
      detailUrl,
      latestOperationsComment,
      activeDeadline,
      requesterRepliesAfterOperations,
      latestResponse: cycle.orderKnown ? cycle.orderedComments.filter((comment) => comment.isResponse).at(-1) ?? null : null,
      responses,
      comments,
      attachments,
    };
  } finally {
    page.off("response", onResponse);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const storageStateExists = fs.existsSync(AUTH_FILE);
  if (!options.login && !storageStateExists) {
    throw new Error(`No existe ${AUTH_FILE}. Ejecuta: pnpm run auth`);
  }

  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const context = await browser.newContext({
      ...(storageStateExists ? { storageState: AUTH_FILE } : {}),
      acceptDownloads: false,
    });

    if (options.login) {
      await renewLogin(context);
      return;
    }

    const reqs = loadReqs(options);
    if (reqs.length === 0) {
      throw new Error("Indica --req, --file o REQ_NUMBER");
    }

    const page = await context.newPage();
    const results: ReqResult[] = [];
    for (const req of reqs) {
      console.log(`Consultando ${req}...`);
      try {
        results.push(await inspectReq(page, req));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          req,
          checkedAt: new Date().toISOString(),
          responded: false,
          conversationStatus: "Sin comentario de operaciones",
          status: null,
          title: null,
          requester: null,
          microservices: [],
          pullRequestUrls: [],
          detailUrl: null,
          latestOperationsComment: null,
          activeDeadline: null,
          requesterRepliesAfterOperations: [],
          latestResponse: null,
          responses: [],
          comments: [],
          attachments: [],
          error: message,
        });
        console.error(`${req}: ${message}`);
        if (/sesi[oó]n expir[oó]/i.test(message)) break;
      }
    }

    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    console.log(`Resultado guardado en ${options.output}`);
    if (results.some((result) => result.error)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
