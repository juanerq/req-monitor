export type ClosureOutcome = "approved" | "needs_correction" | "unknown";

/** A closed portal ticket is not evidence that the work was approved. */
export function closureOutcome(status: string | null | undefined, operationsText: string | null | undefined): ClosureOutcome | null {
  if (!/^(?:finalizad[oa]|completad[oa]|completed|finalized|closed|cerrad[oa])$/i.test(status?.trim() ?? "")) return null;
  if (!operationsText?.trim()) return "unknown";

  const text = operationsText.replace(/\s+/g, " ").trim();
  const approvalText = text.replace(/“[^”]{1,180}”|«[^»]{1,180}»|‘[^’]{1,180}’|"[^"]{1,180}"/g,
    (quoted, offset: number) => offset === 0 && quoted.length === text.length ? quoted.slice(1, -1) : " ");
  const negativeReason = /\b(?:no cuenta con|falta (?:de )?(?:informaci[oó]n|documentaci[oó]n|requisitos?)|informaci[oó]n (?:insuficiente|incompleta)|no cumple|observaciones encontradas)\b/i;
  const rejected = /\bno se (?:aprueba|aprob[oó])(?=\s|[.,;:!?]|$)/i.test(text) ||
    /\b(?:se procede al cierre|se cierra|cerramos (?:el )?caso|cierre del caso)\b.{0,180}/i.test(text) &&
    negativeReason.test(text);
  const approved = /\b(?:validaci[oó]n (?:aprobada|exitosa|satisfactoria)|(?<!no )se aprob[oó] (?:la )?(?:validaci[oó]n|solicitud)|solicitud aprobada|sin observaciones)\b/i.test(approvalText);
  if (approved && (rejected || negativeReason.test(text))) return "unknown";
  if (rejected) return "needs_correction";
  if (approved && !/\b(?:no|sin|si)\s+(?:se\s+)?(?:aprob[oó]|aprueba|validaci[oó]n aprobada)\b/i.test(text)) return "approved";
  return "unknown";
}

export function closureOutcomeLabel(outcome: ClosureOutcome): string {
  if (outcome === "approved") return "Cierre aprobado";
  if (outcome === "needs_correction") return "Cerrada con observaciones";
  return "Cierre sin resultado claro";
}
