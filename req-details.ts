export type LabeledField = { label: string; value: string };

/** Browser-serializable: keep dependencies inside this function for page.evaluate. */
export function extractPortalFieldsFromDom(): {
  fields: LabeledField[];
  descriptionLinks: string[];
  headlineRequester: string | null;
} {
  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const labelPattern = /^(?:Descripci[oó]n Detallada de la Solicitud|Detailed Request Description|Instrucciones|Instructions|Petici[oó]n para|Requested? for|Solicitante|Requester|Correo electr[oó]nico|Email|E-mail|Tel[eé]fono|N[uú]mero de tel[eé]fono|Pedido para tel[eé]fono|N[uú]mero de Contacto|Phone|Phone number|Enviado|Fecha de env[ií]o|Sent|Submitted(?: on)?|[uÚ]ltima actualizaci[oó]n|Fecha de actualizaci[oó]n|Last updated|Updated|Tipo de operaci[oó]n|Operation type|Aplicaci[oó]n|Application|Tipo de solicitud|Request type|Tipo de cliente|Client type)$/i;
  const fields: LabeledField[] = [];
  const excludedValues: Element[] = [];
  let descriptionLinks: string[] = [];
  const visibleText = (element: Element): string =>
    (element as HTMLElement).innerText ?? element.textContent ?? "";
  const detailContainers = document.querySelectorAll("dwp-event-details");

  const isVisibleHeader = (element: Element): boolean =>
    (element as HTMLElement).getClientRects().length > 0 &&
    !element.closest("dwp-comments, .comments__comment-block");
  const statusCandidates: string[] = [];
  if (detailContainers.length > 0) {
    for (const wrapper of document.querySelectorAll('[data-ta="headlineItemWrapper"]')) {
      if (!isVisibleHeader(wrapper)) continue;
      const labels = [...wrapper.children].filter((child) =>
        !child.matches("p.headline-item__description") && isVisibleHeader(child));
      if (labels.length !== 1 || !/^(?:Status|Estado):?$/i.test(clean(visibleText(labels[0])))) continue;
      const values = [...wrapper.querySelectorAll("p.headline-item__description")].filter(isVisibleHeader);
      if (values.length !== 1) {
        statusCandidates.push(""); // Ambiguous labeled header must not yield a status.
        continue;
      }
      statusCandidates.push(clean(visibleText(values[0])));
    }
    for (const element of document.querySelectorAll('p[data-ta="coloredMediaHeaderParagraph_0"]')) {
      if (isVisibleHeader(element)) statusCandidates.push(clean(visibleText(element)));
    }
  }
  if (statusCandidates.length > 0 && statusCandidates.every((value) => value === statusCandidates[0])) {
    fields.push({ label: "Status", value: statusCandidates[0] });
  }

  // Accept an ID only from a compact, unambiguous name + label + value header.
  const names = [...document.querySelectorAll('[data-ta="headlineUserName"]')]
    .filter((name) => !name.closest("dwp-event-details, dwp-comments, .comments__comment-block"));
  if (detailContainers.length > 0 && names.length === 1) {
    const name = names[0];
    const siblings = [...(name.parentElement?.children ?? [])];
    if (siblings.length === 3 && siblings[0] === name &&
        /^(?:ID de usuario|User ID):?$/i.test(clean(siblings[1].textContent)) &&
        siblings[1].children.length === 0 && siblings[2].children.length === 0) {
      const value = clean(visibleText(siblings[2]));
      if (value && value.length <= 256) fields.push({ label: "User ID", value });
    }
  }

  for (const element of [...detailContainers].flatMap((container) => [...container.querySelectorAll("*")])) {
    if (excludedValues.some((value) => value.contains(element)) ||
        element.closest("dwp-comments, .comments__comment-block") ||
        (element as HTMLElement).getClientRects().length === 0) continue;
    // Labels must be standalone nodes in a structural label/value pair.
    // Never interpret an inline "Estado: ..." in descriptions or comments.
    const label = clean(element.textContent).replace(/:\s*$/, "");
    if (!labelPattern.test(label)) continue;
    const dt = element.closest("dt");
    let valueElement: Element | null = null;
    if (dt && dt.textContent && labelPattern.test(clean(dt.textContent).replace(/:\s*$/, ""))) {
      valueElement = dt.nextElementSibling?.tagName.toLowerCase() === "dd" ? dt.nextElementSibling : null;
    } else if (element.parentElement?.children.length === 2 && element.parentElement.firstElementChild === element) {
      valueElement = element.nextElementSibling;
    }
    if (!valueElement || valueElement.contains(element) ||
        valueElement.closest("dwp-comments, .comments__comment-block")) continue;
    const value = visibleText(valueElement);
    if (!value.trim() || labelPattern.test(clean(value))) continue;
    fields.push({ label, value });
    excludedValues.push(valueElement);
    if (/^(Descripci[oó]n Detallada de la Solicitud|Detailed Request Description)$/i.test(label)) {
      descriptionLinks = [...valueElement.querySelectorAll("a[href]")]
        .map((link) => (link as HTMLAnchorElement).href).slice(0, 50);
    }
  }
  return {
    fields,
    descriptionLinks,
    headlineRequester: document.querySelector('[data-ta="headlineUserName"]')?.textContent ?? null,
  };
}

export type ReqDetails = {
  status: string | null;
  description: string | null;
  instructions: string | null;
  requester: string | null;
  requesterUserId: string | null;
  requesterEmail: string | null;
  requesterPhone: string | null;
  sentAt: string | null;
  updatedAt: string | null;
  requestDetails: {
    operationType: string | null;
    application: string | null;
    requestType: string | null;
    clientType: string | null;
  };
  microservices: string[];
  pullRequestUrls: string[];
};

const limits = { short: 256, long: 100_000 };

function plain(value: string | undefined, limit: number): string | null {
  const text = (value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t \u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (text.length > limit) return `${text.slice(0, limit)}\n[Truncated: content exceeds ${limit} characters]`;
  return text || null;
}

function key(label: string): string {
  return label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().replace(/:$/, "").toLowerCase();
}

function microservices(description: string | null): string[] {
  if (!description) return [];
  const names = new Set<string>();
  for (const line of description.split("\n")) {
    const bullet = line.match(/^\s*[•*\-]\s*Nombre de microservicio\.\s*([\p{L}\p{N}_][\p{L}\p{N}_.-]{1,99})\s*$/iu);
    if (bullet) {
      names.add(bullet[1]);
      continue;
    }
    const match = line.match(/^\s*(?:nombre de(?:l)? )?microservicios?(?:\s+\d+)?\s*[:.]\s*(.+)$/i);
    if (!match) continue;
    for (const part of match[1].split(/[,;]|\s+y\s+/i)) {
      const name = part.trim();
      if (/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{1,99}$/u.test(name)) names.add(name);
    }
  }
  return [...names].slice(0, 50);
}

/** Interpret only labels observed on the request, never conversation content. */
export function parseReqDetails(input: {
  fields: LabeledField[];
  descriptionLinks?: string[];
  headlineRequester?: string | null;
}): ReqDetails {
  const fields = new Map<string, string>();
  for (const field of input.fields) {
    const label = key(field.label);
    if (!fields.has(label) && field.value.trim()) fields.set(label, field.value);
  }
  const get = (labels: string[], limit = limits.short): string | null => {
    for (const label of labels) {
      const value = plain(fields.get(label), limit);
      if (value) return value;
    }
    return null;
  };
  const description = get(["descripcion detallada de la solicitud", "detailed request description"], limits.long);
  return {
    status: get(["estado", "status"]),
    description,
    instructions: get(["instrucciones", "instructions"], limits.long),
    requester: get(["peticion para", "requested for", "request for", "solicitante", "requester"]) ?? plain(input.headlineRequester ?? undefined, limits.short),
    requesterUserId: get(["id de usuario", "user id", "identificador de usuario"]),
    requesterEmail: get(["correo electronico", "email", "e-mail"]),
    requesterPhone: get(["telefono", "numero de telefono", "pedido para telefono", "numero de contacto", "phone", "phone number"]),
    sentAt: get(["enviado", "fecha de envio", "sent", "submitted", "submitted on"]),
    updatedAt: get(["ultima actualizacion", "fecha de actualizacion", "last updated", "updated"]),
    requestDetails: {
      operationType: get(["tipo de operacion", "operation type"]),
      application: get(["aplicacion", "application"]),
      requestType: get(["tipo de solicitud", "request type"]),
      clientType: get(["tipo de cliente", "client type"]),
    },
    microservices: microservices(description),
    pullRequestUrls: [...new Set((input.descriptionLinks ?? []).filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && /\/pullrequest\/\d+/i.test(parsed.pathname);
      } catch { return false; }
    }))].slice(0, 50),
  };
}
