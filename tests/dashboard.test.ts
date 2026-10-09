import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

test("monitored table labels the stated deadline without claiming verified closure", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.match(html, /Plazo indicado/);
  const list = { innerHTML: "" };
  const empty = { hidden: false };
  const document = { querySelector: (selector: string) => selector === "#req-list" ? list : selector === "#empty-state" ? empty : {} };
  const context = vm.createContext({ document, URL, console });
  const script = fs.readFileSync("web/app.js", "utf8").split('elements.credentialsButton.addEventListener')[0];
  vm.runInContext(`${script}\nthis.renderRowsForTest = renderRows;`, context);
  const render = (result: object) => {
    (context as { renderRowsForTest: (reqs: string[], results: object[]) => void }).renderRowsForTest(["REQ123"], [{ req: "REQ123", ...result }]);
    return list.innerHTML;
  };
  assert.match(render({ conversationStatus: "Pendiente de respuesta", activeDeadline: { dueAt: "2026-10-10T04:59:00.000Z", sourceKey: "cycle" } }), /9\/10\/2026.*11:59/);
  assert.match(render({ conversationStatus: "Pendiente de respuesta", activeDeadline: null }), /Sin plazo indicado/);
  assert.match(render({ conversationStatus: "Respondida", activeDeadline: { dueAt: "2026-10-10T04:59:00.000Z" } }), /Plazo inactivo/);
  assert.doesNotMatch(render({ conversationStatus: "Finalizada" }), /11:59/);
  assert.doesNotMatch(list.innerHTML, /cierre verificado/i);
});
