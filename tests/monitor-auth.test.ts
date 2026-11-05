import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorAuthErrorDetector } from "../monitor-auth.ts";

test("monitor access failures are detected across stderr chunks", () => {
  let prompts = 0;
  const detect = monitorAuthErrorDetector(() => prompts++);
  for (const chunk of ["Error: No existe /app/playwright/.auth/", "miasistencia.json. Ejecuta: pnpm ", "run auth\n"]) {
    detect(chunk);
  }
  detect("Error: No existe /app/playwright/.auth/miasistencia.json. Ejecuta: pnpm run auth\n");
  assert.equal(prompts, 1);

  let expired = 0;
  monitorAuthErrorDetector(() => expired++)("REQ123: La sesión expiró.\n");
  assert.equal(expired, 1);
});

test("network, missing REQ file and unrelated text are not access failures", () => {
  let prompts = 0;
  const detect = monitorAuthErrorDetector(() => prompts++);
  detect("Error: No existe /data/reqs.txt. Usa reqs.txt.example como referencia\n");
  detect("REQ123: Error de red al conectar al portal\n");
  detect("Comentario: La sesión expiró.\n");
  assert.equal(prompts, 0);
});
