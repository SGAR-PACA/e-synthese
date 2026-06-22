// mastra/src/lib/storage.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

export function searchableKey(fileId: string): string {
  return `${fileId}/searchable.pdf`;
}

export function originalKey(fileId: string): string {
  return `${fileId}/original.pdf`;
}

let client: S3Client | undefined;
function getClient(): S3Client {
  if (!client) {
    const endpoint = process.env.S3_DOCS_ENDPOINT;
    const region = process.env.S3_DOCS_REGION;
    const accessKeyId = process.env.S3_DOCS_ACCESS_KEY;
    const secretAccessKey = process.env.S3_DOCS_SECRET_KEY;
    if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
      throw new Error('Configuration S3 documents manquante (S3_DOCS_*)');
    }
    client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true, // compat Scaleway/S3
    });
  }
  return client;
}

function bucket(): string {
  const b = process.env.S3_DOCS_BUCKET;
  if (!b) throw new Error('Configuration S3 documents manquante (S3_DOCS_BUCKET)');
  return b;
}

export async function putPdf(key: string, bytes: Uint8Array): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: bytes,
      ContentType: 'application/pdf',
    }),
  );
}

export async function getPdfStream(
  key: string,
  range?: string,
): Promise<{
  body: ReadableStream;
  contentLength?: number;
  contentRange?: string;
  acceptRanges: 'bytes';
}> {
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key, Range: range }),
  );
  return {
    body: res.Body!.transformToWebStream(),
    contentLength: res.ContentLength,
    contentRange: res.ContentRange,
    acceptRanges: 'bytes',
  };
}

export async function deletePdf(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
