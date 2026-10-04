import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { useMe } from "../api/hooks";
import LoginScreen from "./LoginScreen.tsx";
import RegisterScreen from "./RegisterScreen.tsx";

export default function AuthScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");
  // Set only right after a successful registration; carries the new
  // username to the login form exactly once (manual mode switches clear it).
  const [successIdentifier, setSuccessIdentifier] = useState<string | null>(null);
  const me = useMe();
  const qc = useQueryClient();
  const meError = me.isError ? me.error : null;
  // /me failed after login/register (token already dropped): explain it
  // with the existing error style. A 401 is just an ended session, silent.
  const notice =
    meError && !(meError instanceof ApiError && meError.status === 401)
      ? meError.message
      : null;
  // A new attempt starts clean: drop stale failures and the one-shot
  // registration notice while typing or on resubmit.
  const clearNotices = () => {
    if (me.isError) qc.setQueryData(["me"], null);
    setSuccessIdentifier(null);
  };
  const toRegister = () => {
    setSuccessIdentifier(null);
    setMode("register");
  };
  const toLogin = () => {
    setSuccessIdentifier(null);
    setMode("login");
  };
  const handleRegistered = (identifier: string) => {
    setSuccessIdentifier(identifier);
    setMode("login");
  };

  return (
    <main className="mx-auto max-w-sm p-4 sm:p-6">
      <h1 className="text-xl font-semibold">Financial MVP</h1>
      {notice && <p className="mt-3 text-sm text-clay-ink">{notice}</p>}
      {mode === "login" && successIdentifier !== null && (
        <p className="mt-3 text-sm text-green-700">
          Account created. Please login.
        </p>
      )}
      <div className="mt-4" onChange={clearNotices} onSubmit={clearNotices}>
        {mode === "login" ? (
          <LoginScreen
            initialIdentifier={successIdentifier ?? ""}
            onRegister={toRegister}
          />
        ) : (
          <RegisterScreen onRegistered={handleRegistered} onLogin={toLogin} />
        )}
      </div>
    </main>
  );
}
