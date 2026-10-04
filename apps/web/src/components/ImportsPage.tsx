import StatementImport from "./StatementImport.tsx";

export default function ImportsPage() {
  return (
    <section id="imports" aria-label="Statement Import" className="scroll-mt-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">Statement Import</h2>
        <p className="mt-1 text-[13px] text-subtle">
          Upload a bank statement PDF, review, then confirm
        </p>
      </div>
      <StatementImport />
    </section>
  );
}
