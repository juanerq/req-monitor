type AttachmentName = { name: string };

/** Infer code package names only for unambiguous static-analysis requests. */
export function microservicesFromStaticAnalysisAttachments(input: {
  title: string | null;
  requestType: string | null;
  microservices: string[];
  attachments: AttachmentName[];
}): string[] {
  if (input.microservices.length) return input.microservices;
  const staticAnalysis = /\ban[aá]lisis\s+de\s+c[oó]digo\s+est[aá]tico\b/iu;
  if (!staticAnalysis.test(input.title ?? "") || !staticAnalysis.test(input.requestType ?? "")) return [];

  const names = new Map<string, string>();
  for (const attachment of input.attachments) {
    const filename = attachment.name?.trim();
    if (!filename || filename.length > 160 || /[\\/]/.test(filename)) continue;
    const match = filename.match(/^([\p{L}][\p{L}\p{N}_.-]{1,99})\.(?:tar\.gz|7z|zip|rar)$/iu);
    if (!match) continue;
    const name = match[1];
    if (/^(?:source|codigo|código|code|codebase|fuente|archivos?|adjunto|documento|evidencia|reporte|informe|analisis|análisis|resultados?|scan|repositorio|repository|package|packages|bundle|artifact|artefacto)(?:[_.-].*)?$|^REQ\d+$/iu.test(name)) continue;
    names.set(name.toLowerCase(), names.get(name.toLowerCase()) ?? name);
    if (names.size === 50) break;
  }
  return [...names.values()];
}
