import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTeamsPayload, processReqResult, reminderDay } from "../monitor-req.ts";
import { deriveCommentCycle } from "../deadline.ts";

const due = { dueAt: "2026-10-10T04:59:00.000Z", sourceKey: "operations-cycle-1" };
const result = {
  req: "REQ123", checkedAt: "2026-10-09T13:00:00.000Z", conversationStatus: "Pendiente de respuesta" as const,
  status: "Open", title: null, microservices: [], pullRequestUrls: [], detailUrl: null,
  latestOperationsComment: { author: "Operations", date: "9 oct 2026, 08:00", text: "Before 09/10/2026", attachments: [] },
  activeDeadline: due,
};

test("Teams shows the signed Operations reviewer without changing the stored author or alert key", async () => {
  const signed = { ...result, latestOperationsComment: {
    ...result.latestOperationsComment, author: "Profile Owner",
    text: "Please review.\n--Revisa: Cesar Carreño\nBefore 09/10/2026",
  } };
  const messages: string[] = [];
  await processReqResult(signed, undefined, new Date("2026-10-09T13:00:00Z"), false,
    async (message) => { messages.push(message); });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Operaciones: Cesar Carreño/);
  assert.equal(signed.latestOperationsComment.author, "Profile Owner");
});

test("deadline reminders and proximity cards include the available request and Operations context", async () => {
  const detailed = { ...result, title: "Service validation", projectName: "Alpha", microservices: ["Payments"],
    latestOperationsComment: { ...result.latestOperationsComment, text: "Please provide evidence." } };
  const previous = { conversationStatus: detailed.conversationStatus, lastChecked: detailed.checkedAt,
    lastNotified: detailed.checkedAt,
    latestOperationsCommentKey: "Operations|9 oct 2026, 08:00|Please provide evidence." };
  for (const [now, heading] of [
    ["2026-10-08T13:00:00Z", "Recordatorio: REQ pendiente de respuesta"],
    ["2026-10-09T13:00:00Z", "Plazo próximo"],
  ]) {
    const sent: string[] = [];
    await processReqResult(detailed, previous, new Date(now), false, async (message) => { sent.push(message); });
    assert.equal(sent.length, 1);
    assert.match(sent[0], new RegExp(`^${heading}: REQ123\\n`));
    for (const item of ["Título: Service validation", "Proyecto: Alpha", "Microservicio: Payments",
      "Estado del portal: Open", "Operaciones: Operations", "Plazo indicado:", "Comentario:\nPlease provide evidence."]) {
      assert.ok(sent[0].includes(item), `missing ${item.split(":")[0]}`);
    }
    const card = buildTeamsPayload(sent[0], "https://portal.example/req123", []) as { attachments: { content: {
      body: { type: string; facts?: { title: string; value: string }[]; items?: { text: string }[] }[] } }[] };
    const body = card.attachments[0].content.body;
    assert.ok(body.find((block) => block.type === "FactSet")?.facts?.some((fact) => fact.title === "Proyecto" && fact.value === "Alpha"));
    assert.ok(body.some((block) => block.items?.some((item) => item.text === "Please provide evidence.")));
  }
});

test("answered REQ sends a resolution update once after a pending Teams alert", async () => {
  const sent: string[] = [];
  const send = async (message: string) => { sent.push(message); };
  const now = new Date("2026-10-09T13:15:00Z");
  const pending = await processReqResult(result, undefined, now, false, send);
  assert.equal(sent.length, 1);
  const answered = { ...result, conversationStatus: "Respondida" as const, checkedAt: "2026-10-09T13:20:00.000Z" };
  const resolved = await processReqResult(answered, pending, now, false, send);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /^REQ respondida por el solicitante: REQ123/);
  assert.equal(resolved.conversationStatus, "Respondida");
  await processReqResult(answered, resolved, now, false, send);
  assert.equal(sent.length, 2);
  await processReqResult(answered, undefined, now, false, send);
  assert.equal(sent.length, 2, "no resolution notice when no prior pending alert exists");
});

test("a new undated Operations comment alerts once even when the portal is still pending", async () => {
  const now = new Date("2026-11-10T18:46:50Z");
  const operations = { ...result.latestOperationsComment, date: null, text: "New observation" };
  const updated = { ...result, status: "Pendiente", conversationStatus: "Respondida" as const,
    latestOperationsComment: operations, activeDeadline: null };
  const previous = { conversationStatus: "Respondida" as const, lastChecked: result.checkedAt,
    lastNotified: result.checkedAt, latestOperationsCommentKey: "Operations||Prior observation" };
  const messages: string[] = [];
  const send = async (message: string) => { messages.push(message); };
  const notified = await processReqResult(updated, previous, now, false, send);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^Nuevo comentario de Operaciones: REQ123/);
  assert.match(messages[0], /Estado del portal: Pendiente/);
  const card = buildTeamsPayload(messages[0], "https://portal.example/req123", []) as { attachments: { content: {
    body: { items?: { text: string }[] }[] } }[] };
  assert.equal(card.attachments[0].content.body[0].items?.[0]?.text, "Nuevo comentario de Operaciones");
  assert.equal(notified.lastNotified, now.toISOString());
  await processReqResult(updated, notified, now, false, send);
  assert.equal(messages.length, 1);
});

test("a recovered date is not a new comment; identical repeated comments have separate occurrences", async () => {
  const firstComment = { ...result.latestOperationsComment, date: null, text: "Repeat", isResponse: true };
  const requester = { author: "Requester", date: null, text: "Initial request", isResponse: false };
  const answered = { ...result, conversationStatus: "Respondida" as const, status: "Pendiente", activeDeadline: null,
    latestOperationsComment: firstComment, comments: [firstComment, requester] };
  const previous = { conversationStatus: "Respondida" as const, lastChecked: result.checkedAt,
    lastNotified: result.checkedAt, latestOperationsCommentKey: "Operations||Repeat" };
  const sent: string[] = [];
  const send = async (message: string) => { sent.push(message); };
  const now = new Date("2026-11-10T18:46:50Z");
  const baseline = await processReqResult(answered, previous, now, false, send);
  assert.equal(sent.length, 0, "do not backfill an existing comment on upgrade");
  const recovered = { ...firstComment, date: "9 nov 2026, 18:02" };
  const dated = await processReqResult({ ...answered, latestOperationsComment: recovered,
    comments: [recovered, requester] }, baseline, now, false, send);
  assert.equal(sent.length, 0, "recovering a timestamp is not a new Operations reply");
  const repeated = await processReqResult({ ...answered, latestOperationsComment: recovered,
    comments: [recovered, requester, recovered] }, dated, now, false, send);
  assert.equal(sent.length, 1, "a separate comment with identical text must alert once");
  await processReqResult({ ...answered, latestOperationsComment: recovered,
    comments: [recovered, requester, recovered] }, repeated, now, false, send);
  assert.equal(sent.length, 1);
});

test("disabled or failed Operations alerts stay retryable without sending or advancing delivery", async () => {
  const previous = { conversationStatus: "Respondida" as const, lastChecked: result.checkedAt,
    lastNotified: result.checkedAt, latestOperationsCommentKey: "Operations||Old" };
  const updated = { ...result, conversationStatus: "Respondida" as const, activeDeadline: null,
    latestOperationsComment: { ...result.latestOperationsComment, date: null, text: "New" } };
  const now = new Date("2026-11-10T18:46:50Z");
  const disabled = await processReqResult(updated, previous, now, false, async () => {
    throw Error("disabled must not send");
  }, false);
  assert.equal(disabled.lastNotified, undefined);
  await assert.rejects(processReqResult(updated, disabled, now, false, async () => {
    throw Error("Teams failed");
  }), /Teams failed/);
  const sent: string[] = [];
  const delivered = await processReqResult(updated, disabled, now, false, async (message) => { sent.push(message); });
  assert.equal(sent.length, 1);
  assert.equal(delivered.lastNotified, now.toISOString());
});

test("queued Operations alert takes priority over a simultaneous morning reminder", async () => {
  const now = new Date("2026-10-09T13:15:00Z");
  const key = "Operations|9 oct 2026, 08:00|Before 09/10/2026";
  const previous = { conversationStatus: "Pendiente de respuesta" as const, lastChecked: result.checkedAt,
    lastNotified: "2026-10-08T13:15:00Z", latestOperationsCommentKey: key,
    unnotifiedOperationsCommentKey: key,
    lastReminder: { sourceKey: "operations-cycle-1", day: "2026-10-08" } };
  const sent: string[] = [];
  const next = await processReqResult(result, previous, now, false, async (message) => { sent.push(message); });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Nuevo comentario de Operaciones: REQ123/);
  assert.doesNotMatch(sent[0], /^Recordatorio:/);
  assert.equal(next.unnotifiedOperationsCommentKey, undefined);
  assert.equal(next.lastNotified, now.toISOString());
  await processReqResult(result, next, now, false, async (message) => { sent.push(message); });
  assert.equal(sent.length, 1);
});

test("warns once in the final 24 hours and suppresses the generic reminder that day", async () => {
  const messages: string[] = [];
  const send = async (message: string) => { messages.push(message); };
  const key = "Operations|9 oct 2026, 08:00|Before 09/10/2026";
  const prior = { conversationStatus: "Pendiente de respuesta" as const, lastChecked: result.checkedAt,
    lastNotified: "2026-10-08T13:00:00.000Z", latestOperationsCommentKey: key };
  const early = new Date("2026-10-08T04:58:00Z");
  const before = await processReqResult(result, prior, early, false, send);
  assert.equal(messages.length, 0);
  const morning = new Date("2026-10-09T13:00:00Z");
  const warned = await processReqResult(result, before, morning, false, send);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^Plazo próximo: REQ123/);
  assert.match(messages[0], /Plazo indicado:/);
  const card = buildTeamsPayload(messages[0], "https://portal.example/req123", []) as { attachments: { content: {
    body: { items?: { text: string }[]; type: string; facts?: { title: string; value: string }[] }[] } }[] };
  assert.equal(card.attachments[0].content.body[0].items?.[0]?.text, "⚠ Plazo próximo");
  assert.ok(card.attachments[0].content.body.find((item) => item.type === "FactSet")?.facts?.some((fact) =>
    fact.title === "Plazo indicado"));
  assert.equal(warned.lastProximity?.sourceKey, due.sourceKey);
  assert.equal(warned.lastReminder?.day, "2026-10-09");
  await processReqResult(result, warned, morning, false, send);
  assert.equal(messages.length, 1);
  const changedDeadline = { ...result, activeDeadline: { ...due, sourceKey: "new-cycle" } };
  await processReqResult(changedDeadline, warned, morning, false, send);
  assert.match(messages.at(-1) ?? "", /^Plazo próximo: REQ123/);
});

test("proximity never sends for date-only, inactive, past, disabled, failed, or dry-run delivery", async () => {
  const now = new Date("2026-10-09T13:00:00Z");
  const prior = { conversationStatus: "Pendiente de respuesta" as const, lastChecked: result.checkedAt,
    lastNotified: "2026-10-08T13:00:00.000Z",
    latestOperationsCommentKey: "Operations|9 oct 2026, 08:00|Before 09/10/2026",
    lastReminder: { sourceKey: due.sourceKey, day: "2026-10-09" } };
  const sent: string[] = [];
  const send = async (message: string) => { sent.push(message); };
  for (const candidate of [
    { ...result, activeDeadline: null },
    { ...result, activeDeadline: { ...due, dueAt: "2026-10-08T04:59:00Z" } },
    { ...result, conversationStatus: "Respondida" as const },
  ]) {
    await processReqResult(candidate, candidate.conversationStatus === "Respondida"
      ? { ...prior, conversationStatus: "Respondida" as const } : prior, now, false, send);
  }
  assert.equal(sent.length, 0);
  const notifyPrior = { ...prior, lastReminder: { sourceKey: due.sourceKey, day: "2026-10-08" } };
  const disabled = await processReqResult(result, notifyPrior, now, false, async () => {
    throw Error("disabled must not send");
  }, false);
  assert.equal(disabled.lastProximity, undefined);
  await assert.rejects(processReqResult(result, disabled, now, false, async () => {
    throw Error("Teams failed");
  }), /Teams failed/);
  const simulated = await processReqResult(result, disabled, now, true, send);
  assert.equal(simulated.lastProximity, undefined);
  const delivered = await processReqResult(result, disabled, now, false, send);
  assert.equal(delivered.lastProximity?.sourceKey, due.sourceKey);
});

test("an early proximity alert does not produce a morning reminder on the same Colombia day", async () => {
  const sent: string[] = [];
  const prior = { conversationStatus: "Pendiente de respuesta" as const, lastChecked: result.checkedAt,
    lastNotified: "2026-10-08T13:00:00.000Z",
    latestOperationsCommentKey: "Operations|9 oct 2026, 08:00|Before 09/10/2026" };
  const early = await processReqResult(result, prior, new Date("2026-10-09T12:00:00Z"), false,
    async (message) => { sent.push(message); });
  assert.match(sent[0] ?? "", /^Plazo próximo: REQ123/);
  assert.equal(early.lastReminder?.day, "2026-10-09");
  await processReqResult(result, early, new Date("2026-10-09T13:00:00Z"), false,
    async (message) => { sent.push(message); });
  assert.equal(sent.length, 1);
});

test("a newly pending REQ already near its deadline includes the warning in its first Teams alert", async () => {
  const messages: string[] = [];
  const now = new Date("2026-10-09T13:00:00Z");
  const first = await processReqResult(result, undefined, now, false, async (message) => { messages.push(message); });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^REQ pendiente de respuesta: REQ123/);
  assert.match(messages[0], /vence en menos de 24 horas/i);
  const card = buildTeamsPayload(messages[0], "https://portal.example/req123", []) as { attachments: { content: {
    body: { type: string; facts?: { title: string; value: string }[]; text?: string }[] } }[] };
  assert.ok(card.attachments[0].content.body.find((item) => item.type === "FactSet")?.facts?.some((fact) =>
    fact.title === "Plazo indicado"));
  assert.ok(card.attachments[0].content.body.some((item) => item.text?.includes("vence en menos de 24 horas")));
  assert.equal(first.lastProximity?.sourceKey, due.sourceKey);
  await processReqResult(result, first, now, false, async (message) => { messages.push(message); });
  assert.equal(messages.length, 1);
});

test("exactly 24 hours qualifies, while an Operations alert carries proximity only once", async () => {
  const now = new Date("2026-10-09T13:00:00Z");
  const prior = { conversationStatus: "Pendiente de respuesta" as const, lastChecked: result.checkedAt,
    lastNotified: "2026-10-08T13:00:00Z",
    latestOperationsCommentKey: "Operations|9 oct 2026, 08:00|Before 09/10/2026" };
  const messages: string[] = [];
  const send = async (message: string) => { messages.push(message); };
  const exactDeadline = { dueAt: "2026-10-10T13:00:00Z", sourceKey: "exact" };
  const boundary = await processReqResult({ ...result, activeDeadline: exactDeadline }, prior, now, false, send);
  assert.match(messages[0], /^Plazo próximo: REQ123/);
  assert.equal(boundary.lastProximity?.sourceKey, exactDeadline.sourceKey);
  messages.length = 0;
  const shared = await processReqResult({ ...result, activeDeadline: exactDeadline },
    { ...prior, unnotifiedOperationsCommentKey: prior.latestOperationsCommentKey }, now, false, send);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^Nuevo comentario de Operaciones: REQ123/);
  assert.match(messages[0], /vence en menos de 24 horas/i);
  assert.equal(shared.lastProximity?.sourceKey, exactDeadline.sourceKey);
  await processReqResult({ ...result, activeDeadline: exactDeadline }, shared, now, false, send);
  assert.equal(messages.length, 1);
});

test("Teams card separates readable facts from comments and uses answered status", () => {
  const payload = buildTeamsPayload(
    "REQ respondida por el solicitante: REQ123\nTítulo: Seguimiento\nProyecto: Portal\nEstado del portal: En curso\n\nComentario:\nEl solicitante confirmó la respuesta.\n\nAbrir REQ: https://portal.example/req123",
    "https://portal.example/req123", [],
  ) as { attachments: { content: { body: { type: string; text?: string; items?: { text: string }[]; facts?: { title: string; value: string }[] }[];
    actions: { title: string; url: string }[] } }[] };
  const card = payload.attachments[0].content;
  assert.equal(card.body[0].items?.[0]?.text, "✓ REQ respondida");
  assert.deepEqual(card.body.find((block) => block.type === "FactSet")?.facts, [
    { title: "Título", value: "Seguimiento" }, { title: "Proyecto", value: "Portal" },
    { title: "Estado del portal", value: "En curso" },
  ]);
  assert.ok(card.body.some((block) => block.items?.some((item) => item.text?.includes("El solicitante confirmó la respuesta."))));
  assert.equal(card.actions[0].url, "https://portal.example/req123");
  assert.ok(!card.body.some((block) => block.text?.includes("Abrir REQ:")), "avoid repeating action link in body");
});

test("finalized Teams cards show a distinct outcome without treating unknown as successful", async () => {
  const sent: string[] = [];
  const final = { ...result, status: "Finalizado", conversationStatus: "Finalizada" as const,
    activeDeadline: null, latestOperationsComment: { ...result.latestOperationsComment,
      text: "Se procede al cierre debido a que no cuenta con la información necesaria. Favor incluir el SSD en .md." } };
  const now = new Date("2026-11-11T20:00:00Z");
  const send = async (message: string) => { sent.push(message); };
  const next = await processReqResult(final, undefined, now, false, send);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Resultado del cierre: Cerrada con observaciones/);
  const card = buildTeamsPayload(sent[0], "https://portal.example/req123", []) as { attachments: { content: {
    body: { type: string; style?: string; color?: string; text?: string; items?: { text: string }[];
      facts?: { title: string; value: string }[] }[]; actions: { title: string; url: string }[] } }[] };
  const content = card.attachments[0].content;
  assert.equal(content.body[0].style, "warning");
  assert.match(content.body[0].items?.[0]?.text ?? "", /Cerrada con observaciones/);
  assert.ok(content.body.find((item) => item.type === "FactSet")?.facts?.some((fact) =>
    fact.title === "Resultado del cierre" && fact.value === "Cerrada con observaciones"));
  assert.equal(content.actions[0].url, "https://portal.example/req123");
  assert.ok(content.body.some((item) => item.items?.some((part) => part.text?.includes("SSD en .md"))));
  assert.ok(content.body.some((item) => item.text?.includes("Revise las observaciones")));
  await processReqResult(final, next, now, false, send);
  assert.equal(sent.length, 1, "the closing comment must not produce a second notification");

  const unknown = await processReqResult({ ...final, latestOperationsComment: null }, undefined, now, false, send);
  assert.equal(unknown.conversationStatus, "Finalizada");
  const unknownCard = buildTeamsPayload(sent[1], "https://portal.example/req123", []) as typeof card;
  assert.equal(unknownCard.attachments[0].content.body[0].style, "emphasis");
  assert.match(unknownCard.attachments[0].content.body[0].items?.[0]?.text ?? "", /sin resultado claro/);
});

test("morning uses Colombia's local day, not the host timezone or UTC day", () => {
  assert.equal(reminderDay(new Date("2026-10-09T12:59:59Z")), null);
  assert.equal(reminderDay(new Date("2026-10-09T13:00:00Z")), "2026-10-09");
  assert.equal(reminderDay(new Date("2026-10-09T16:59:00Z")), "2026-10-09");
  assert.equal(reminderDay(new Date("2026-10-09T17:01:00Z")), null);
  assert.equal(reminderDay(new Date("2026-10-10T04:00:00Z")), null);
});

test("reminder sends once per local day and cycle, resuming next morning or reopened cycle", async () => {
  const sent: string[] = [];
  const send = async (message: string) => { sent.push(message); };
  const morning = new Date("2026-10-09T13:15:00Z");
  const first = await processReqResult(result, {
    conversationStatus: "Pendiente de respuesta", lastChecked: result.checkedAt,
    lastNotified: result.checkedAt, latestOperationsCommentKey: "Operations|9 oct 2026, 08:00|Before 09/10/2026",
  }, morning, false, send);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /plazo próximo/i);
  assert.deepEqual(first.lastReminder, { sourceKey: due.sourceKey, day: "2026-10-09" });
  await processReqResult(result, first, new Date("2026-10-09T13:30:00Z"), false, send);
  assert.equal(sent.length, 1);
  await processReqResult(result, first, new Date("2026-10-13T13:00:00Z"), false, send);
  assert.equal(sent.length, 2);
  await processReqResult({ ...result, activeDeadline: { ...due, sourceKey: "operations-cycle-2" } }, first, morning, false, send);
  assert.equal(sent.length, 3);
});

test("no reminder for unknown, answered, finalized, afternoon, or a pending change alert in same run", async () => {
  const sent: string[] = [];
  const send = async (message: string) => { sent.push(message); };
  const morning = new Date("2026-10-09T13:15:00Z");
  const previous = { conversationStatus: result.conversationStatus, lastChecked: result.checkedAt,
    lastNotified: result.checkedAt, latestOperationsCommentKey: "Operations|9 oct 2026, 08:00|Before 09/10/2026" };
  for (const item of [
    { ...result, activeDeadline: null },
    { ...result, conversationStatus: "Respondida" as const, activeDeadline: due },
    { ...result, conversationStatus: "Finalizada" as const, activeDeadline: due },
  ]) {
    await processReqResult(item, previous, morning, false, send);
  }
  assert.equal(sent.length, 2); // answered and finalized change notifications, no reminders
  assert.ok(sent.every((message) => !/recordatorio/i.test(message)));
  const pendingState = await processReqResult(result, undefined, morning, false, send);
  assert.equal(sent.length, 3); // pending change notification, no reminder
  assert.deepEqual(pendingState.lastReminder, { sourceKey: due.sourceKey, day: "2026-10-09" });
  await processReqResult(result, pendingState, new Date("2026-10-09T13:30:00Z"), false, send);
  assert.equal(sent.length, 3); // successful change alert covers this morning
  await processReqResult(result, undefined, new Date("2026-10-09T19:00:00Z"), false, send);
  assert.equal(sent.length, 4); // pending change notification outside morning remains intact
});

test("failed delivery is retryable; dry runs never mark reminder delivered", async () => {
  const previous = { conversationStatus: result.conversationStatus, lastChecked: result.checkedAt,
    lastNotified: result.checkedAt, latestOperationsCommentKey: "Operations|9 oct 2026, 08:00|Before 09/10/2026" };
  const morning = new Date("2026-10-09T13:15:00Z");
  await assert.rejects(processReqResult(result, previous, morning, false, async () => { throw Error("Teams unavailable"); }));
  const dry = await processReqResult(result, previous, morning, true, async () => {});
  assert.equal(dry.lastReminder, undefined);
  const sent = await processReqResult(result, previous, morning, false, async () => {});
  assert.deepEqual(sent.lastReminder, { sourceKey: due.sourceKey, day: "2026-10-09" });
});

test("disabled delivery persists pending observation and alerts once when enabled", async () => {
  const now = new Date("2026-10-09T13:15:00Z");
  const sent: string[] = [];
  const send = async (message: string) => { sent.push(message); };
  const disabled = await processReqResult(result, undefined, now, false, send, false);
  assert.equal(sent.length, 0);
  assert.equal(disabled.conversationStatus, result.conversationStatus);
  assert.equal(disabled.latestOperationsCommentKey, "Operations|9 oct 2026, 08:00|Before 09/10/2026");
  assert.equal(disabled.lastNotified, undefined);
  assert.equal(disabled.lastReminder, undefined);
  const unchanged = await processReqResult(result, disabled, now, false, send, false);
  assert.equal(sent.length, 0);
  const enabled = await processReqResult(result, unchanged, now, false, send);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /REQ pendiente de respuesta/);
  assert.deepEqual(enabled.lastReminder, { sourceKey: due.sourceKey, day: "2026-10-09" });
  await processReqResult(result, enabled, now, false, send);
  assert.equal(sent.length, 1);
});

test("project is included in optional Teams alerts without enabling delivery or changing deduplication", async () => {
  const item = { ...result, projectName: "Proyecto Sintético", microservices: ["servicio-demo"] };
  const now = new Date("2026-10-09T13:15:00Z");
  const messages: string[] = [];
  const send = async (message: string) => { messages.push(message); };
  const disabled = await processReqResult(item, undefined, now, false, send, false);
  assert.equal(messages.length, 0);
  assert.equal(disabled.lastNotified, undefined);
  const enabled = await processReqResult(item, disabled, now, false, send);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Proyecto: Proyecto Sintético/);
  assert.match(messages[0], /Microservicio: servicio-demo/);
  await processReqResult(item, enabled, now, false, send);
  assert.equal(messages.length, 1);
  const absent: string[] = [];
  await processReqResult({ ...item, projectName: null }, undefined, now, false, async (message) => { absent.push(message); });
  assert.doesNotMatch(absent[0], /Proyecto:/);
});

test("disabled changed pending comment clears old delivery; failed reenable remains retryable", async () => {
  const now = new Date("2026-10-09T19:00:00Z");
  const previous = { conversationStatus: result.conversationStatus, lastChecked: result.checkedAt,
    lastNotified: result.checkedAt, latestOperationsCommentKey: "old comment" };
  const disabled = await processReqResult(result, previous, now, false, async () => {
    throw Error("send should not run");
  }, false);
  assert.equal(disabled.lastNotified, undefined);
  await assert.rejects(processReqResult(result, disabled, now, false, async () => {
    throw Error("Teams unavailable");
  }), /Teams unavailable/);
  const sent: string[] = [];
  const delivered = await processReqResult(result, disabled, now, false, async (message) => { sent.push(message); });
  assert.equal(sent.length, 1);
  assert.equal(delivered.lastNotified, now.toISOString());
});

test("disabled finalized status sends once when webhook becomes available", async () => {
  const finalized = { ...result, conversationStatus: "Finalizada" as const, activeDeadline: null };
  const now = new Date("2026-10-09T19:00:00Z");
  const disabled = await processReqResult(finalized, undefined, now, false, async () => {
    throw Error("send should not run");
  }, false);
  assert.equal(disabled.lastNotified, undefined);
  const sent: string[] = [];
  const send = async (message: string) => { sent.push(message); };
  const enabled = await processReqResult(finalized, disabled, now, false, send);
  assert.match(sent[0], /REQ finalizada/);
  await processReqResult(finalized, enabled, now, false, send);
  assert.equal(sent.length, 1);
});

test("dry run simulates pending alert without webhook and leaves it retryable", async () => {
  const now = new Date("2026-10-09T13:15:00Z");
  const sent: string[] = [];
  const simulated = await processReqResult(result, undefined, now, true, async (message) => {
    sent.push(message);
  }, true);
  assert.equal(sent.length, 1);
  assert.equal(simulated.lastNotified, undefined);
  assert.equal(simulated.lastReminder, undefined);
});

test("weekends and Colombian public holidays suppress reminders, not pending or finalized alerts", async () => {
  const previous = { conversationStatus: result.conversationStatus, lastChecked: result.checkedAt,
    lastNotified: result.checkedAt, latestOperationsCommentKey: "Operations|9 oct 2026, 08:00|Before 09/10/2026" };
  const sent: string[] = [];
  const send = async (message: string) => { sent.push(message); };
  for (const day of ["2026-10-10", "2026-10-12"]) { // Saturday; Columbus Day (observed Monday)
    const now = new Date(`${day}T13:15:00Z`);
    assert.equal(reminderDay(now), null);
    await processReqResult(result, previous, now, false, send);
    assert.equal(sent.length, 0);
    await processReqResult(result, undefined, now, false, send);
    assert.equal(sent.length, 1);
    await processReqResult({ ...result, conversationStatus: "Finalizada" }, previous, now, false, send);
    assert.equal(sent.length, 2);
    sent.length = 0;
  }
  assert.equal(reminderDay(new Date("2026-10-13T13:15:00Z")), "2026-10-13");
  assert.equal(reminderDay(new Date("2026-04-03T13:15:00Z")), null); // Good Friday
  assert.equal(reminderDay(new Date("2026-05-18T13:15:00Z")), null); // Ascension Monday
  assert.equal(reminderDay(new Date("2026-05-19T13:15:00Z")), "2026-05-19");
});

test("unknown comment time recovering does not cause a second pending change alert", async () => {
  const operations = { ...result.latestOperationsComment,
    text: "Antes del día 09/10/2026 11:59 p.m.", isResponse: true };
  const requester = { author: "Requester", date: null as string | null, text: "Original request", isResponse: false };
  const unknown = deriveCommentCycle([operations, requester], false);
  const recovered = deriveCommentCycle([operations, { ...requester, date: "8 oct 2026, 08:00" }], false);
  const sent: string[] = [];
  const send = async (message: string) => { sent.push(message); };
  const now = new Date("2026-10-09T13:15:00Z");
  const initial = await processReqResult({ ...result, latestOperationsComment: unknown.latestOperationsComment,
    activeDeadline: unknown.activeDeadline }, undefined, now, false, send);
  assert.equal(sent.length, 1);
  assert.equal(initial.lastReminder, undefined);
  assert.equal(initial.latestOperationsCommentKey, `Operations|9 oct 2026, 08:00|${operations.text}`);
  const next = await processReqResult({ ...result, latestOperationsComment: recovered.latestOperationsComment,
    activeDeadline: recovered.activeDeadline }, initial, now, false, send);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /plazo próximo/i);
  assert.deepEqual(next.lastReminder, { sourceKey: recovered.activeDeadline?.sourceKey, day: "2026-10-09" });
});
