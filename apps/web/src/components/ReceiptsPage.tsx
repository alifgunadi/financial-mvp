import ReceiptUpload from "./ReceiptUpload.tsx";

export default function ReceiptsPage() {
  return (
    <section id="receipts" aria-label="Receipts" className="scroll-mt-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">Receipts</h2>
        <p className="mt-1 text-[13px] text-subtle">
          Scan a receipt with AI, review, then confirm
        </p>
      </div>
      <div className="max-w-2xl">
        <ReceiptUpload />
      </div>
    </section>
  );
}
