import { useState } from "react";
import {
  useDashboardSummary,
  type SummaryPeriod,
} from "../api/hooks";
import TransactionRow, { fmtIDR } from "./TransactionRow.tsx";

function currentMonth(): SummaryPeriod {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${lastDay}` };
}

function Card({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${accent}`}>
        Rp{fmtIDR.format(value)}
      </p>
    </div>
  );
}

export default function Dashboard() {
  const [period, setPeriod] = useState<SummaryPeriod>(currentMonth);
  const { data, isPending, isError, error, refetch } =
    useDashboardSummary(period);
  const maxTotal = Math.max(0, ...(data?.expenseByCategory.map((c) => c.total) ?? []));

  return (
    <section className="rounded border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Dashboard</h2>
        <div className="flex gap-2 text-sm">
          <input
            type="date"
            aria-label="From"
            className="rounded border border-gray-300 px-2 py-1.5"
            value={period.from}
            onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))}
          />
          <input
            type="date"
            aria-label="To"
            className="rounded border border-gray-300 px-2 py-1.5"
            value={period.to}
            onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))}
          />
        </div>
      </div>

      {isPending && <p className="mt-3 text-sm text-gray-500">Loading…</p>}
      {isError && (
        <p className="mt-3 text-sm text-red-600">
          {(error as Error).message}{" "}
          <button className="underline" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      )}

      {data && (
        <>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card label="Income" value={data.totalIncome} accent="text-green-700" />
            <Card label="Expense" value={data.totalExpense} accent="text-red-700" />
            <Card
              label="Net (income − expense)"
              value={data.balance}
              accent={data.balance < 0 ? "text-red-700" : "text-gray-900"}
            />
          </div>

          {data.spendingPace ? (
            <div className="mt-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Card
                  label="Max / day"
                  value={data.spendingPace.recommendedMaxPerDay}
                  accent={
                    data.spendingPace.status === "over_budget"
                      ? "text-red-700"
                      : "text-gray-900"
                  }
                />
                <Card
                  label="Spent today"
                  value={data.spendingPace.spentToday}
                  accent="text-gray-900"
                />
                <Card
                  label="Left today"
                  value={data.spendingPace.remainingToday}
                  accent={
                    data.spendingPace.remainingToday < 0
                      ? "text-red-700"
                      : "text-gray-900"
                  }
                />
              </div>
              <p className="mt-2 text-xs text-gray-500">
                {data.spendingPace.status === "over_budget"
                  ? "Over budget for this period."
                  : data.spendingPace.status === "no_data"
                    ? "No transactions in this period yet."
                    : `On track · ${data.spendingPace.remainingDays} day(s) left · as of ${data.spendingPace.asOf}.`}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-gray-500">
              {data.to === null
                ? "Select a period end date to see the daily spending guide."
                : "This period has ended, so no daily guide is shown."}
            </p>
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold">Expense by category</h3>
              {data.expenseByCategory.length === 0 ? (
                <p className="mt-2 text-sm text-gray-500">
                  No expenses in this period.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {data.expenseByCategory.map((c) => (
                    <li key={c.categoryId}>
                      <div className="flex justify-between text-sm">
                        <span>{c.name}</span>
                        <span className="font-medium">
                          Rp{fmtIDR.format(c.total)}
                        </span>
                      </div>
                      <div className="mt-1 h-2 rounded bg-gray-100">
                        <div
                          className="h-2 rounded bg-red-500"
                          style={{
                            width: `${maxTotal ? (c.total / maxTotal) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold">Recent transactions</h3>
              {data.recent.length === 0 ? (
                <p className="mt-2 text-sm text-gray-500">
                  No transactions in this period.
                </p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {data.recent.map((t) => (
                    <TransactionRow key={t.id} t={t} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
