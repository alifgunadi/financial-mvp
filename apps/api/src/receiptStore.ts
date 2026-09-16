import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Minimal storage seam: local dir for MVP, replaceable by S3 later
// without touching the receipt domain or API layer.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "uploads");

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
