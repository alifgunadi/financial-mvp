import { useState } from "react";
import {
  useDashboardSummary,
  type SummaryPeriod,
} from "../api/hooks";
import CategoryDonut from "./CategoryDonut.tsx";
import CategoryManager from "./CategoryManager.tsx";
import DashboardCard from "./DashboardCard.tsx";
import ReceiptUpload from "./ReceiptUpload.tsx";
import SpendingPaceCard from "./SpendingPaceCard.tsx";
import StatementImport from "./StatementImport.tsx";
import TransactionForm from "./TransactionForm.tsx";
import TransactionList from "./TransactionList.tsx";
import TransactionRow, { fmtIDR } from "./TransactionRow.tsx";

function currentMonth(): SummaryPeriod {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${lastDay}` };
}

const dateInputCls =
  "rounded-xl border border-line bg-surface px-2.5 py-2 text-[13px] text-ink focus:border-ink focus:outline-none";

function SummaryCard({
  label,
  caption,
  value,
  tone = "text-ink",
}: {
  label: string;
  caption: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="h-full min-w-0 rounded-2xl border border-line bg-surface p-6 shadow-sm">
      <p className="text-sm font-semibold tracking-tight">{label}</p>
      <p
        className={`mt-1.5 truncate text-[26px] font-bold tracking-tight tabular-nums ${tone}`}
      >
        Rp{fmtIDR.format(value)}
      </p>
      <p className="mt-1 text-xs text-subtle">{caption}</p>
    </div>
  );
}

function FlowBar({
  label,
  value,
  max,
  bar,
}: {
  label: string;
  value: number;
  max: number;
  bar: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="font-bold tabular-nums">Rp{fmtIDR.format(value)}</span>
      </div>
      <div
        role="img"
        aria-label={`${label} Rp${fmtIDR.format(value)}`}
        className="mt-2 h-2.5 overflow-hidden rounded-full bg-canvas"
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

type RecentTab = "" | "income" | "expense";

export default function Dashboard() {
  const [period, setPeriod] = useState<SummaryPeriod>(currentMonth);
  const [tab, setTab] = useState<RecentTab>("");
  const { data, isPending, isError, error, refetch } =
    useDashboardSummary(period);
  const flowMax = Math.max(data?.totalIncome ?? 0, data?.totalExpense ?? 0, 0);
  const recent = (data?.recent ?? []).filter((t) => !tab || t.type === tab);

  return (
    <section id="dashboard" aria-label="Dashboard" className="scroll-mt-6">
      {/* Row 1: control header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="mt-1 text-[13px] text-subtle">
            {period.from && period.to
              ? `Period ${period.from} → ${period.to}`
              : "Select a period to summarize."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            aria-label="From"
            className={dateInputCls}
            value={period.from}
            onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))}
          />
          <input
            type="date"
            aria-label="To"
            className={dateInputCls}
            value={period.to}
            onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))}
          />
          <button
            type="button"
            onClick={() => setPeriod(currentMonth())}
            className="rounded-xl border border-line bg-surface px-3 py-2 text-[13px] font-medium text-subtle transition-colors hover:text-ink"
          >
            This month
          </button>
          <a
            href="#new-transaction"
            className="rounded-xl bg-ink px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            + New transaction
          </a>
        </div>
      </div>

      {isPending && (
        <DashboardCard title="Dashboard" subtitle="Loading summary">
          <p className="text-sm text-subtle">Loading…</p>
        </DashboardCard>
      )}
      {isError && (
        <DashboardCard title="Dashboard" subtitle="Summary unavailable">
          <p className="text-sm text-clay-ink">
            {(error as Error).message}{" "}
            <button className="underline" onClick={() => refetch()}>
              Retry
            </button>
          </p>
        </DashboardCard>
      )}

      {data && (
        <div className="space-y-6">
          {/* Row 2: KPI summary */}
          <div className="grid grid-cols-12 items-stretch gap-6 [&>*]:min-w-0">
            <div className="col-span-12 md:col-span-4">
              <SummaryCard
                label="Net cashflow"
                caption="Income minus expenses, selected period"
                value={data.balance}
                tone={data.balance < 0 ? "text-clay-ink" : "text-ink"}
              />
            </div>
            <div className="col-span-12 md:col-span-4">
              <SummaryCard
                label="Income"
                caption="Selected period total"
                value={data.totalIncome}
                tone="text-leaf-ink"
              />
            </div>
            <div className="col-span-12 md:col-span-4">
              <SummaryCard
                label="Expenses"
                caption="Selected period total"
                value={data.totalExpense}
                tone="text-clay-ink"
              />
            </div>
          </div>

          {/* Row 3: hero analytics + recent activity */}
          <div className="grid grid-cols-12 items-stretch gap-6 [&>*]:min-w-0">
            <div className="col-span-12 lg:col-span-7">
              {data.spendingPace ? (
                <SpendingPaceCard pace={data.spendingPace} />
              ) : (
                <DashboardCard
                  title="Daily spending pace"
                  subtitle="Daily guide unavailable"
                >
                  <p className="text-sm text-subtle">
                    {data.to === null
                      ? "Select a period end date to see the daily spending guide."
                      : "This period has ended, so no daily guide is shown."}
                  </p>
                </DashboardCard>
              )}
            </div>
            <div className="col-span-12 lg:col-span-5">
              <DashboardCard
                title="Recent transactions"
                subtitle="Latest in this period"
              >
                <div
                  role="tablist"
                  aria-label="Filter recent transactions"
                  className="flex gap-1 rounded-xl bg-canvas p-1"
                >
                  {(
                    [
                      ["", "All"],
                      ["income", "Income"],
                      ["expense", "Expense"],
                    ] as [RecentTab, string][]
                  ).map(([value, label]) => (
                    <button
                      key={label}
                      role="tab"
                      aria-selected={tab === value}
                      onClick={() => setTab(value)}
                      className={`flex-1 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
                        tab === value
                          ? "bg-surface text-ink shadow-sm"
                          : "text-subtle hover:text-ink"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {recent.length === 0 ? (
                  <p className="mt-4 text-sm text-subtle">
                    {data.recent.length === 0
                      ? "No transactions in this period."
                      : `No ${tab} transactions among the recent ones.`}
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-line">
                    {recent.map((t) => (
                      <TransactionRow key={t.id} t={t} />
                    ))}
                  </ul>
                )}
              </DashboardCard>
            </div>
          </div>

          {/* Row 4: secondary analytics */}
          <div className="grid grid-cols-12 items-stretch gap-6 [&>*]:min-w-0">
            <div className="col-span-12 md:col-span-6">
              <DashboardCard
                title="Income vs expenses"
                subtitle="Totals for the selected period"
              >
                <div className="space-y-4">
                  <FlowBar
                    label="Income"
                    value={data.totalIncome}
                    max={flowMax}
                    bar="bg-leaf"
                  />
                  <FlowBar
                    label="Expenses"
                    value={data.totalExpense}
                    max={flowMax}
                    bar="bg-clay"
                  />
                </div>
              </DashboardCard>
            </div>
            <div className="col-span-12 md:col-span-6">
              <DashboardCard
                title="Expense by category"
                subtitle="Spending overview"
              >
                <CategoryDonut
                  items={data.expenseByCategory}
                  totalExpense={data.totalExpense}
                />
              </DashboardCard>
            </div>
          </div>
        </div>
      )}

      {/* Statement import — full width so candidate review stays readable */}
      <div id="imports" className="mt-6 scroll-mt-24">
        <StatementImport />
      </div>

      {/* Row 5: operations — history log + action sidebar */}
      <div className="mt-6 grid grid-cols-12 items-start gap-6 [&>*]:min-w-0">
        <div id="history" className="col-span-12 scroll-mt-24 lg:col-span-8">
          <TransactionList />
        </div>
        <div className="col-span-12 space-y-6 lg:col-span-4">
          <div id="new-transaction" className="scroll-mt-24">
            <TransactionForm />
          </div>
          <div id="categories" className="scroll-mt-24">
            <CategoryManager />
          </div>
          <div id="receipts" className="scroll-mt-24">
            <ReceiptUpload />
          </div>
        </div>
      </div>
    </section>
  );
}
