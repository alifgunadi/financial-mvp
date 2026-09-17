// Indonesian-statement numeric parsing. String-based only: floats never
// touch money. 1 unit = 1 minor unit (sen); whole IDR = minor % 100 === 0.

export interface MinorAmount {
  minor: bigint;
  negative: boolean;
  isWholeIdr: boolean;
}

// Strict: "100.000,00" / "- 55.476,00" / "106.297,01". Null when malformed.
export function parseIdrMinor(raw: string): MinorAmount | null {
  const m = /^(-?)\s?(\d{1,3}(?:\.\d{3})*),(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, sign, intPart, fracPart] = m;
  const minor =
    BigInt(intPart.replace(/\./g, "")) * 100n + BigInt(fracPart);
  return {
    minor: sign === "-" ? -minor : minor,
    negative: sign === "-",
    isWholeIdr: fracPart === "00",
  };
}

// Indonesian month abbreviations as printed on blu statements.
export const BLU_MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  Mei: "05",
  Jun: "06",
  Jul: "07",
  Agu: "08",
  Sep: "09",
  Okt: "10",
  Nov: "11",
  Des: "12",
};

// Calendar-validated YYYY-MM-DD, or null. Same UTC-midnight discipline as
// the existing dateSchema (validate.ts).
export function parseBluDate(day: string, mon: string, year: string): string | null {
  const mm = BLU_MONTHS[mon];
  if (!mm) return null;
  const s = `${year}-${mm}-${day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

// Wall-clock HH:mm (Asia/Jakarta statement time, documented assumption).
export function parseBluTime(hh: string, mm: string): string | null {
  if (!/^\d{2}:\d{2}$/.test(`${hh}:${mm}`)) return null;
  const h = Number(hh);
  const m = Number(mm);
  if (h > 23 || m > 59) return null;
  return `${hh}:${mm}`;
}
