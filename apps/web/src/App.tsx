import { useState } from "react";
import { useMe } from "./api/hooks";
import AuthScreen from "./components/AuthScreen.tsx";
import CategoriesPage from "./components/CategoriesPage.tsx";
import Dashboard from "./components/Dashboard.tsx";
import HistoryPage from "./components/HistoryPage.tsx";
import ImportsPage from "./components/ImportsPage.tsx";
import NewTransactionPage from "./components/NewTransactionPage.tsx";
import ProfilePage from "./components/ProfilePage.tsx";
import ReceiptsPage from "./components/ReceiptsPage.tsx";
import { MobileBar, Sidebar } from "./components/Sidebar.tsx";

export default function App() {
  const me = useMe();
  const [active, setActive] = useState("dashboard");

  if (me.isPending) {
    return (
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <p className="text-sm text-subtle">Loading…</p>
      </main>
    );
  }

  if (me.isError || !me.data) return <AuthScreen />;

  return (
    <div className="min-h-screen bg-canvas text-ink lg:flex">
      <Sidebar user={me.data} active={active} onNav={setActive} />
      <div className="min-w-0 flex-1">
        <MobileBar user={me.data} active={active} onNav={setActive} />
        <main className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
          {active === "categories" ? (
            <CategoriesPage />
          ) : active === "new-transaction" ? (
            <NewTransactionPage />
          ) : active === "history" ? (
            <HistoryPage />
          ) : active === "receipts" ? (
            <ReceiptsPage />
          ) : active === "imports" ? (
            <ImportsPage />
          ) : active === "profile" ? (
            <ProfilePage />
          ) : (
            <Dashboard onNavigate={setActive} />
          )}
        </main>
      </div>
    </div>
  );
}
