import type { CategoryTotal } from "../api/hooks";
import { fmtIDR } from "./TransactionRow.tsx";

// Restrained categorical set drawn from the product tokens only.
const PALETTE = [
  "#539616",
  "#c6a339",
  "#565845",
  "#dc2626",
  "#d8d1af",
  "#a6a6a6",
];

const R = 54;
const CIRC = 2 * Math.PI * R;

export default function CategoryDonut({
  items,
  totalExpense,
}: {
  items: CategoryTotal[];
  totalExpense: number;
}) {
  if (items.length === 0 || totalExpense <= 0) {
    return (
      <p className="text-sm text-subtle">No expenses in this period.</p>
    );
  }
  let acc = 0;
  const segments = items.map((c, i) => {
    const frac = c.total / totalExpense;
    const seg = { ...c, frac, offset: acc, color: PALETTE[i % PALETTE.length] };
    acc += frac;
    return seg;
  });
  return (
    <>
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:gap-6">
        <svg
          viewBox="0 0 140 140"
          className="h-36 w-36 shrink-0"
          role="img"
          aria-label={`Expenses total Rp${fmtIDR.format(totalExpense)} across ${items.length} categories`}
        >
          <circle
            cx="70"
            cy="70"
            r={R}
            fill="none"
            stroke="#e5e7eb"
            strokeWidth="18"
          />
          {segments.map((s) => (
            <circle
              key={s.categoryId ?? "uncategorized"}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={s.color}
              strokeWidth="18"
              strokeDasharray={`${Math.max(0, s.frac * CIRC - 2)} ${CIRC}`}
              strokeDashoffset={-s.offset * CIRC}
              strokeLinecap="butt"
              transform="rotate(-90 70 70)"
            />
          ))}
          <text
            x="70"
            y="66"
            textAnchor="middle"
            className="fill-ink text-[15px] font-bold"
          >
            Rp{fmtIDR.format(totalExpense)}
          </text>
          <text
            x="70"
            y="82"
            textAnchor="middle"
            className="fill-subtle text-[9px]"
          >
            total spent
          </text>
        </svg>
        <ul className="min-w-0 flex-1 space-y-2.5 self-stretch">
          {segments.map((s) => (
            <li
              key={s.categoryId ?? "uncategorized"}
              className="flex items-center gap-2.5 text-sm"
            >
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-[4px]"
                style={{ backgroundColor: s.color }}
              />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 text-xs text-subtle">
                {Math.round(s.frac * 100)}%
              </span>
              <span className="w-24 shrink-0 text-right font-semibold tabular-nums">
                Rp{fmtIDR.format(s.total)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
