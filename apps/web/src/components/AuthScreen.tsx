import { useState } from "react";
import LoginScreen from "./LoginScreen.tsx";
import RegisterScreen from "./RegisterScreen.tsx";

export default function AuthScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");

  return (
    <main className="mx-auto max-w-sm p-4 sm:p-6">
      <h1 className="text-xl font-semibold">Financial MVP</h1>
      <div className="mt-4">
        {mode === "login" ? (
          <LoginScreen onRegister={() => setMode("register")} />
        ) : (
          <RegisterScreen onLogin={() => setMode("login")} />
        )}
      </div>
    </main>
  );
}
