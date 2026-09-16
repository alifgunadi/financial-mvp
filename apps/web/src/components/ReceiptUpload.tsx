import { useRef, useState } from "react";
import { useExtractReceipt, useUploadReceipt } from "../api/hooks";
import ReceiptReview from "./ReceiptReview.tsx";
import { fmtIDR } from "./TransactionRow.tsx";

export default function ReceiptUpload() {
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadReceipt();
  const extract = useExtractReceipt();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    extract.reset();
    upload.mutate(file);
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4">
      <h2 className="text-base font-semibold">Upload Receipt</h2>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="block w-full text-sm text-gray-600"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            upload.reset();
            extract.reset();
          }}
        />
        {file && (
          <p className="text-sm text-gray-600">
            Selected: <span className="font-medium">{file.name}</span>
          </p>
        )}
        <button
          type="submit"
          disabled={!file || upload.isPending}
          className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {upload.isPending ? "Uploading…" : "Upload"}
        </button>
        {upload.isError && (
          <p className="text-sm text-red-600">
            {(upload.error as Error).message}
          </p>
        )}
        {upload.isSuccess && (
          <p className="text-sm text-green-700">
            Receipt uploaded successfully.
          </p>
        )}
        {upload.isSuccess && (
          <button
            type="button"
            disabled={extract.isPending}
            onClick={() => extract.mutate(upload.data.id)}
            className="w-full rounded border border-gray-900 px-3 py-2 text-sm disabled:opacity-50"
          >
            {extract.isPending ? "Extracting…" : "Extract with AI"}
          </button>
        )}
        {extract.isError && (
          <p className="text-sm text-red-600">
            {(extract.error as Error).message}
          </p>
        )}
        {extract.isSuccess && (
          <dl className="space-y-1 rounded bg-gray-50 p-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Merchant</dt>
              <dd>{extract.data.extraction.merchant ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Amount</dt>
              <dd>
                {extract.data.extraction.amount === null
                  ? "—"
                  : `Rp${fmtIDR.format(extract.data.extraction.amount)}`}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Date</dt>
              <dd>{extract.data.extraction.date ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Type</dt>
              <dd>{extract.data.extraction.type ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Category</dt>
              <dd>{extract.data.extraction.category ?? "—"}</dd>
            </div>
          </dl>
        )}
        {extract.isSuccess && <ReceiptReview receiptId={extract.data.id} />}
      </form>
    </section>
  );
}
