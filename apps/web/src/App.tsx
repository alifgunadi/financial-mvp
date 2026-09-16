import { useLogout, useMe } from "./api/hooks";
import AuthScreen from "./components/AuthScreen.tsx";
import CategoryManager from "./components/CategoryManager.tsx";
import Dashboard from "./components/Dashboard.tsx";
import ReceiptUpload from "./components/ReceiptUpload.tsx";
import TransactionForm from "./components/TransactionForm.tsx";
import TransactionList from "./components/TransactionList.tsx";

export default function App() {
  const me = useMe();
  const logout = useLogout();

  if (me.isPending) {
    return (
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <p className="text-sm text-gray-500">Loading…</p>
      </main>
    );
  }

  if (me.isError || !me.data) return <AuthScreen />;

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Financial MVP</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600">{me.data.email}</span>
          <button
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Logout
          </button>
        </div>
      </div>
      <Dashboard />
      <div className="grid gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-4">
          <TransactionForm />
          <CategoryManager />
          <ReceiptUpload />
        </div>
        <TransactionList />
      </div>
    </main>
  );
}
