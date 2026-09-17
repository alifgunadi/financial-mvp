// Generic PDF text extraction (bank-agnostic). Blu-specific interpretation
// lives in bluParse.ts. Returns CANDIDATES only: never touches the database,
// never creates Transactions — same boundary as ai.ts extractReceipt.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
}

export interface ExtractedPage {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

export type PdfExtractErrorCode = "UNREADABLE" | "ENCRYPTED";

export class PdfExtractError extends Error {
  constructor(
    public code: PdfExtractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PdfExtractError";
  }
}

// Maps pdf.js failure names to stable codes. Exported for unit verification:
// crafting a live encrypted PDF fixture is impractical, so the mapping is
// tested directly (see verification notes).
export function classifyPdfError(e: unknown): PdfExtractErrorCode {
  const name = e instanceof Error ? e.name : "";
  // ponytail: pdf.js signals password protection via PasswordException
  // (needsPassword / incorrectPassword live under the same name).
  if (name === "PasswordException") return "ENCRYPTED";
  return "UNREADABLE";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
  fontName?: unknown;
}

function asRawTextItem(raw: unknown): RawTextItem | null {
  // ponytail: TextContent.items mixes TextItem with TextMarkedContent
  // sentinels (no str/transform) — the guard below drops the sentinels.
  if (typeof raw !== "object" || raw === null) return null;
  return raw as RawTextItem;
}

function toTextItem(raw: unknown): PdfTextItem | null {
  const item = asRawTextItem(raw);
  if (!item || typeof item.str !== "string") return null;
  const t = item.transform;
  if (
    !Array.isArray(t) ||
    typeof t[4] !== "number" ||
    typeof t[5] !== "number"
  )
    return null;
  return {
    text: item.str,
    x: round2(t[4]),
    y: round2(t[5]),
    width: typeof item.width === "number" ? round2(item.width) : 0,
    height: typeof item.height === "number" ? round2(item.height) : 0,
    fontName: typeof item.fontName === "string" ? item.fontName : "",
  };
}

// Pages processed sequentially with per-page cleanup (pdfjs-dist v6 has no
// PDFDocumentProxy.destroy()). Coordinates use the default PDF user space:
// origin bottom-left, y growing upward.
export async function extractPdfPages(pdf: Buffer): Promise<ExtractedPage[]> {
  let doc: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
  try {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdf) });
    doc = await loadingTask.promise;
  } catch (e) {
    const code = classifyPdfError(e);
    throw new PdfExtractError(
      code,
      code === "ENCRYPTED" ? "PDF is encrypted" : "PDF cannot be opened",
    );
  }
  const pages: ExtractedPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    try {
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items) {
        const item = toTextItem(raw);
        if (item) items.push(item);
      }
      const view = page.view;
      pages.push({
        pageNumber: n,
        width: Array.isArray(view) && typeof view[2] === "number" ? view[2] : 0,
        height: Array.isArray(view) && typeof view[3] === "number" ? view[3] : 0,
        items,
      });
    } finally {
      await page.cleanup();
    }
  }
  return pages;
}
