import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationStatus, deriveActiveDeadline, deriveCommentCycle, parseExplicitDeadline } from "../deadline.ts";
import { processReqResult } from "../monitor-req.ts";

const deadlineText = "Esperamos la información antes del día 🕦 09/10/2026 11:59 p.m. 🕦";
const operationsComment = {
  author: "Operations",
  date: "9 oct 2026, 09:00",
  text: deadlineText,
};

test("parses an explicit Bogota deadline without depending on local timezone", () => {
  assert.equal(parseExplicitDeadline(deadlineText), "2026-10-10T04:59:00.000Z");
  assert.equal(parseExplicitDeadline("Antes del día 09/10/2026 12:00 a.m."), "2026-10-09T05:00:00.000Z");
  assert.equal(parseExplicitDeadline("Antes del día 09/10/2026 12:00 p.m."), "2026-10-09T17:00:00.000Z");
});

test("rejects invalid and ambiguous deadline values", () => {
  for (const text of [
    "Antes del día 31/02/2026 11:59 p.m.",
    "Antes del día 29/02/2025 11:59 p.m.",
    "Antes del día 09/10/2026 13:59 p.m.",
    "Antes del día 09/10/2026 11:60 p.m.",
    "Antes del día 09/10/2026 11:59",
    "Antes del día 09/10/2026 11:59 p.m. o 10/10/2026 11:59 p.m.",
    "Antes del día 09/10/2026 11:59 p.m. o 12:00 p.m.",
    "Antes del día 09/10/2026 11:59 p.m. o 12:00",
    "Publicado 09/10/2026 11:59 p.m.",
    "Esperamos la información pronto.",
  ]) {
    assert.equal(parseExplicitDeadline(text), null, text);
  }
  assert.equal(parseExplicitDeadline("Antes del día 29/02/2028 11:59 p.m."), "2028-03-01T04:59:00.000Z");
});

test("keeps only the current unanswered Operations cycle active", () => {
  const active = deriveActiveDeadline(operationsComment, [], false);
  assert.deepEqual(active, {
    dueAt: "2026-10-10T04:59:00.000Z",
    sourceKey: JSON.stringify([operationsComment.author, operationsComment.date, operationsComment.text, 0]),
  });
  assert.deepEqual(deriveActiveDeadline({ ...operationsComment }, [], false), active);
  assert.equal(deriveActiveDeadline(operationsComment, [{ author: "Requester" }], false), null);
  assert.equal(deriveActiveDeadline(operationsComment, [], true), null);
  assert.equal(deriveActiveDeadline(null, [], false), null);
  assert.equal(deriveActiveDeadline({ ...operationsComment, text: "We are waiting for information." }, [], false), null);

  const reopened = { ...operationsComment, date: "12 oct 2026, 09:00", text: "Antes del día 14/10/2026 08:30 a.m." };
  assert.deepEqual(deriveActiveDeadline(reopened, [], false), {
    dueAt: "2026-10-14T13:30:00.000Z",
    sourceKey: JSON.stringify([reopened.author, reopened.date, reopened.text, 0]),
  });
});

const requesterComment = { author: "Requester", date: "9 oct 2026, 09:01", text: "Here is the information.", isResponse: false };

test("distinguishes identical Operations comments across reopened cycles and refreshes", () => {
  const first = { ...operationsComment, isResponse: true };
  const second = { ...first };
  const older = { author: "Requester", date: "8 oct 2026, 08:00", text: "Original request", isResponse: false };
  // Portal timestamps have minute precision: two replies can share a displayed minute.
  const history = [second, { ...requesterComment, date: first.date }, first, older];
  const firstCycle = deriveCommentCycle([first, older], false);
  const secondCycle = deriveCommentCycle(history, false);
  assert.ok(firstCycle.activeDeadline);
  assert.ok(secondCycle.activeDeadline);
  assert.notEqual(secondCycle.activeDeadline.sourceKey, firstCycle.activeDeadline.sourceKey);
  assert.deepEqual(deriveCommentCycle(history.map((comment) => ({ ...comment })), false), secondCycle);
  assert.equal(deriveCommentCycle([requesterComment, first, older], false).activeDeadline, null);
});

test("normalizes ascending, descending and shuffled timestamp order", () => {
  const operations = { ...operationsComment, isResponse: true };
  const older = { ...requesterComment, date: "8 oct 2026, 08:00" };
  const newer = { ...operations, date: "10 oct 2026, 10:00" };
  const chronological = [older, operations, requesterComment, newer];
  const expected = deriveCommentCycle(chronological, false);
  assert.deepEqual(deriveCommentCycle([...chronological].reverse(), false), expected);
  assert.deepEqual(deriveCommentCycle([requesterComment, older, newer, operations], false), expected);
  assert.equal(expected.latestOperationsComment, newer);
  assert.equal(expected.requesterRepliesAfterOperations.length, 0);
});

test("refuses deadlines when comment sequence cannot be established", () => {
  const operations = { ...operationsComment, isResponse: true };
  const uncertain = deriveCommentCycle([operations, { ...requesterComment, date: null }], false);
  assert.equal(uncertain.activeDeadline, null);
  assert.equal(uncertain.latestOperationsComment, operations);
  assert.equal(uncertain.orderKnown, false);
  assert.equal(conversationStatus(uncertain, false, false), "Respondida");
  assert.equal(conversationStatus(uncertain, false, true), "En validación");
  assert.equal(conversationStatus(uncertain, true, false), "Finalizada");
  assert.equal(conversationStatus(deriveCommentCycle([{ ...requesterComment, date: "10 oct 2026, 09:01" }, operations], false), false, false), "Respondida");
  assert.equal(deriveCommentCycle([operations, { ...requesterComment, date: operations.date }], false).activeDeadline, null);
  assert.equal(deriveCommentCycle([operations, { ...requesterComment, date: "31 feb 2026, 09:01" }], false).activeDeadline, null);
  assert.equal(deriveCommentCycle([{ ...operations, date: "not a date" }], false).activeDeadline, null);
  assert.equal(deriveCommentCycle([operations], true).activeDeadline, null);
  assert.deepEqual(deriveCommentCycle([requesterComment], false).requesterRepliesAfterOperations, []);
  assert.equal(conversationStatus(deriveCommentCycle([requesterComment], false), false, false), "Sin comentario de operaciones");
});

test("an unparseable requester timestamp preserves the known Operations comment across recovery", () => {
  const operations = { ...operationsComment, isResponse: true };
  const uncertain = deriveCommentCycle([operations, { ...requesterComment, date: null }], false);
  const recovered = deriveCommentCycle([operations, { ...requesterComment, date: "8 oct 2026, 09:01" }], false);
  assert.equal(uncertain.latestOperationsComment, recovered.latestOperationsComment);
  assert.equal(uncertain.activeDeadline, null);
  assert.ok(recovered.activeDeadline);
});

test("an unreadable latest requester reply never creates a pending alert", async () => {
  const operations = { ...operationsComment, isResponse: true };
  const older = { ...requesterComment, date: "8 oct 2026, 08:00" };
  const latest = { ...requesterComment, date: "unreadable", text: "Information supplied later." };
  const cycle = deriveCommentCycle([latest, operations, older], false);
  assert.equal(cycle.orderKnown, false);
  assert.equal(cycle.latestOperationsComment, operations);
  assert.equal(cycle.activeDeadline, null);
  assert.notEqual(conversationStatus(cycle, false, false), "Pendiente de respuesta");
  assert.equal(conversationStatus(cycle, false, false), "Respondida");
  assert.equal(conversationStatus(cycle, true, false), "Finalizada");
  assert.equal(conversationStatus(cycle, false, true), "En validación");
  const sent: string[] = [];
  const result = {
    req: "REQ123", checkedAt: "2026-10-09T13:00:00.000Z",
    conversationStatus: conversationStatus(cycle, false, false),
    status: "Open", title: null, microservices: [], pullRequestUrls: [], detailUrl: null,
    latestOperationsComment: { ...operations, attachments: [] }, activeDeadline: cycle.activeDeadline,
  };
  await processReqResult(result, undefined, new Date(result.checkedAt), false, async (message) => { sent.push(message); });
  assert.deepEqual(sent, []);
});
