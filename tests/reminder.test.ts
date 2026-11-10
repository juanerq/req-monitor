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
  assert.ok(card.body.some((block) => block.text?.includes("El solicitante confirmó la respuesta.")));
  assert.equal(card.actions[0].url, "https://portal.example/req123");
  assert.ok(!card.body.some((block) => block.text?.includes("Abrir REQ:")), "avoid repeating action link in body");
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
  assert.match(sent[0], /recordatorio/i);
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
  assert.match(sent[1], /recordatorio/i);
  assert.deepEqual(next.lastReminder, { sourceKey: recovered.activeDeadline?.sourceKey, day: "2026-10-09" });
});
