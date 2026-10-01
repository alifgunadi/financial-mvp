import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Minimal storage seam: local dir for MVP, replaceable by S3 later
// without touching the receipt domain or API layer.
// Vercel serverless filesystem read-only kecuali /tmp: saat berjalan di
// Vercel (process.env.VERCEL=1) pakai direktori ephemeral os.tmpdir().
// Perilaku local tidak berubah.
const ROOT = process.env.VERCEL
  ? join(tmpdir(), "uploads")
  : join(dirname(fileURLToPath(import.meta.url)), "..", "uploads");

export async function saveReceiptFile(ext: string, data: Buffer): Promise<string> {
  await mkdir(ROOT, { recursive: true });
  const name = `${randomUUID()}${ext}`;
  await writeFile(join(ROOT, name), data);
  return name;
}

export function receiptFilePath(storedName: string): string {
  return join(ROOT, storedName);
}

export async function deleteReceiptFile(storedName: string): Promise<void> {
  await unlink(join(ROOT, storedName)).catch(() => {});
}
