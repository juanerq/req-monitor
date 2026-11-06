type PortalResult = { req: string; status?: string | null; checkedAt?: string | null };

export function isValidReviewTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** An unlock applies to the observed result revision; a newer final result locks again. */
export function lockedFinalizedReqs(
  configured: string[], results: PortalResult[], unlocked: Record<string, string>,
): string[] {
  const byReq = new Map(results.map((result) => [result.req, result]));
  return configured.filter((req) => {
    const result = byReq.get(req);
    const unlockedAt = unlocked[req];
    return result?.status?.trim() === "Finalizado" &&
      (!isValidReviewTime(result.checkedAt) || !isValidReviewTime(unlockedAt) ||
        Date.parse(result.checkedAt) > Date.parse(unlockedAt));
  });
}

export function eligibleReqs(configured: string[], results: PortalResult[], unlocked: Record<string, string>): string[] {
  const locked = new Set(lockedFinalizedReqs(configured, results, unlocked));
  return configured.filter((req) => !locked.has(req));
}
