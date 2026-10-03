import type { SpendingPace } from "../api/hooks";
import DashboardCard from "../shared/ui/DashboardCard.tsx";
import { fmtIDR } from "../shared/format";

const STATUS_META: Record<SpendingPace["status"], { label: string; dot: string }> = {
  on_track: { label: "On track", dot: "bg-leaf" },
  over_budget: { label: "Over budget", dot: "bg-clay" },
  no_data: { label: "No data", dot: "bg-faint" },
  period_ended: { label: "Period ended", dot: "bg-faint" },
  unbounded: { label: "Unbounded", dot: "bg-faint" },
};

export default function SpendingPaceCard({
  pace,
}: {
  pace: SpendingPace;
}) {
  const meta = STATUS_META[pace.status];
  const pct =
    pace.recommendedMaxPerDay > 0
      ? Math.min(100, (pace.spentToday / pace.recommendedMaxPerDay) * 100)
      : pace.spentToday > 0
        ? 100
        : 0;
  return (
    <DashboardCard
      tone="dark"
      title="Daily spending pace"
      subtitle={`${pace.remainingDays} day${pace.remainingDays === 1 ? "" : "s"} left · as of ${pace.asOf}`}
      actionHeader={
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold ${pace.status === "over_budget" ? "text-red-300" : pace.status === "on_track" ? "text-green-300" : "text-white/70"}`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${meta.dot}`}
          />
          {meta.label}
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="min-w-0">
          <p className="text-xs text-white/60">Recommended today</p>
          <p className="mt-1 truncate text-[22px] font-bold tracking-tight">
            Rp{fmtIDR.format(pace.recommendedMaxPerDay)}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-white/60">Spent today</p>
          <p className="mt-1 truncate text-[22px] font-bold tracking-tight">
            Rp{fmtIDR.format(pace.spentToday)}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-white/60">Remaining today</p>
          <p
            className={`mt-1 truncate text-[22px] font-bold tracking-tight ${pace.remainingToday < 0 ? "text-red-300" : ""}`}
          >
            Rp{fmtIDR.format(pace.remainingToday)}
          </p>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Spent today versus recommended maximum"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="mt-5 h-2 overflow-hidden rounded-full bg-white/15"
      >
        <div
          className={`h-full rounded-full transition-[width] ${pace.status === "over_budget" || pace.remainingToday < 0 ? "bg-red-400" : "bg-green-400"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-white/60">
        {pace.status === "over_budget"
          ? "Over budget for this period."
          : pace.status === "no_data"
            ? "No transactions in this period yet."
            : "Status reflects the whole period balance, not just today."}
      </p>
    </DashboardCard>
  );
}
