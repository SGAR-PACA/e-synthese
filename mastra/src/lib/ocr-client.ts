// mastra/src/lib/ocr-client.ts
const OCR_TIMEOUT_MS = 600_000;

export async function ocrToSearchablePdf(
  bytes: Uint8Array,
): Promise<{ pdf: Uint8Array; ocrApplied: boolean }> {
  const base = process.env.OCR_SERVICE_URL;
  if (!base) throw new Error('OCR_SERVICE_URL manquant');
  const res = await fetch(`${base}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    // Découpe bornée à la vue (byteOffset..byteLength) : correct pour une vue partielle,
    // contrairement à bytes.buffer qui enverrait tout le buffer sous-jacent.
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OCR service status ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const ocrApplied = res.headers.get('X-OCR-Applied') === '1';
  return { pdf: buf, ocrApplied };
}
