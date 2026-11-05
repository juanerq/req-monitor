// Only classify known portal access failures; other monitor errors need their own handling.
const accessFailure = /(?:^|[\r\n])(?:Error: No existe [^\r\n]+\. Ejecuta: pnpm run auth|REQ\d+: La sesión expiró\.)/i;

export function monitorAuthErrorDetector(onAccessFailure: () => void): (chunk: Buffer | string) => void {
  let tail = "";
  let detected = false;
  return (chunk) => {
    if (detected) return;
    const text = `${tail}${chunk.toString()}`;
    if (accessFailure.test(text)) {
      detected = true;
      onAccessFailure();
    }
    tail = text.slice(-256);
  };
}
