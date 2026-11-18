import assert from "node:assert/strict";
import { test } from "node:test";
import { closureOutcome } from "../closure-outcome.ts";

test("only a final portal status and an explicit Operations closure explain the outcome", () => {
  const rejected = "Solución Dada: Se procede al cierre del caso debido a que no cuenta con la información necesaria para continuar. Favor incluir el SSD en formato .md y crear el caso nuevamente.";
  assert.equal(closureOutcome("Finalizado", rejected), "needs_correction");
  assert.equal(closureOutcome("Finalizado", "Validación aprobada. Documentación conforme a estándares."), "approved");
  assert.equal(closureOutcome("Finalizado", '"Validación aprobada. Documentación conforme a estándares."'), "approved");
  assert.equal(closureOutcome("Finalizado", "Se procede al cierre del caso."), "unknown");
  assert.equal(closureOutcome("Finalizado", null), "unknown");
  assert.equal(closureOutcome("En curso", rejected), null);
});

test("mixed, negated or merely quoted closure language never asserts approval", () => {
  assert.equal(closureOutcome("Finalizado", "No se aprueba la solicitud: falta documentación."), "needs_correction");
  assert.equal(closureOutcome("Finalizado", "No se aprobó la validación."), "needs_correction");
  assert.equal(closureOutcome("Finalizado", "Se aprobó la validación, pero no cumple con los requisitos."), "unknown");
  assert.equal(closureOutcome("Finalizado", "Si la validación es aprobada, se procede al cierre."), "unknown");
  assert.equal(closureOutcome("Finalizado", "El usuario pregunta si cumple con los requisitos."), "unknown");
  assert.equal(closureOutcome("Finalizado", "El usuario indica ‘solicitud aprobada’; aún falta revisión de Operaciones."), "unknown");
});
