// Blu-statement detection: weighted distinctive-signal match over extracted
// text. Multiple signals required — never a single-string guess. Threshold
// and weights are documented here so a future registry can reuse the shape.

import type { ExtractedPage } from "./pdfExtract.js";

export interface BluSignal {
  id: string;
  weight: number;
  matched: boolean;
}

export interface BluDetection {
  isBlu: boolean;
  confidence: number;
  signals: BluSignal[];
}

// Sum of weights is 1.0; isBlu requires confidence >= 0.6.
const SIGNAL_DEFS: { id: string; weight: number; test: RegExp }[] = [
  { id: "blu_by_bca_digital", weight: 0.2, test: /blu\s+by\s+BCA\s+Digital/i },
  { id: "blu_account", weight: 0.15, test: /bluAccount/ },
  { id: "blu_spending", weight: 0.15, test: /bluSpending/ },
  { id: "halaman_dari", weight: 0.15, test: /Halaman\s+\d+\s+dari\s+\d+/ },
  { id: "total_pemasukan", weight: 0.1, test: /Total Pemasukan/ },
  { id: "total_pengeluaran", weight: 0.1, test: /Total Pengeluaran/ },
  { id: "bca_digital_berizin", weight: 0.1, test: /BCA Digital berizin/ },
  { id: "haloblu", weight: 0.05, test: /haloblu/i },
];

export const BLU_CONFIDENCE_THRESHOLD = 0.6;

export function detectBlu(pages: ExtractedPage[]): BluDetection {
  const haystack = pages.map((p) => p.items.map((i) => i.text).join("\n")).join("\n");
  const signals: BluSignal[] = SIGNAL_DEFS.map((s) => ({
    id: s.id,
    weight: s.weight,
    matched: s.test.test(haystack),
  }));
  const confidence = signals.reduce((n, s) => n + (s.matched ? s.weight : 0), 0);
  return {
    isBlu: confidence >= BLU_CONFIDENCE_THRESHOLD,
    confidence: Math.round(confidence * 100) / 100,
    signals,
  };
}
