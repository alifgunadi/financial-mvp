import TransactionForm from "./TransactionForm.tsx";

export default function NewTransactionPage() {
  return (
    <section id="new-transaction" aria-label="New transaction" className="scroll-mt-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">New transaction</h2>
        <p className="mt-1 text-[13px] text-subtle">
          Record income or expense
        </p>
      </div>
      <div className="max-w-2xl">
        <TransactionForm />
      </div>
    </section>
  );
}
