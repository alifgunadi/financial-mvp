// Blu by BCA Digital statement adapter. Pure functions over extracted PDF
// pages: coordinate sorting, noise filtering, pocket state machine,
// transaction block grammar, string-based normalization, and exact
// reconciliation gating. Returns CANDIDATES only — never creates or mutates
// a Transaction (same boundary as ai.ts). Statement mechanics stay separate
// from ledger semantics: direction is `statementDirection`, never
// Transaction.type.
import { BLU_MONTHS, parseBluDate, parseBluTime, parseIdrMinor } from "./money.js";
import { detectBlu, type BluDetection } from "./bluDetect.js";
import { extractPdfPages, type ExtractedPage } from "./pdfExtract.js";

export type StatementDirection = "INCOME" | "EXPENSE";

export interface BluPocketId {
  name: string;
  account: string | null;
}

export interface BluCanonicalRow {
  pocket: BluPocketId;
  rowIndex: number;
  date: string; // YYYY-MM-DD (Asia/Jakarta wall-date assumption, see §11 note)
  time: string; // HH:mm wall time, provenance context (Transaction.date is date-only)
  statementDirection: StatementDirection;
  amountMinor: bigint; // exact source minor units (sen), sign already applied
  wholeIdrEligible: boolean; // amountMinor % 100 === 0: required for future ledger import
  balanceMinor: bigint; // exact running balance, minor units
  description: string;
  reference: string | null;
  possibleInternalTransfer: boolean; // diagnostic flag only, see §13
}

export type BluReasonCode =
  | "INCOMPLETE_BLOCK"
  | "NO_POCKET_CONTEXT"
  | "MALFORMED_AMOUNT"
  | "MALFORMED_BALANCE"
  | "MALFORMED_DATE"
  | "MALFORMED_TIME"
  | "NON_WHOLE_IDR_AMOUNT"
  | "MALFORMED_SUMMARY"
  | "RECONCILIATION_MISMATCH"
  | "NO_TEXT_LAYER"
  | "NO_POCKET_FOUND"
  | "UNRECOGNIZED_STRUCTURE"
  | "GLOBAL_MISMATCH";

export interface BluDiagnostic {
  pocket: string | null;
  page: number | null;
  rowIndex: number | null;
  code: BluReasonCode;
}

export interface BluPocketResult {
  pocket: BluPocketId;
  openingMinor: bigint | null;
  totalIncomeMinor: bigint;
  totalExpenseMinor: bigint;
  closingMinor: bigint | null;
  rows: BluCanonicalRow[];
  reconciled: boolean;
  importable: boolean;
  diagnostics: BluDiagnostic[];
}

export interface BluStatementPeriod {
  from: string;
  to: string;
}

export interface BluParseResult {
  detected: BluDetection;
  statementPeriod: BluStatementPeriod | null;
  pockets: BluPocketResult[];
  globalReconciled: boolean | null;
  importable: boolean;
  diagnostics: BluDiagnostic[];
}

export class BluError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: "UNSUPPORTED_STATEMENT",
  ) {
    super(message);
    this.name = "BluError";
  }
}

// ---------------------------------------------------------------------------
// Lines: y-grouped (±2.5, per characterization), top-to-bottom, left-to-right.
// Raw PDF item order is NOT trusted (header cells/spacers interleave).
// ---------------------------------------------------------------------------

const LINE_Y_TOLERANCE = 2.5;

interface BluLine {
  page: number;
  y: number;
  text: string; // items sorted by x, joined
  items: { x: number; font: string }[];
}

function toLines(pages: ExtractedPage[]): BluLine[] {
  const lines: BluLine[] = [];
  for (const p of pages) {
    const sorted = [...p.items].sort((a, b) => b.y - a.y || a.x - b.x);
    const pageLines: { y: number; items: { text: string; x: number; font: string }[] }[] = [];
    for (const it of sorted) {
      const ln = pageLines.find((l) => Math.abs(l.y - it.y) <= LINE_Y_TOLERANCE);
      const entry = { text: it.text, x: it.x, font: it.fontName };
      if (ln) ln.items.push(entry);
      else pageLines.push({ y: it.y, items: [entry] });
    }
    for (const ln of pageLines) {
      ln.items.sort((a, b) => a.x - b.x);
      lines.push({
        page: p.pageNumber,
        y: ln.y,
        text: ln.items.map((i) => i.text).join(""),
        items: ln.items,
      });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Noise: categorized, anchored patterns for VERIFIED document furniture only.
// A date anchor always wins over noise (never filter a possible transaction).
// ---------------------------------------------------------------------------

const PAGE_NUMBER_RES = [/^\s*Halaman\s+\d+\s+dari\s+\d+\s*$/, /^\s*Page\s+\d+\s+of\s+\d+\s*$/];

const LEGAL_TOKENS = [
  "berizin dan diawasi",
  "licensed & supervised",
  "peserta penjaminan",
  "Deposit Insurance Corporation",
  "Otoritas Jasa Keuangan",
];

const CONTACT_RES = [/blubybcadigital\.id/, /haloblu\s+\d/i];

const COLUMN_HEADER_TOKENS = [
  "Tanggal & Jam",
  "Date & Time",
  "Detail Transaksi | Ref",
  "Transaction Details | Ref",
  "Sisa Saldo",
  "Remaining Balance",
];

const DISCLAIMER_TOKENS = [
  "Laporan ini",
  "This report",
  "BCA Digital sewaktu-waktu",
  "corrections to improve",
  "tidak bertanggung jawab",
  "misuse of this report",
  "sah tanpa tanda tangan",
  "legitimate without the signature",
];

function isNoiseLine(text: string): boolean {
  const t = text.trim();
  if (t === "") return true;
  if (PAGE_NUMBER_RES.some((re) => re.test(t))) return true;
  // ponytail: page title "bluAccount | bluSpending" is exact-matched so the
  // same words inside transaction descriptions are never filtered.
  if (/^bluAccount\s*\|\s*bluSpending$/.test(t)) return true;
  if (LEGAL_TOKENS.some((tok) => t.includes(tok))) return true;
  if (CONTACT_RES.some((re) => re.test(t))) return true;
  if (COLUMN_HEADER_TOKENS.some((tok) => t.includes(tok))) return true;
  if (t === "Disclaimer") return true;
  if (/^\d\.\s/.test(t) && DISCLAIMER_TOKENS.some((tok) => t.includes(tok))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Structural matchers (anchored; no giant regex).
// ---------------------------------------------------------------------------

const MONTHS = Object.keys(BLU_MONTHS).join("|");
const DATE_ANCHOR_RE = new RegExp(`^(\\d{2})\\s+(${MONTHS})\\s+(\\d{4})\\s*(.*)$`);
const TIME_RE = /^(\d{2}):(\d{2})$/;
const POCKET_HEADER_RE = /^blu(Account|Spending)\s+-\s+(.+)$/;
// Auxiliary header cues (verified sample: openers at x≈206-211 in the f4
// face; inline transfer details sit at the x=140 description column in the
// body face). Either cue plus the pattern opens a pocket; inline detail
// lines carry neither. Ranges stay tolerant, never exact coordinates.
const POCKET_HEADER_MIN_X = 170;
const POCKET_HEADER_FONT_RE = /_f4$/;

function matchPocketHeader(line: BluLine): BluPocketId | null {
  const m = POCKET_HEADER_RE.exec(line.text.trim());
  if (!m) return null;
  const first = line.items[0];
  const cued =
    (first !== undefined && first.x >= POCKET_HEADER_MIN_X) ||
    (first !== undefined && POCKET_HEADER_FONT_RE.test(first.font));
  if (!cued) return null;
  const account = m[2].trim();
  return { name: `blu${m[1]}`, account: account ? account : null };
}
const SUMMARY_LABEL_RE = /^(Saldo Awal|Total Pemasukan|Total Pengeluaran|Saldo Akhir)\b/;
const NUM_TOKEN_RE = /-?\s?[\d.]+\,\d{2}/g;
const PERIOD_RE = /(\d{2})\s*-\s*(\d{2})\s+([A-Za-z]+)\s+(\d{4})/;
// Pre-pocket document header vocabulary (verified page-1 labels). Amount
// tokens may only appear pre-pocket on lines carrying these labels.
const DOC_LABEL_RE =
  /Nama|Name|Periode|Period|Rekening|Account|Mata Uang|Currency|Total Pemasukan|Total Pengeluaran|Saldo Awal|Saldo Akhir|IDR|Rp/;
const REFERENCE_RE = /^[A-Za-z0-9]{4,64}$/;

type SummaryLabel = "Saldo Awal" | "Total Pemasukan" | "Total Pengeluaran" | "Saldo Akhir";

interface OpenPocket {
  id: BluPocketId;
  startPage: number;
  rows: BluCanonicalRow[];
  openingMinor: bigint | null;
  totalIncomeMinor: bigint;
  totalExpenseMinor: bigint;
  closingMinor: bigint | null;
  summarySeen: Partial<Record<SummaryLabel, bigint>>;
  diagnostics: BluDiagnostic[];
}

function pocketLabel(id: BluPocketId): string {
  return id.account ? `${id.name} - ${id.account}` : id.name;
}

function lastNumToken(text: string): string | null {
  const m = text.match(NUM_TOKEN_RE);
  return m && m.length > 0 ? m[m.length - 1] : null;
}

function countNumTokens(text: string): number {
  const m = text.match(NUM_TOKEN_RE);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Block parser: date line -> amount+balance line -> time line -> detail lines.
// Returns the row (reference may be null) or a reason code. Never fabricates.
// ---------------------------------------------------------------------------

function parseBlock(
  lines: BluLine[],
  at: number,
  pocket: BluPocketId,
  rowIndex: number,
): { row: BluCanonicalRow; next: number } | { code: BluReasonCode; next: number } {
  const dateLine = lines[at];
  const dm = DATE_ANCHOR_RE.exec(dateLine.text.trim());
  if (!dm) return { code: "MALFORMED_DATE", next: at + 1 };
  const date = parseBluDate(dm[1], dm[2], dm[3]);
  const remark1 = dm[4].trim().replace(/\s+/g, " ");
  if (!date || !remark1) return { code: "MALFORMED_DATE", next: at + 1 };

  const amountLine = lines[at + 1];
  if (!amountLine || countNumTokens(amountLine.text) !== 2)
    return { code: "INCOMPLETE_BLOCK", next: at + 1 };
  const tokens = amountLine.text.match(NUM_TOKEN_RE);
  if (!tokens || tokens.length !== 2) return { code: "INCOMPLETE_BLOCK", next: at + 1 };
  const amount = parseIdrMinor(tokens[0]);
  if (!amount) return { code: "MALFORMED_AMOUNT", next: at + 1 };
  // ponytail: blu prints the balance unsigned; a signed second token means
  // the columns cannot be told apart, so the block is rejected, not guessed.
  if (/^\s*-/.test(tokens[1])) return { code: "MALFORMED_BALANCE", next: at + 1 };
  const balance = parseIdrMinor(tokens[1]);
  if (!balance) return { code: "MALFORMED_BALANCE", next: at + 1 };

  const timeLine = lines[at + 2];
  if (!timeLine) return { code: "INCOMPLETE_BLOCK", next: at + 1 };
  const tm = TIME_RE.exec(timeLine.text.trim());
  const time = tm ? parseBluTime(tm[1], tm[2]) : null;
  if (!time) return { code: "MALFORMED_TIME", next: at + 1 };

  // Detail lines: skip page furniture (headers/footers between transaction
  // lines are verified noise), stop at the next structural boundary. A
  // trailing "|" pulls the next detail line in (wrapped reference).
  const detail: string[] = [];
  let i = at + 3;
  for (;;) {
    const ln = lines[i];
    if (!ln) break;
    const t = ln.text.trim();
    if (
      DATE_ANCHOR_RE.test(t) ||
      matchPocketHeader(ln) !== null ||
      SUMMARY_LABEL_RE.test(t)
    )
      break;
    if (isNoiseLine(t)) {
      i++;
      continue;
    }
    detail.push(t.replace(/\s+/g, " "));
    i++;
    const joined = detail.join(" ").trim();
    if (!joined.endsWith("|")) break;
    // Wrapped reference: exactly one continuation line is pulled in; if the
    // text still has no usable reference it stays null (never a rejection).
  }

  const description = [remark1, ...detail].join(" ").trim();
  let reference: string | null = null;
  const bar = description.indexOf("|");
  if (bar !== -1) {
    const right = description.slice(bar + 1).trim();
    if (REFERENCE_RE.test(right)) reference = right;
  }

  return {
    row: {
      pocket,
      rowIndex,
      date,
      time,
      statementDirection: amount.negative ? "EXPENSE" : "INCOME",
      amountMinor: amount.minor < 0n ? -amount.minor : amount.minor,
      wholeIdrEligible: amount.isWholeIdr,
      balanceMinor: balance.minor,
      description,
      reference,
      possibleInternalTransfer: false,
    },
    next: i,
  };
}

// ---------------------------------------------------------------------------
// Page walker: pocket state machine + document header + summaries.
// ---------------------------------------------------------------------------

export function parseBluPages(pages: ExtractedPage[]): BluParseResult {
  const noText = pages.every((p) => p.items.every((i) => i.text.trim() === ""));
  const detected = detectBlu(pages);
  const base: Omit<BluParseResult, "pockets" | "importable" | "diagnostics" | "globalReconciled"> = {
    detected,
    statementPeriod: null,
  };
  if (noText) {
    return {
      ...base,
      pockets: [],
      globalReconciled: null,
      importable: false,
      diagnostics: [{ pocket: null, page: null, rowIndex: null, code: "NO_TEXT_LAYER" }],
    };
  }

  const lines = toLines(pages);
  const pockets: BluPocketResult[] = [];
  const diagnostics: BluDiagnostic[] = [];
  let current: OpenPocket | null = null;
  let seenPocket = false;
  let period: BluStatementPeriod | null = null;

  const closePocket = (endPage: number | null): void => {
    if (!current) return;
    const reconciled = reconcilePocket(current);
    if (!reconciled) {
      current.diagnostics.push({
        pocket: pocketLabel(current.id),
        page: endPage,
        rowIndex: null,
        code: "RECONCILIATION_MISMATCH",
      });
    }
    const importable = reconciled && current.diagnostics.length === 0;
    pockets.push({
      pocket: current.id,
      openingMinor: current.openingMinor,
      totalIncomeMinor: current.totalIncomeMinor,
      totalExpenseMinor: current.totalExpenseMinor,
      closingMinor: current.closingMinor,
      rows: current.rows,
      reconciled,
      importable,
      diagnostics: current.diagnostics,
    });
    current = null;
  };

  const recordSummary = (
    label: SummaryLabel,
    line: BluLine,
    target: Partial<Record<SummaryLabel, bigint>>,
  ): boolean => {
    const tok = lastNumToken(line.text);
    const parsed = tok ? parseIdrMinor(tok) : null;
    if (!parsed) return false;
    // ponytail: Total Pengeluaran prints with a "-" prefix ("-X"); totals
    // accumulate as magnitudes, direction comes from the label, not the sign.
    target[label] = parsed.minor < 0n ? -parsed.minor : parsed.minor;
    return true;
  };

  let i = 0;
  // Pre-pocket document header pairs a label line
  // ("Total Pemasukan / Total Income ... Saldo Awal / ...") with the next
  // amount line ("... Rp 5.191.221,00 Rp 6.297,01"), values in label order.
  // Pairing is positional but fail-closed: token count or parse mismatch
  // raises GLOBAL_MISMATCH instead of guessing.
  let pendingGlobal: "inc-open" | "exp-close" | null = null;
  const printedGlobal: Partial<Record<SummaryLabel, bigint>> = {};
  const assignGlobalPair = (
    kind: "inc-open" | "exp-close",
    line: BluLine,
  ): boolean => {
    const toks = line.text.match(NUM_TOKEN_RE);
    if (!toks || toks.length !== 2) return false;
    const first = parseIdrMinor(toks[0]);
    const second = parseIdrMinor(toks[1]);
    if (!first || !second) return false;
    const mag = (v: bigint) => (v < 0n ? -v : v);
    if (kind === "inc-open") {
      printedGlobal["Total Pemasukan"] = mag(first.minor);
      printedGlobal["Saldo Awal"] = mag(second.minor);
    } else {
      printedGlobal["Total Pengeluaran"] = mag(first.minor);
      printedGlobal["Saldo Akhir"] = mag(second.minor);
    }
    return true;
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.text.trim();
    if (isNoiseLine(t)) {
      i++;
      continue;
    }
    const pocketId = matchPocketHeader(line);
    if (pocketId) {
      if (current) closePocket(line.page);
      seenPocket = true;
      current = {
        id: pocketId,
        startPage: line.page,
        rows: [],
        openingMinor: null,
        totalIncomeMinor: 0n,
        totalExpenseMinor: 0n,
        closingMinor: null,
        summarySeen: {},
        diagnostics: [],
      };
      i++;
      continue;
    }
    const summaryMatch = SUMMARY_LABEL_RE.exec(t);
    // ponytail: label-only header lines ("Total Pemasukan / Total Income")
    // carry no amount and are document furniture, not pocket summaries.
    const hasSummaryAmount = summaryMatch && countNumTokens(t) > 0;
    if (summaryMatch && hasSummaryAmount) {
      const label = summaryMatch[1] as SummaryLabel;
      if (!current) {
        // Pre-pocket summary values outside the verified label/value pairing
        // are unexpected structure: fail closed, never silently consumed.
        diagnostics.push({
          pocket: null,
          page: line.page,
          rowIndex: null,
          code: seenPocket ? "UNRECOGNIZED_STRUCTURE" : "GLOBAL_MISMATCH",
        });
        i++;
        continue;
      }
      const ok = recordSummary(label, line, current.summarySeen);
      if (ok) {
        const v = current.summarySeen[label];
        if (v !== undefined) {
          if (label === "Saldo Awal") current.openingMinor = v;
          if (label === "Total Pemasukan") current.totalIncomeMinor = v;
          if (label === "Total Pengeluaran") current.totalExpenseMinor = v;
          if (label === "Saldo Akhir") {
            current.closingMinor = v;
            closePocket(line.page);
          }
        }
      } else {
        current.diagnostics.push({
          pocket: pocketLabel(current.id),
          page: line.page,
          rowIndex: null,
          code: "MALFORMED_SUMMARY",
        });
      }
      i++;
      continue;
    }
    if (DATE_ANCHOR_RE.test(t)) {
      if (!current) {
        diagnostics.push({ pocket: null, page: line.page, rowIndex: null, code: "NO_POCKET_CONTEXT" });
        i++;
        continue;
      }
      const parsed = parseBlock(lines, i, current.id, current.rows.length);
      if ("row" in parsed) {
        const row = parsed.row;
        current.rows.push(row);
        if (row.statementDirection === "INCOME") current.totalIncomeMinor += row.amountMinor;
        else current.totalExpenseMinor += row.amountMinor;
        // ponytail: non-,00 fractions cannot enter the whole-IDR ledger, so
        // the row is kept for review but the pocket is blocked from import.
        if (!row.wholeIdrEligible) {
          current.diagnostics.push({
            pocket: pocketLabel(current.id),
            page: line.page,
            rowIndex: row.rowIndex,
            code: "NON_WHOLE_IDR_AMOUNT",
          });
        }
        i = parsed.next;
      } else {
        current.diagnostics.push({
          pocket: pocketLabel(current.id),
          page: line.page,
          rowIndex: current.rows.length,
          code: parsed.code,
        });
        i = parsed.next;
      }
      continue;
    }
    // Pre-pocket document header: verified labels may carry Rp amounts;
    // anything else carrying an amount token here fails closed.
    if (!seenPocket) {
      if (/Total Pemasukan/.test(t) && /Saldo Awal/.test(t) && countNumTokens(t) === 0) {
        pendingGlobal = "inc-open";
        i++;
        continue;
      }
      if (/Total Pengeluaran/.test(t) && /Saldo Akhir/.test(t) && countNumTokens(t) === 0) {
        pendingGlobal = "exp-close";
        i++;
        continue;
      }
      if (pendingGlobal) {
        const kind = pendingGlobal;
        pendingGlobal = null;
        if (!assignGlobalPair(kind, line)) {
          diagnostics.push({ pocket: null, page: line.page, rowIndex: null, code: "GLOBAL_MISMATCH" });
        }
        if (!period) {
          const pm = PERIOD_RE.exec(t);
          if (pm) {
            const from = parseBluDate(pm[1], pm[3], pm[4]);
            const to = parseBluDate(pm[2], pm[3], pm[4]);
            if (from && to) period = { from, to };
          }
        }
        i++;
        continue;
      }
      if (!DOC_LABEL_RE.test(t) && countNumTokens(t) > 0) {
        diagnostics.push({ pocket: null, page: line.page, rowIndex: null, code: "UNRECOGNIZED_STRUCTURE" });
      }
      if (!period) {
        const pm = PERIOD_RE.exec(t);
        if (pm) {
          const from = parseBluDate(pm[1], pm[3], pm[4]);
          const to = parseBluDate(pm[2], pm[3], pm[4]);
          if (from && to) period = { from, to };
        }
      }
      i++;
      continue;
    }
    // Post-pocket verified furniture is noise (filtered above); stray
    // financial content outside any pocket fails closed, plain text is left
    // alone so future layout variants degrade to review, not silent loss.
    if (countNumTokens(t) > 0) {
      diagnostics.push({ pocket: null, page: line.page, rowIndex: null, code: "UNRECOGNIZED_STRUCTURE" });
    }
    i++;
  }
  if (current) closePocket(lines.length > 0 ? lines[lines.length - 1].page : null);

  if (seenPocket && pockets.length === 0) {
    diagnostics.push({ pocket: null, page: null, rowIndex: null, code: "NO_POCKET_FOUND" });
  }

  flagPossibleInternalTransfers(pockets);

  // Global cross-check: printed document-header totals must equal the
  // pocket-aggregate sums AND be self-consistent. Either failure blocks.
  let globalReconciled: boolean | null = null;
  const gOpen = printedGlobal["Saldo Awal"];
  const gInc = printedGlobal["Total Pemasukan"];
  const gExp = printedGlobal["Total Pengeluaran"];
  const gClose = printedGlobal["Saldo Akhir"];
  if (gOpen !== undefined && gInc !== undefined && gExp !== undefined && gClose !== undefined) {
    const sumOpen = pockets.reduce((n, p) => n + (p.openingMinor ?? 0n), 0n);
    const sumInc = pockets.reduce((n, p) => n + p.totalIncomeMinor, 0n);
    const sumExp = pockets.reduce((n, p) => n + p.totalExpenseMinor, 0n);
    const sumClose = pockets.reduce((n, p) => n + (p.closingMinor ?? 0n), 0n);
    globalReconciled =
      gOpen + gInc - gExp === gClose &&
      gOpen === sumOpen &&
      gInc === sumInc &&
      gExp === sumExp &&
      gClose === sumClose;
    if (!globalReconciled) {
      diagnostics.push({ pocket: null, page: null, rowIndex: null, code: "GLOBAL_MISMATCH" });
    }
  }

  const importable =
    pockets.length > 0 &&
    pockets.every((p) => p.importable) &&
    diagnostics.length === 0;
  return { detected, statementPeriod: period, pockets, globalReconciled, importable, diagnostics };
}

// Exact integer-minor-unit reconciliation: running chain plus
// opening + income - expense = closing. Never adjusts amounts.
function reconcilePocket(p: OpenPocket): boolean {
  if (p.openingMinor === null || p.closingMinor === null) return false;
  let balance = p.openingMinor;
  let income = 0n;
  let expense = 0n;
  for (const row of p.rows) {
    if (row.statementDirection === "INCOME") {
      balance += row.amountMinor;
      income += row.amountMinor;
    } else {
      balance -= row.amountMinor;
      expense += row.amountMinor;
    }
    if (balance !== row.balanceMinor) return false;
  }
  return income === p.totalIncomeMinor && expense === p.totalExpenseMinor && balance === p.closingMinor;
}

// Diagnostic cross-pocket pairing hint only: same date + same whole-IDR
// magnitude, opposite statement directions, different pockets. Changes
// nothing: rows are kept verbatim for the future semantic layer.
function flagPossibleInternalTransfers(pockets: BluPocketResult[]): void {
  const byKey = new Map<string, BluCanonicalRow[]>();
  for (const p of pockets) {
    for (const row of p.rows) {
      if (!row.wholeIdrEligible) continue;
      const key = `${row.date}|${row.amountMinor.toString()}`;
      const list = byKey.get(key);
      if (list) list.push(row);
      else byKey.set(key, [row]);
    }
  }
  for (const rows of byKey.values()) {
    if (rows.length < 2) continue;
    const pocketsSeen = new Set(rows.map((r) => pocketLabel(r.pocket)));
    if (pocketsSeen.size < 2) continue;
    const hasIncome = rows.some((r) => r.statementDirection === "INCOME");
    const hasExpense = rows.some((r) => r.statementDirection === "EXPENSE");
    if (hasIncome && hasExpense) {
      for (const r of rows) r.possibleInternalTransfer = true;
    }
  }
}

// Full pipeline: PDF bytes -> candidates. Throws PdfExtractError on
// unreadable/encrypted input and BluError when the bank is unrecognized.
export async function parseBluPdf(pdf: Buffer): Promise<BluParseResult> {
  const pages = await extractPdfPages(pdf);
  const detected = detectBlu(pages);
  if (!detected.isBlu) {
    throw new BluError(400, "unsupported statement format", "UNSUPPORTED_STATEMENT");
  }
  return parseBluPages(pages);
}
