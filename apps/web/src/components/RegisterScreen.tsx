import { useState } from "react";
import { useRegister } from "../api/hooks";
import { authInputCls } from "../shared/authStyles";

export default function RegisterScreen({
  onRegistered,
  onLogin,
}: {
  onRegistered: (identifier: string) => void;
  onLogin: () => void;
}) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const register = useRegister();

  const mismatch =
    confirm.length > 0 && password !== confirm
      ? "Passwords do not match."
      : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !username.trim() || !name.trim() || !password || mismatch)
      return;
    // Success hands the (server-normalized) username up as the login
    // identifier; AuthScreen switches to login. Only the identifier
    // crosses over, never the password.
    register.mutate(
      {
        email: email.trim(),
        username: username.trim(),
        name: name.trim(),
        password,
      },
      { onSuccess: (user) => onRegistered(user.username) },
    );
  };

  const switchMode = () => {
    register.reset();
    onLogin();
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4">
      <h2 className="text-base font-semibold">Create account</h2>
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
          type="text"
          aria-label="Username"
          placeholder="Username (a-z, 0-9, _, 3-20)"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className={authInputCls}
          type="text"
          aria-label="Name"
          placeholder="Name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={authInputCls}
          type="password"
          aria-label="Password"
          placeholder="Password (min 8 characters)"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          className={authInputCls}
          type="password"
          aria-label="Confirm password"
          placeholder="Confirm password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {mismatch && <p className="text-sm text-clay-ink">{mismatch}</p>}
        <button
          type="submit"
          disabled={register.isPending || !!mismatch}
          className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {register.isPending ? "Creating account…" : "Register"}
        </button>
        {register.isError && (
          <p className="text-sm text-clay-ink">
            {(register.error as Error).message}
          </p>
        )}
      </form>
      <p className="mt-3 text-center text-sm text-gray-600">
        Already have an account?{" "}
        <button className="underline" onClick={switchMode}>
          Login
        </button>
      </p>
    </section>
  );
}
