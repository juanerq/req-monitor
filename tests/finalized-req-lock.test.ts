import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleReqs, lockedFinalizedReqs } from "../finalized-req-lock.ts";

const configured = ["REQ101", "REQ102", "REQ103"];
const results = [
  { req: "REQ101", status: "Finalizado", checkedAt: "2026-11-05T10:00:00.000Z", conversationStatus: "Respondida" },
  { req: "REQ102", status: "En curso", conversationStatus: "Finalizada" },
  { req: "REQ103", status: "Finalizado", checkedAt: "2026-11-05T10:00:00.000Z", conversationStatus: "Finalizada" },
];

test("only literal finalized portal status locks REQs across all run types", () => {
  assert.deepEqual(lockedFinalizedReqs(configured, results, {}), ["REQ101", "REQ103"]);
  assert.deepEqual(eligibleReqs(configured, results, {}), ["REQ102"]);
  const unlocked = { REQ101: "2026-11-05T10:00:00.000Z" };
  assert.deepEqual(eligibleReqs(configured, results, unlocked), ["REQ101", "REQ102"]);
  assert.deepEqual(eligibleReqs(configured, results, { ...unlocked, REQ103: unlocked.REQ101 }), configured);
  assert.deepEqual(lockedFinalizedReqs(configured, results, unlocked), ["REQ103"]);
  assert.deepEqual(eligibleReqs(configured, [], {}), configured, "unreviewed REQs remain eligible");
  assert.deepEqual(lockedFinalizedReqs(configured, [
    { ...results[0], checkedAt: "2026-11-05T11:00:00.000Z" }, ...results.slice(1),
  ], unlocked), ["REQ101", "REQ103"], "a new finalized analysis re-locks the REQ");
  assert.deepEqual(lockedFinalizedReqs(configured, [
    { ...results[0], checkedAt: "2026-11-05T09:00:00.000Z" }, ...results.slice(1),
  ], unlocked), ["REQ103"], "an older stored revision must not look like a new analysis");
  assert.deepEqual(lockedFinalizedReqs(["REQ101"], [
    { req: "REQ101", status: "Finalizado" },
  ], { REQ101: "2026-11-05T10:00:00.000Z" }), ["REQ101"], "missing revision must fail closed");
  assert.deepEqual(eligibleReqs(configured, [
    { ...results[0], checkedAt: "2026-11-05T11:00:00.000Z", status: null }, ...results.slice(1),
  ], unlocked), ["REQ101", "REQ102"], "failed or non-final analysis must not create a final lock");
  assert.deepEqual(lockedFinalizedReqs(["REQ104"], [{ req: "REQ104", status: "Finalizada" }], {}), [],
    "derived-conversation vocabulary must not determine the portal lock");
});
