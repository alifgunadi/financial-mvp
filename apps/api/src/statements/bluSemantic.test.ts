// Semantic-layer tests (node:test, no new dependencies).
// All data is fictitious. Run: node --import tsx --test src/statements/bluSemantic.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  fingerprintRow,
  summarizeCandidates,
  toImportCandidates,
} from "./bluSemantic.js";
import type {
  BluCanonicalRow,
  BluParseResult,
  BluPocketId,
  BluPocketResult,
} from "./bluParse.js";

const pocketA: BluPocketId = { name: "bluAccount", account: "111" };

function row(overrides: Partial<BluCanonicalRow> = {}): BluCanonicalRow {
  return {
    pocket: pocketA,
    rowIndex: 0,
    date: "2026-08-01",
    time: "14:22",
    statementDirection: "EXPENSE",
    amountMinor: 5000000n,
    wholeIdrEligible: true,
    balanceMinor: 629701n,
    description: "QRIS MERCHANT X | REF12345",
    reference: "REF12345",
    possibleInternalTransfer: false,
    ...overrides,
  };
}

function pocketResult(
  rows: BluCanonicalRow[],
  overrides: Partial<BluPocketResult> = {},
): BluPocketResult {
  return {
    pocket: pocketA,
    openingMinor: 5629701n,
    totalIncomeMinor: 0n,
    totalExpenseMinor: 5000000n,
    closingMinor: 629701n,
    rows,
    reconciled: true,
    importable: true,
    diagnostics: [],
    ...overrides,
  };
}

function parseResult(pockets: BluPocketResult[]): BluParseResult {
  return {
    detected: { isBlu: true, confidence: 1, signals: [] },
    statementPeriod: { from: "2026-08-01", to: "2026-08-31" },
    pockets,
    globalReconciled: true,
    importable: true,
    diagnostics: [],
  };
}

describe("toImportCandidates disposition", () => {
  it("READY: plain row converts amountMinor to whole IDR", () => {
    const [c] = toImportCandidates(parseResult([pocketResult([row()])]));
    assert.equal(c.disposition, "READY");
    assert.equal(c.type, "EXPENSE");
    assert.equal(c.amount, 50000n);
    assert.equal(c.date, "2026-08-01");
    assert.match(c.fingerprint, /^[0-9a-f]{64}$/);
  });

  it("SKIPPED_INTERNAL_TRANSFER: flagged row is skipped, not blocked", () => {
    const [c] = toImportCandidates(
      parseResult([pocketResult([row({ possibleInternalTransfer: true })])]),
    );
    assert.equal(c.disposition, "SKIPPED_INTERNAL_TRANSFER");
    assert.equal(c.amount, 50000n);
  });

  it("BLOCKED_FRACTIONAL: non-whole-IDR row carries amount 0n", () => {
    const [c] = toImportCandidates(
      parseResult([
        pocketResult([row({ amountMinor: 5000001n, wholeIdrEligible: false })]),
      ]),
    );
    assert.equal(c.disposition, "BLOCKED_FRACTIONAL");
    assert.equal(c.amount, 0n);
  });

  it("BLOCKED_UNRECONCILED: every row of a bad pocket is blocked", () => {
    const out = toImportCandidates(
      parseResult([
        pocketResult([row(), row({ rowIndex: 1 })], { importable: false }),
      ]),
    );
    assert.equal(out.length, 2);
    for (const c of out) assert.equal(c.disposition, "BLOCKED_UNRECONCILED");
  });

  it("priority: unreconciled wins, then fractional, then transfer flag", () => {
    const [worst] = toImportCandidates(
      parseResult([
        pocketResult(
          [
            row({
              amountMinor: 1n,
              wholeIdrEligible: false,
              possibleInternalTransfer: true,
            }),
          ],
          { importable: false },
        ),
      ]),
    );
    assert.equal(worst.disposition, "BLOCKED_UNRECONCILED");
    const [frac] = toImportCandidates(
      parseResult([
        pocketResult([
          row({
            amountMinor: 1n,
            wholeIdrEligible: false,
            possibleInternalTransfer: true,
          }),
        ]),
      ]),
    );
    assert.equal(frac.disposition, "BLOCKED_FRACTIONAL");
  });

  it("no row is dropped: candidates equal total rows", () => {
    const out = toImportCandidates(
      parseResult([
        pocketResult([row(), row({ rowIndex: 1 })]),
        pocketResult([row({ rowIndex: 0 })], {
          pocket: { name: "bluSpending", account: "222" },
        }),
      ]),
    );
    assert.equal(out.length, 3);
  });
});

describe("fingerprintRow", () => {
  it("twin rows differing only in balance get different fingerprints", () => {
    const a = fingerprintRow(
      pocketA, "2026-08-01", "14:22", "EXPENSE", 5000000n, 629701n, "SAME DESC",
    );
    const b = fingerprintRow(
      pocketA, "2026-08-01", "14:22", "EXPENSE", 5000000n, 129701n, "SAME DESC",
    );
    assert.notEqual(a, b);
  });

  it("the same row in two parse results gets an identical fingerprint", () => {
    const left = toImportCandidates(parseResult([pocketResult([row()])]));
    const right = toImportCandidates(parseResult([pocketResult([row()])]));
    assert.equal(left[0].fingerprint, right[0].fingerprint);
  });

  it("separator collision: a pipe inside a field cannot shift fields", () => {
    const base = {
      time: "14:22",
      statementDirection: "EXPENSE" as const,
      amountMinor: 5000000n,
      balanceMinor: 629701n,
      description: "SAME",
    };
    const shifted = fingerprintRow(
      { name: "bluAccount", account: "AC" },
      "01|2026-08-01",
      base.time,
      base.statementDirection,
      base.amountMinor,
      base.balanceMinor,
      base.description,
    );
    const unshifted = fingerprintRow(
      { name: "bluAccount", account: "AC|01" },
      "2026-08-01",
      base.time,
      base.statementDirection,
      base.amountMinor,
      base.balanceMinor,
      base.description,
    );
    // Under the old join("|") format both inputs hashed identically.
    const oldOf = (account: string, date: string): string =>
      createHash("sha256")
        .update(
          [account, date, base.time, base.statementDirection,
            base.amountMinor.toString(), base.balanceMinor.toString(),
            base.description].join("|"),
        )
        .digest("hex");
    assert.equal(oldOf("AC", "01|2026-08-01"), oldOf("AC|01", "2026-08-01"));
    assert.notEqual(shifted, unshifted);
  });

  it("format is locked: manual JSON array hashes to the same value", () => {
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          "111",
          "2026-08-01",
          "14:22",
          "EXPENSE",
          "5000000",
          "629701",
          "QRIS MERCHANT X | REF12345",
        ]),
      )
      .digest("hex");
    const actual = fingerprintRow(
      { name: "bluAccount", account: "111" },
      "2026-08-01",
      "14:22",
      "EXPENSE",
      5000000n,
      629701n,
      "QRIS MERCHANT X | REF12345",
    );
    assert.equal(actual, expected);
  });

  it("null account falls back to pocket name without colliding", () => {
    const noAccount = fingerprintRow(
      { name: "bluSpending", account: null },
      "2026-08-01", "14:22", "EXPENSE", 5000000n, 629701n, "SAME",
    );
    const withAccount = fingerprintRow(
      { name: "bluSpending", account: "222" },
      "2026-08-01", "14:22", "EXPENSE", 5000000n, 629701n, "SAME",
    );
    const otherAccount = fingerprintRow(
      { name: "bluAccount", account: "111" },
      "2026-08-01", "14:22", "EXPENSE", 5000000n, 629701n, "SAME",
    );
    assert.match(noAccount, /^[0-9a-f]{64}$/);
    assert.notEqual(noAccount, withAccount);
    assert.notEqual(withAccount, otherAccount);
  });
});

describe("summarizeCandidates", () => {
  it("counts per disposition and sums READY income/expense only", () => {
    const out = toImportCandidates(
      parseResult([
        pocketResult([
          { ...row(), statementDirection: "INCOME", amountMinor: 10000n, rowIndex: 0 },
          { ...row(), rowIndex: 1 },
          { ...row(), rowIndex: 2, possibleInternalTransfer: true },
          { ...row(), rowIndex: 3, amountMinor: 1n, wholeIdrEligible: false },
        ]),
        pocketResult([{ ...row(), rowIndex: 0 }], { importable: false }),
      ]),
    );
    const s = summarizeCandidates(out);
    assert.equal(s.total, 5);
    assert.equal(s.ready, 2);
    assert.equal(s.skippedInternalTransfer, 1);
    assert.equal(s.blockedFractional, 1);
    assert.equal(s.blockedUnreconciled, 1);
    assert.equal(s.readyIncome, 100n);
    assert.equal(s.readyExpense, 50000n);
    assert.equal(s.total, out.length);
  });
});
