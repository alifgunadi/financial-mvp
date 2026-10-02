// Blu statement semantic layer: pure mapping from parser candidates
// (BluParseResult) to ledger import candidates. No DB, no routes, no side
// effects. Every row appears exactly once with a disposition; nothing is
// silently dropped. Deliberately undecided here: category assignment,
// fingerprint uniqueness enforcement, and batch status transitions.
import { createHash } from "node:crypto";
import type {
  BluParseResult,
  BluPocketId,
  StatementDirection,
} from "./bluParse.js";

export type CandidateDisposition =
  | "READY"
  | "SKIPPED_INTERNAL_TRANSFER"
  | "BLOCKED_FRACTIONAL"
  | "BLOCKED_UNRECONCILED";

export interface ImportCandidate {
  // Ledger-shaped fields. `type` reuses the parser direction literals
  // (same set as the Transaction enum); category is intentionally absent.
  type: StatementDirection;
  // Whole IDR units like Transaction.amount. Exact (amountMinor / 100n)
  // when eligible, otherwise 0n — the disposition says why.
  amount: bigint;
  // YYYY-MM-DD calendar date.
  date: string;
  // Reserved: the parser does not split a merchant out of the description
  // yet, so the full text stays in `note`.
  merchant: string | null;
  // Source description, verbatim from the parser.
  note: string;
  reference: string | null;
  // sha256 hex of the canonical row string (see fingerprintRow).
  fingerprint: string;
  disposition: CandidateDisposition;
  // Provenance for review UIs.
  pocket: string;
  rowIndex: number;
}

export interface CandidateSummary {
  total: number;
  ready: number;
  skippedInternalTransfer: number;
  blockedFractional: number;
  blockedUnreconciled: number;
  // Sums over READY rows only, whole IDR units.
  readyIncome: bigint;
  readyExpense: bigint;
}

function pocketLabel(id: BluPocketId): string {
  return id.account ? `${id.name} - ${id.account}` : id.name;
}

// Whitespace-normalized description (the parser already normalizes, this
// keeps the fingerprint stable even if that ever changes upstream).
function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, " ");
}

// balanceMinor is included so two otherwise identical rows (same date,
// time, amount, description) still differ: the running balance between
// them moved. This is also what makes the same row re-appear identical
// across overlapping statements (same balance) — the desired dedupe case.
// Encoding is JSON, never a bare join: a "|" inside a field value must not
// shift fields. Format locked by test — do not change once stored.
export function fingerprintRow(
  pocket: BluPocketId,
  date: string,
  time: string,
  statementDirection: StatementDirection,
  amountMinor: bigint,
  balanceMinor: bigint,
  description: string,
): string {
  const canonical = JSON.stringify([
    // account is the stable cross-statement identity (pocket display
    // names may change); name is only a fallback when account is null.
    pocket.account ?? pocket.name,
    date,
    time,
    statementDirection,
    amountMinor.toString(),
    balanceMinor.toString(),
    normalizeDescription(description),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

// Priority order matters: an unreconciled pocket blocks everything in it,
// fractional amounts can never enter the whole-IDR ledger, and suspected
// internal transfers are skipped (not blocked: no data problem found).
export function toImportCandidates(result: BluParseResult): ImportCandidate[] {
  const candidates: ImportCandidate[] = [];
  for (const pocket of result.pockets) {
    const label = pocketLabel(pocket.pocket);
    for (const row of pocket.rows) {
      let disposition: CandidateDisposition;
      if (!pocket.importable) disposition = "BLOCKED_UNRECONCILED";
      else if (!row.wholeIdrEligible) disposition = "BLOCKED_FRACTIONAL";
      else if (row.possibleInternalTransfer)
        disposition = "SKIPPED_INTERNAL_TRANSFER";
      else disposition = "READY";
      candidates.push({
        type: row.statementDirection,
        // Exact: wholeIdrEligible means amountMinor % 100n === 0.
        amount: row.wholeIdrEligible ? row.amountMinor / 100n : 0n,
        date: row.date,
        merchant: null,
        note: row.description,
        reference: row.reference,
        fingerprint: fingerprintRow(
          row.pocket,
          row.date,
          row.time,
          row.statementDirection,
          row.amountMinor,
          row.balanceMinor,
          row.description,
        ),
        disposition,
        pocket: label,
        rowIndex: row.rowIndex,
      });
    }
  }
  return candidates;
}

export function summarizeCandidates(
  candidates: ImportCandidate[],
): CandidateSummary {
  const summary: CandidateSummary = {
    total: candidates.length,
    ready: 0,
    skippedInternalTransfer: 0,
    blockedFractional: 0,
    blockedUnreconciled: 0,
    readyIncome: 0n,
    readyExpense: 0n,
  };
  for (const c of candidates) {
    switch (c.disposition) {
      case "READY":
        summary.ready++;
        if (c.type === "INCOME") summary.readyIncome += c.amount;
        else summary.readyExpense += c.amount;
        break;
      case "SKIPPED_INTERNAL_TRANSFER":
        summary.skippedInternalTransfer++;
        break;
      case "BLOCKED_FRACTIONAL":
        summary.blockedFractional++;
        break;
      case "BLOCKED_UNRECONCILED":
        summary.blockedUnreconciled++;
        break;
    }
  }
  return summary;
}
