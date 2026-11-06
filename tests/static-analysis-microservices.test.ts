import assert from "node:assert/strict";
import { test } from "node:test";
import { microservicesFromStaticAnalysisAttachments } from "../static-analysis-microservices.ts";

const request = {
  title: "Solicitud de análisis de código estático",
  requestType: "Análisis de código estático",
  microservices: [],
};

test("static-analysis source archives supply microservice names when description lacks them", () => {
  const result = microservicesFromStaticAnalysisAttachments({
    ...request,
    attachments: ["PaymentsApi.7z", "BillingWorker.zip", "OrdersApi.tar.gz", "paymentsapi.7z", "Informe.pdf"]
      .map((name) => ({ name })),
  });
  assert.deepEqual(result, ["PaymentsApi", "BillingWorker", "OrdersApi"]);
});

test("explicit description names take precedence over attachment names", () => {
  assert.deepEqual(microservicesFromStaticAnalysisAttachments({
    ...request, microservices: ["DocumentedApi"], attachments: [{ name: "OtherApi.7z" }],
  }), ["DocumentedApi"]);
});

test("unrelated requests and ambiguous attachments do not invent microservices", () => {
  const attachments = ["api-report.pdf", "source.zip", "source_code.zip", "package.zip", "bundle.7z", "Informe_final.7z", "REQ123.7z", "../OtherApi.7z", "2026-11-06.7z", "a.7z"]
    .map((name) => ({ name }));
  assert.deepEqual(microservicesFromStaticAnalysisAttachments({ ...request, title: "Otra solicitud", attachments }), []);
  assert.deepEqual(microservicesFromStaticAnalysisAttachments({ ...request, requestType: "Consulta general", attachments }), []);
  assert.deepEqual(microservicesFromStaticAnalysisAttachments({ ...request, attachments }), []);
});
