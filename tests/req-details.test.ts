import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { conversationStatus, deriveCommentCycle } from "../deadline.ts";
import { extractPortalFieldsFromDom, parseReqDetails, repositoryRequestMicroservices } from "../req-details.ts";

async function portalPage(browser: Browser) {
  const page = await browser.newPage();
  // Match the browser setup used by check-req before evaluating the extracted function.
  await page.evaluate("globalThis.__name = (target) => target");
  return page;
}

test("check-req requests Spanish Colombia locale for portal labels", () => {
  const source = readFileSync(new URL("../check-req.ts", import.meta.url), "utf8");
  assert.equal(/browser\.newContext\(\{[^}]*locale:\s*["']es-CO["']/s.test(source), true);
});

test("DOM extraction ignores free-text labels before real detail fields", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    await page.setContent(`
      <section class="request-description">Estado: Finalizada<br>Petición para: Wrong Person</section>
      <dwp-event-details class="ng-star-inserted">
        <div data-ta="headlineItemWrapper"><p class="headline-item__title">Estado</p><p class="headline-item__description">En curso</p></div>
        <div><span>Descripción Detallada de la Solicitud</span><div>Estado: Finalizada<br><div><span>Estado</span><span>Finalizada</span></div>Nombre de microservicio. AtlasApi</div></div>
        <dl><dt><span>Petición para</span></dt><dd>Alex Example</dd></dl>
      </dwp-event-details>
      <section class="comments__comment-block"><span>Estado: Finalizada</span></section>
    `);
    const raw = await page.evaluate(extractPortalFieldsFromDom);
    const details = parseReqDetails(raw);
    assert.equal(details.status, "En curso");
    assert.equal(details.requester, "Alex Example");
    assert.match(details.description ?? "", /Estado: Finalizada/);
    assert.deepEqual(details.microservices, ["AtlasApi"]);
  } finally {
    await browser.close();
  }
});

test("DOM extraction fails closed when only prose and comments contain field labels", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    await page.setContent(`<article>Estado: Finalizada<br>Correo electrónico: fake@example.test</article>
      <aside><div><span>Estado</span><span>Finalizada</span></div></aside>
      <dwp-event-details><dl><dt>Estado</dt><dd>Finalizada</dd></dl>
        <dl><dt>Correo electrónico</dt><dd>synthetic@example.test</dd></dl></dwp-event-details>
      <div class="comments__comment-block"><span>Estado: Finalizada</span></div>`);
    const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
    assert.equal(details.status, null);
    assert.equal(details.requesterEmail, "synthetic@example.test");
  } finally {
    await browser.close();
  }
});

test("DOM extraction preserves long detail values without silent clipping", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    const long = "s".repeat(20_000);
    await page.setContent(`<dwp-event-details>
      <div><span>Descripción Detallada de la Solicitud</span><div>${long}</div></div>
      <div><span>Instrucciones</span><div>${long}</div></div>
    </dwp-event-details>`);
    const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
    assert.equal(details.description, long);
    assert.equal(details.instructions, long);
  } finally {
    await browser.close();
  }
});

test("DOM extraction reads project only from detailed description, not instructions or comments", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    await page.setContent(`<dwp-event-details><dl>
      <dt>Descripción Detallada de la Solicitud</dt><dd>Deployment notes<br>Proyecto: Sample Platform</dd>
      <dt>Instrucciones</dt><dd>Proyecto: Instruction Platform</dd>
      <dt>Aplicación</dt><dd>Application Platform</dd>
    </dl></dwp-event-details><dwp-comments>Proyecto: Comment Platform</dwp-comments>`);
    const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
    assert.equal(details.projectName, "Sample Platform");
  } finally {
    await browser.close();
  }
});

test("observed portal definition list and status header yield only scoped fields", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    await page.setContent(`<dl><dt>Correo electrónico</dt><dd>outside@example.test</dd></dl>
      <dwp-event-details class="ng-star-inserted">
         <div data-ta="headlineItemWrapper"><p class="headline-item__title">Estado</p><p class="headline-item__description">En curso</p></div>
        <p data-ta="coloredMediaHeaderParagraph_0">En curso</p>
        <dl><dt>Descripción Detallada de la Solicitud</dt><dd>Deploy requested.<br>Nombre de microservicio. SyntheticApi</dd>
          <dt>Instrucciones</dt><dd>Use staging.</dd>
          <dt>Correo electrónico</dt><dd>case@example.test</dd></dl>
      </dwp-event-details>`);
    const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
    assert.equal(details.status, "En curso");
    assert.equal(details.description, "Deploy requested.\nNombre de microservicio. SyntheticApi");
    assert.equal(details.instructions, "Use staging.");
    assert.equal(details.requesterEmail, "case@example.test");
    assert.deepEqual(details.microservices, ["SyntheticApi"]);
  } finally {
    await browser.close();
  }
});

test("labeled Pending status survives a non-status media heading", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    await page.setContent(`<dwp-event-details>
      <div data-ta="headlineItemWrapper"><h3>Estado</h3><p class="headline-item__description">Pending</p></div>
      <p data-ta="coloredMediaHeaderParagraph_0">Request category descriptor</p>
    </dwp-event-details>`);
    await page.evaluate("globalThis.__name = (target) => target");
    assert.equal(parseReqDetails(await page.evaluate(extractPortalFieldsFromDom)).status, "Pending");
    for (const media of ["Finalizada", "Cancelada", "Cancelled", "Rechazada", "Rejected"]) {
      await page.setContent(`<dwp-event-details>
        <div data-ta="headlineItemWrapper"><h3>Estado</h3><p class="headline-item__description">Pending</p></div>
        <p data-ta="coloredMediaHeaderParagraph_0">${media}</p>
      </dwp-event-details>`);
      assert.equal(parseReqDetails(await page.evaluate(extractPortalFieldsFromDom)).status, null, media);
    }
  } finally {
    await browser.close();
  }
});

test("observed phone labels require structural event detail pairs", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    for (const label of ["Pedido para teléfono", "Numero de Contacto"]) {
      await page.setContent(`<article>${label}: +000 999999</article>
        <dwp-event-details><dl><dt>${label}</dt><dd>+000 123456</dd>
          <dt>Descripción Detallada de la Solicitud</dt><dd>${label}: +000 888888</dd></dl></dwp-event-details>
        <dwp-comments>${label}: +000 777777</dwp-comments>`);
      const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
      assert.equal(details.requesterPhone, "+000 123456", label);
    }
    await page.setContent(`<dl><dt>Numero de Contacto</dt><dd>+000 999999</dd></dl>
      <dwp-event-details><dl><dt>Descripción Detallada de la Solicitud</dt>
        <dd>Pedido para teléfono: +000 888888</dd></dl></dwp-event-details>`);
    assert.equal(parseReqDetails(await page.evaluate(extractPortalFieldsFromDom)).requesterPhone, null);
  } finally {
    await browser.close();
  }
});

test("user ID requires explicit label and value beside requester headline", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    for (const label of ["ID de usuario", "User ID"]) {
      await page.setContent(`<section><div><span data-ta="headlineUserName">Casey Sample</span>
          <span>${label}</span><span>sample.user42</span></div></section>
        <dwp-event-details><dl><dt>Descripción Detallada de la Solicitud</dt>
          <dd>${label}: wrong.user; +000 999999</dd></dl></dwp-event-details>`);
      const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
      assert.equal(details.requester, "Casey Sample");
      assert.equal(details.requesterUserId, "sample.user42", label);
    }
  } finally {
    await browser.close();
  }
});

test("requester identity ignores a multiline requested-for card containing ID and email", () => {
  const fields = [{ label: "Petición para", value: "C\nCasey Sample\nID de usuario: sample.user42\ncasey@example.test" }];
  const details = parseReqDetails({ fields, headlineRequester: "Casey Sample" });
  assert.equal(details.requester, "Casey Sample", "requester comments must not be attributed to Operations");
  assert.equal(parseReqDetails({ fields }).requester, null, "ambiguous card without a verified name must not identify Operations");
  assert.equal(parseReqDetails({ fields: [{ label: "Petición para", value: "Casey Sample" }],
    headlineRequester: "Different Person" }).requester, "Casey Sample", "plain explicit requester still takes precedence");
  const comment = (author: string, date: string) => ({ author, date, text: "Sample comment",
    isResponse: author !== details.requester });
  const requesterOnly = deriveCommentCycle([comment("Casey Sample", "6 nov 2026, 10:00")], false);
  assert.equal(requesterOnly.latestOperationsComment, null);
  assert.equal(conversationStatus(requesterOnly, false, false), "Sin comentario de operaciones");
  const assigned = deriveCommentCycle([
    comment("Casey Sample", "6 nov 2026, 10:00"), comment("Morgan Agent", "6 nov 2026, 11:00"),
  ], false);
  assert.equal(assigned.latestOperationsComment?.author, "Morgan Agent");
  assert.equal(conversationStatus(assigned, false, false), "Pendiente de respuesta");
});

test("repository setup extracts microservice names only from paired Nombre and Proyecto fields", () => {
  const description = "Configurar pipeline y release para los siguientes repositorios:\n" +
    "Nombre: PaymentsApi\nProyecto: Platform\nURL: https://example.invalid/one\n" +
    "Nombre: BillingWorker\nProyecto: Platform\nNombre: paymentsapi\nProyecto: Platform";
  const fields = [
    { label: "Tipo de solicitud", value: "Creación y configuración de repositorios/pipelines" },
    { label: "Descripción Detallada de la Solicitud", value: description },
  ];
  assert.deepEqual(parseReqDetails({ fields }).microservices, ["PaymentsApi", "BillingWorker"]);
  assert.deepEqual(parseReqDetails({ fields: [fields[0], { label: fields[1].label,
    value: `${description}\nMicroservicio: ExplicitApi` }] }).microservices,
    ["ExplicitApi"], "explicit microservice names retain precedence");
  assert.deepEqual(repositoryRequestMicroservices("Nombre: Person\nProyecto: Platform", fields[0].value), [],
    "a generic name without repository context is not a microservice");
  assert.deepEqual(repositoryRequestMicroservices(description, "Consulta general"), []);
  assert.deepEqual(repositoryRequestMicroservices("Repositorios:\nNombre: Person\nCorreo: sample@example.invalid", fields[0].value), []);
});

test("user ID remains absent without a compact labeled requester header", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    for (const header of [
      '<div><span data-ta="headlineUserName">Casey Sample 4242</span></div>',
      '<div><span data-ta="headlineUserName">Casey Sample</span><span>4242</span></div>',
      '<div><span data-ta="headlineUserName">Casey Sample</span><span>ID de usuario</span><span>first</span><span>User ID</span><span>second</span></div>',
    ]) {
      await page.setContent(`${header}<div><span>ID de usuario</span><span>outside.user</span></div>
        <dwp-event-details><dl><dt>ID de usuario</dt><dd>detail.user</dd>
          <dt>Descripción Detallada de la Solicitud</dt>
          <dd>ID de usuario: prose.user; Numero de Contacto: +000 999999</dd></dl></dwp-event-details>
        <dwp-comments>User ID: comment.user</dwp-comments>`);
      const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
      assert.equal(details.requesterUserId, null);
      assert.equal(details.requesterPhone, null);
    }
  } finally {
    await browser.close();
  }
});

test("English header fallback works without comments", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    await page.setContent(`<dwp-event-details><p data-ta="coloredMediaHeaderParagraph_0">In Progress</p>
      <dl><dt>Detailed Request Description</dt><dd>Nombre de microservicio. EnglishApi</dd></dl></dwp-event-details>`);
    const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
    assert.equal(details.status, "In Progress");
    assert.deepEqual(details.microservices, ["EnglishApi"]);
  } finally {
    await browser.close();
  }
});

test("status header can precede event details while field labels remain scoped", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
     await page.setContent(`<div data-ta="headlineItemWrapper"><p class="headline-item__title">Estado</p><p class="headline-item__description">En curso</p></div>
      <dl><dt>Correo electrónico</dt><dd>outside@example.test</dd></dl>
      <dwp-event-details><dl><dt>Descripción Detallada de la Solicitud</dt>
        <dd>Nombre del microservicio. SampleApi</dd></dl></dwp-event-details>`);
    const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
    assert.equal(details.status, "En curso");
    assert.equal(details.requesterEmail, null);
    assert.deepEqual(details.microservices, ["SampleApi"]);
  } finally {
    await browser.close();
  }
});

test("missing, conflicting, and unknown status headers fail closed even with comments", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    for (const header of [
      "",
       '<div data-ta="headlineItemWrapper"><p class="headline-item__title">Estado</p><p class="headline-item__description">En curso</p></div><p data-ta="coloredMediaHeaderParagraph_0">Finalizada</p>',
      '<p class="unknown-status">En curso</p>',
    ]) {
      await page.setContent(`<dwp-event-details>${header}<dl><dt>Descripción Detallada de la Solicitud</dt>
        <dd>Estado: Finalizada<br>Nombre de microservicio. SyntheticApi</dd></dl></dwp-event-details>
        <dwp-comments><div class="comments__comment-block">Estado: Finalizada</div></dwp-comments>`);
      const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
      assert.equal(details.status, null);
      assert.deepEqual(details.microservices, ["SyntheticApi"]);
    }
  } finally {
    await browser.close();
  }
});

test("labeled status survives unrelated headline descriptions", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    await page.setContent(`<div data-ta="headlineItemWrapper"><p class="headline-item__title">Solicitud</p>
        <p class="headline-item__description">Solicitud de cambio</p></div>
      <div data-ta="headlineItemWrapper"><p class="headline-item__title">Estado</p>
        <p class="headline-item__description">En curso</p></div>
      <dwp-event-details><dl><dt>Descripción Detallada de la Solicitud</dt>
        <dd>Estado: Finalizada<br>• Nombre de microservicio. SyntheticApi</dd></dl></dwp-event-details>`);
    const details = parseReqDetails(await page.evaluate(extractPortalFieldsFromDom));
    assert.equal(details.status, "En curso");
    assert.deepEqual(details.microservices, ["SyntheticApi"]);
  } finally {
    await browser.close();
  }
});

test("unlabeled and conflicting status headline values fail closed", async () => {
  const browser = await chromium.launch();
  try {
    const page = await portalPage(browser);
    for (const headers of [
      '<div data-ta="headlineItemWrapper"><p class="headline-item__title">Solicitud</p><p class="headline-item__description">En curso</p></div>',
      '<div data-ta="headlineItemWrapper"><p class="headline-item__title">Estado</p><p class="headline-item__description">En curso</p></div><div data-ta="headlineItemWrapper"><p class="headline-item__title">Status</p><p class="headline-item__description">Finalizada</p></div>',
    ]) {
      await page.setContent(`${headers}<dwp-event-details><dl><dt>Descripción Detallada de la Solicitud</dt><dd>Estado: Finalizada</dd></dl></dwp-event-details>`);
      assert.equal(parseReqDetails(await page.evaluate(extractPortalFieldsFromDom)).status, null);
    }
  } finally {
    await browser.close();
  }
});

test("bullet-prefixed exact microservice names come only from description", () => {
  const details = parseReqDetails({ fields: [
    { label: "Descripción Detallada de la Solicitud", value: "• Nombre de microservicio. AlphaApi\n- Nombre de microservicio. BetaApi\n* Nombre de microservicio. GammaApi\n• Nombre de microservicio. Must provide an API\nNombre de microservicio.\nPlease name: WrongApi" },
    { label: "Instrucciones", value: "• Nombre de microservicio. InstructionApi" },
  ] });
  assert.deepEqual(details.microservices, ["AlphaApi", "BetaApi", "GammaApi"]);
});

test("project name comes only from an explicit description line and preserves observed spelling", () => {
  const details = parseReqDetails({ fields: [
    { label: "Descripción Detallada de la Solicitud", value: "Deployment notes\n• Proyecto:   Órbita Norte  \nNombre de microservicio. SampleApi" },
    { label: "Instrucciones", value: "Proyecto: InstructionProject" },
    { label: "Aplicación", value: "ApplicationProject" },
  ] });
  assert.equal(details.projectName, "Órbita Norte");
  assert.deepEqual(details.microservices, ["SampleApi"]);
});

test("project name is absent without a standalone description field", () => {
  for (const description of [
    "Deploy SampleApi for ProjectAlpha",
    "Please set Proyecto: InlineProject in the form",
    "https://example.test/Proyecto:UrlProject",
    "Proyecto: ",
    "Proyecto: <img src=x onerror=alert(1)>",
    `Proyecto: ${"x".repeat(257)}`,
  ]) {
    const details = parseReqDetails({ fields: [
      { label: "Descripción Detallada de la Solicitud", value: description },
      { label: "Instrucciones", value: "Proyecto: InstructionProject" },
      { label: "Aplicación", value: "ApplicationProject" },
      { label: "Proyecto", value: "UnscopedProject" },
    ] });
    assert.equal(details.projectName, null, description.slice(0, 70));
  }
  assert.equal(parseReqDetails({ fields: [{ label: "Instrucciones", value: "Proyecto: InstructionProject" }] }).projectName, null);
});

test("identical project lines deduplicate while conflicting names fail closed", () => {
  const parse = (value: string) => parseReqDetails({ fields: [
    { label: "Descripción Detallada de la Solicitud", value },
  ] }).projectName;
  assert.equal(parse("Proyecto: Cedar Works\n- Proyecto: Cedar Works"), "Cedar Works");
  assert.equal(parse("Proyecto: Cedar Works\n* Proyecto: Pine Works"), null);
  assert.equal(parse("Proyecto: Cedar Works\nProyecto: cedar works"), null);
});

test("check-req error results explicitly leave project name unavailable", () => {
  const source = readFileSync(new URL("../check-req.ts", import.meta.url), "utf8");
  const errorResult = source.slice(source.indexOf("results.push({", source.indexOf("async function main()")));
  assert.match(errorResult, /description: null,\s*projectName: null,/);
});

test("retains only explicitly labeled portal fields and description microservices", () => {
  const details = parseReqDetails({
    fields: [
      { label: "Estado", value: "En curso" },
      { label: "Descripción Detallada de la Solicitud", value: "Deploy service.\nNombre de microservicio. StarlingApi\nMicroservicios: SolarApi, LunarApi; OrbitApi\nSee https://example.test/help" },
      { label: "Instrucciones", value: "Requirement: Microservicio: MustProvideName\nUse the form." },
      { label: "Petición para", value: "Casey Sample" },
      { label: "ID de usuario", value: "casey.sample" },
      { label: "Correo electrónico", value: "casey@example.test" },
      { label: "Teléfono", value: "+000 123456" },
      { label: "Enviado", value: "01 oct 2026, 09:00" },
      { label: "Última actualización", value: "02 oct 2026, 10:00" },
      { label: "Tipo de operación", value: "Update" },
      { label: "Aplicación", value: "SyntheticApp" },
      { label: "Tipo de solicitud", value: "Change" },
      { label: "Tipo de cliente", value: "Internal" },
    ],
    descriptionLinks: ["https://example.test/pullrequest/42"],
  });
  assert.equal(details.status, "En curso");
  assert.equal(details.description, "Deploy service.\nNombre de microservicio. StarlingApi\nMicroservicios: SolarApi, LunarApi; OrbitApi\nSee https://example.test/help");
  assert.equal(details.instructions, "Requirement: Microservicio: MustProvideName\nUse the form.");
  assert.deepEqual(details.microservices, ["StarlingApi", "SolarApi", "LunarApi", "OrbitApi"]);
  assert.deepEqual(details.pullRequestUrls, ["https://example.test/pullrequest/42"]);
  assert.equal(details.requester, "Casey Sample");
  assert.equal(details.requesterUserId, "casey.sample");
  assert.equal(details.requesterEmail, "casey@example.test");
  assert.equal(details.requesterPhone, "+000 123456");
  assert.equal(details.sentAt, "01 oct 2026, 09:00");
  assert.equal(details.updatedAt, "02 oct 2026, 10:00");
  assert.deepEqual(details.requestDetails, {
    operationType: "Update", application: "SyntheticApp", requestType: "Change", clientType: "Internal",
  });
});

test("leaves missing fields null and does not infer identity, status or names", () => {
  const details = parseReqDetails({ fields: [
    { label: "Instrucciones", value: "Microservicio: MustProvideName" },
    { label: "Unrelated", value: "Somebody's name" },
  ] });
  assert.equal(details.status, null);
  assert.equal(details.requester, null);
  assert.equal(details.description, null);
  assert.deepEqual(details.microservices, []);
  assert.deepEqual(details.requestDetails, {
    operationType: null, application: null, requestType: null, clientType: null,
  });
});

test("rejects instruction-like name values and bounds text without persisting markup", () => {
  const details = parseReqDetails({ fields: [
    { label: "Descripción Detallada de la Solicitud", value: "Microservicio: Debe tener pruebas\nNombre de microservicio.\nNombre de microservicios: PineApi y CedarApi\n<script>alert(1)</script>" },
    { label: "Estado", value: "x".repeat(500) },
  ] });
  assert.deepEqual(details.microservices, ["PineApi", "CedarApi"]);
  assert.equal(details.status, `${"x".repeat(256)}\n[Truncated: content exceeds 256 characters]`);
  assert.equal(details.description?.includes("<script>"), true); // Literal text, never raw HTML.
});

test("keeps long descriptions and instructions intact; marks excessive content", () => {
  const long = "a".repeat(20_000);
  const details = parseReqDetails({ fields: [
    { label: "Descripción Detallada de la Solicitud", value: long },
    { label: "Instrucciones", value: long },
  ] });
  assert.equal(details.description, long);
  assert.equal(details.instructions, long);
  const excessive = parseReqDetails({ fields: [
    { label: "Instrucciones", value: "z".repeat(100_001) },
  ] });
  assert.equal(excessive.instructions, `${"z".repeat(100_000)}\n[Truncated: content exceeds 100000 characters]`);
});
