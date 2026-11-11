import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
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

test("renewing portal access clears only a successfully resolved monitor auth warning", async () => {
  const api = fs.readFileSync(new URL("../monitor-api.ts", import.meta.url), "utf8");
  const start = api.indexOf("async function renewPortalSession(");
  const end = api.indexOf("async function readBody(", start);
  assert.ok(start >= 0 && end > start);
  const source = stripTypeScriptTypes(api.slice(start, end));

  const renew = (saveFails: boolean) => {
    const monitorStatus = { authRequired: true };
    const input = { waitFor: async () => {}, fill: async () => {}, isVisible: async () => false };
    const page = {
      goto: async () => {}, locator: () => input,
      getByRole: () => ({ click: async () => {} }),
      waitForURL: async (predicate: (url: URL) => boolean) => {
        assert.equal(predicate(new URL("https://portal.example/app")), true);
      },
      waitForLoadState: async () => {}, url: () => "https://portal.example/app",
    };
    const browser = { newContext: async () => ({ newPage: async () => page }), close: async () => {} };
    const context = vm.createContext({ monitorStatus, chromium: { launch: async () => browser },
      APP_URL: "https://portal.example/app", PORTAL_ORIGIN: "https://portal.example",
      AUTH_FILE: "synthetic-session.json", activeTask: null, child: null,
      validateUsername: () => {},
      saveAuthSession: async () => { if (saveFails) throw new Error("Synthetic save failure"); },
    });
    vm.runInContext(`${source}\nthis.renewForTest = renewPortalSession;`, context);
    return { monitorStatus, invoke: () => (context as { renewForTest: (user: string, password: string) => Promise<void> })
      .renewForTest("synthetic-user", "synthetic-password") };
  };

  const failed = renew(true);
  await assert.rejects(failed.invoke(), /Synthetic save failure/);
  assert.equal(failed.monitorStatus.authRequired, true, "failed renewal must remain actionable");

  const succeeded = renew(false);
  await succeeded.invoke();
  assert.equal(succeeded.monitorStatus.authRequired, false,
    "reloading the dashboard must not reopen the resolved access warning");
});
