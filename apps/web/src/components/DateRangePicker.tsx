import { useEffect, useRef, useState } from "react";

// Custom date-range picker (no new dependencies). Emits the exact same
// YYYY-MM-DD strings the native inputs produced, into the same
// { from, to } source of truth owned by the parent, so the dashboard
// query, API contract, and empty-means-unbounded behavior are unchanged.

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// month is 0-based, mirroring the Date constructor.
function toISO(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function parseISO(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m: m - 1, d };
}

function isValidISO(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parseISO(s);
  const t = new Date(y, m, d);
  return (
    t.getFullYear() === y && t.getMonth() === m && t.getDate() === d
  );
}

function todayISO(): string {
  const n = new Date();
  return toISO(n.getFullYear(), n.getMonth(), n.getDate());
}

function addDaysISO(s: string, n: number): string {
  const { y, m, d } = parseISO(s);
  const t = new Date(y, m, d + n);
  return toISO(t.getFullYear(), t.getMonth(), t.getDate());
}

// Cells for a month grid starting Sunday; null = leading blank spacer.
function monthCells(y: number, m: number): (number | null)[] {
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  return [
    ...Array<null>(first).fill(null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
}

function formatShort(s: string): string {
  if (!isValidISO(s)) return s;
  const { y, m, d } = parseISO(s);
  return `${d} ${MONTHS[m].slice(0, 3)} ${y}`;
}

function thisMonth(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  return { from: toISO(y, now.getMonth(), 1), to: toISO(y, now.getMonth(), lastDay) };
}

function triggerLabel(from: string, to: string): string {
  if (from && to)
    return from === to
      ? formatShort(from)
      : `${formatShort(from)} – ${formatShort(to)}`;
  if (from) return `From ${formatShort(from)}`;
  if (to) return `To ${formatShort(to)}`;
  return "Select period";
}

function MonthView({
  year,
  month,
  from,
  to,
  pendingStart,
  hovered,
  onPick,
  onHover,
}: {
  year: number;
  month: number;
  from: string;
  to: string;
  pendingStart: string | null;
  hovered: string | null;
  onPick: (day: string) => void;
  onHover: (day: string | null) => void;
}) {
  const today = todayISO();
  const hasRange = isValidISO(from) && isValidISO(to);
  return (
    // w-full (capped) instead of fixed w-64: grid tracks share the box so
    // the 7 fixed cells can never force the month wider than its parent.
    <div className="mx-auto w-full min-w-0 max-w-64 sm:w-64 sm:shrink-0">
      <p className="mb-2 text-center text-[13px] font-semibold tracking-tight">
        {MONTHS[month]} {year}
      </p>
      <div className="grid grid-cols-7 gap-0.5" role="rowgroup">
        {WEEKDAYS.map((d) => (
          <span
            key={d}
            className="flex h-8 items-center justify-center text-[11px] font-medium text-subtle"
          >
            {d}
          </span>
        ))}
        {monthCells(year, month).map((day, i) => {
          if (day === null) return <span key={`blank-${i}`} />;
          const iso = toISO(year, month, day);
          const isEndpoint = hasRange && (iso === from || iso === to);
          const inRange =
            hasRange && !isEndpoint && iso > from && iso < to;
          const inPreview =
            pendingStart !== null &&
            hovered !== null &&
            ((iso > pendingStart && iso <= hovered) ||
              (iso < pendingStart && iso >= hovered));
          const isToday = iso === today;
          return (
            <button
              key={iso}
              type="button"
              aria-label={formatShort(iso)}
              aria-pressed={isEndpoint}
              onClick={() => onPick(iso)}
              onMouseEnter={() => onHover(iso)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(iso)}
              className={`flex h-9 w-full min-w-0 items-center justify-center rounded-full text-[13px] tabular-nums transition-colors ${
                isEndpoint
                  ? "bg-ink font-semibold text-white"
                  : inRange
                    ? "bg-canvas font-medium text-ink"
                    : inPreview
                      ? "bg-line text-ink"
                      : "text-ink hover:bg-canvas"
              } ${isToday && !isEndpoint ? "ring-1 ring-inset ring-ink" : ""}`}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const openPanel = () => {
    // Anchor the view on the active start (or today when empty).
    if (isValidISO(from)) {
      const { y, m } = parseISO(from);
      setBase({ y, m });
    } else {
      const n = new Date();
      setBase({ y: n.getFullYear(), m: n.getMonth() });
    }
    setPendingStart(null);
    setHovered(null);
    setOpen(true);
  };

  const closePanel = (refocus = true) => {
    setOpen(false);
    setPendingStart(null);
    if (refocus) triggerRef.current?.focus();
  };

  // Dismiss on outside pointer or Escape; focus the panel on open.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        closePanel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  // Range flow: first click starts (commits a single-day range immediately,
  // exactly like the old inputs committed on every change); second click
  // completes the ordered range and closes.
  const pick = (day: string) => {
    if (pendingStart === null) {
      setPendingStart(day);
      onChange(day, day);
    } else if (day === pendingStart) {
      onChange(day, day);
      closePanel();
    } else {
      const [a, b] = day < pendingStart ? [day, pendingStart] : [pendingStart, day];
      onChange(a, b);
      closePanel();
    }
  };

  const applyPreset = (range: { from: string; to: string }) => {
    onChange(range.from, range.to);
    setPendingStart(null);
    setHovered(null);
  };

  const shiftBase = (delta: number) => {
    const t = new Date(base.y, base.m + delta, 1);
    setBase({ y: t.getFullYear(), m: t.getMonth() });
  };

  const second =
    base.m === 11
      ? { y: base.y + 1, m: 0 }
      : { y: base.y, m: base.m + 1 };

  const presetBtnCls =
    "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-subtle transition-colors hover:bg-canvas hover:text-ink";

  return (
    // Full-width row on mobile: the panel anchors to stable content edges
    // instead of the trigger button, whose width changes as the label
    // changes mid-selection (long range -> short single date).
    <div ref={rootRef} className="relative w-full sm:w-auto">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Choose date range"
        onClick={() => (open ? closePanel(false) : openPanel())}
        className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-ink transition-colors hover:border-ink focus:border-ink focus:outline-none"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 shrink-0"
          aria-hidden="true"
        >
          <path d="M8 3v4M16 3v4M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
        </svg>
        <span className="font-medium tabular-nums">{triggerLabel(from, to)}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Choose date range"
          tabIndex={-1}
          className="picker-pop absolute left-0 right-0 top-full z-20 mt-2 max-h-[70vh] overflow-auto rounded-2xl border border-line bg-surface p-4 shadow-lg focus:outline-none sm:left-auto sm:w-max sm:max-w-[calc(100vw-2rem)]"
        >
          <div className="mb-3 flex flex-wrap gap-1">
            <button type="button" onClick={() => applyPreset(thisMonth())} className={presetBtnCls}>
              This month
            </button>
            <button
              type="button"
              onClick={() => {
                const t = todayISO();
                applyPreset({ from: addDaysISO(t, -29), to: t });
              }}
              className={presetBtnCls}
            >
              Last 30 days
            </button>
            <button
              type="button"
              onClick={() => {
                const y = new Date().getFullYear();
                applyPreset({ from: toISO(y, 0, 1), to: toISO(y, 11, 31) });
              }}
              className={presetBtnCls}
            >
              This year
            </button>
            <button type="button" onClick={() => applyPreset({ from: "", to: "" })} className={presetBtnCls}>
              Clear
            </button>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row">
            <MonthView
              year={base.y}
              month={base.m}
              from={from}
              to={to}
              pendingStart={pendingStart}
              hovered={hovered}
              onPick={pick}
              onHover={setHovered}
            />
            <MonthView
              year={second.y}
              month={second.m}
              from={from}
              to={to}
              pendingStart={pendingStart}
              hovered={hovered}
              onPick={pick}
              onHover={setHovered}
            />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-subtle">
              {pendingStart !== null
                ? `Start ${formatShort(pendingStart)} — pick an end date`
                : "Pick a start date, then an end date"}
            </p>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => shiftBase(-1)}
                className="rounded-lg px-2 py-1 text-subtle transition-colors hover:bg-canvas hover:text-ink"
              >
                ←
              </button>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => shiftBase(1)}
                className="rounded-lg px-2 py-1 text-subtle transition-colors hover:bg-canvas hover:text-ink"
              >
                →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
