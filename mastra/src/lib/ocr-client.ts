// mastra/src/lib/ocr-client.ts
const OCR_TIMEOUT_MS = 600_000;
const OCR_MAX_ATTEMPTS = 2;
const OCR_RETRY_DELAY_MS = 1_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryableOcrError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /OCR service status 5\d\d|fetch failed|network|timeout|timed out/i.test(message);
}

function errorDetail(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export async function ocrToSearchablePdf(
  bytes: Uint8Array,
): Promise<{ pdf: Uint8Array; ocrApplied: boolean }> {
  const base = process.env.OCR_SERVICE_URL;
  if (!base) throw new Error('OCR_SERVICE_URL manquant');
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let lastError: unknown;

  for (let attempt = 1; attempt <= OCR_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${base}/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        // Découpe bornée à la vue (byteOffset..byteLength) : correct pour une vue partielle,
        // contrairement à bytes.buffer qui enverrait tout le buffer sous-jacent.
        body,
        signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
      });
      if (!res.ok) {
        const headerDetail = res.headers.get('X-OCR-Error') || '';
        const detail = errorDetail(headerDetail || await res.text().catch(() => ''));
        throw new Error(`OCR service status ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length) throw new Error('OCR service returned an empty PDF');
      const ocrApplied = res.headers.get('X-OCR-Applied') === '1';
      return { pdf: buf, ocrApplied };
    } catch (err) {
      lastError = err;
      if (attempt >= OCR_MAX_ATTEMPTS || !retryableOcrError(err)) throw err;
      console.warn(`[ocr] tentative ${attempt}/${OCR_MAX_ATTEMPTS} échouée, nouvelle tentative`);
      await wait(OCR_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
