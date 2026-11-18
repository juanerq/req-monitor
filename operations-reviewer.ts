type OperationsComment = { author?: string | null; text?: string | null } | null | undefined;

/** A comment signer identifies the reviewer without changing the portal profile or alert identity. */
export function operationsReviewerName(comment: OperationsComment): string | null {
  const signers = [...(comment?.text ?? "").matchAll(/^\s*--\s*Revisa\s*:\s*([^\r\n]{1,80})\s*$/gim)]
    .map((match) => match[1].trim());
  return signers.length === 1 && /^[\p{L}][\p{L} .'-]{1,79}$/u.test(signers[0])
    ? signers[0] : comment?.author ?? null;
}
