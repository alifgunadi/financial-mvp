import { useState } from "react";
import { useLogin } from "../api/hooks";
import { authInputCls } from "./RegisterScreen.tsx";

export default function LoginScreen({ onRegister }: { onRegister: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useLogin();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    login.mutate({ email: email.trim(), password });
  };

  const switchMode = () => {
    login.reset();
    onRegister();
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4">
      <h2 className="text-base font-semibold">Login</h2>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <input
          className={authInputCls}
          type="email"
          aria-label="Email"
          placeholder="Email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className={authInputCls}
          type="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {login.isPending ? "Please wait…" : "Login"}
        </button>
        {login.isError && (
          <p className="text-sm text-red-600">
            {(login.error as Error).message}
          </p>
        )}
      </form>
      <p className="mt-3 text-center text-sm text-gray-600">
        No account yet?{" "}
        <button className="underline" onClick={switchMode}>
          Register
        </button>
      </p>
    </section>
  );
}
