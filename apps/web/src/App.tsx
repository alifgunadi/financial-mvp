import { useState } from "react";
import { useMe } from "./api/hooks";
import AuthScreen from "./components/AuthScreen.tsx";
import Dashboard from "./components/Dashboard.tsx";
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
          <Dashboard />
        </main>
      </div>
    </div>
  );
}
