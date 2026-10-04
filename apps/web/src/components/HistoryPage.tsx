import TransactionList from "./TransactionList.tsx";

export default function HistoryPage() {
  return (
    <section id="history" aria-label="History" className="scroll-mt-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">History</h2>
        <p className="mt-1 text-[13px] text-subtle">
          All recorded transactions
        </p>
      </div>
      <TransactionList />
    </section>
  );
}
