import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import {
  useChangePassword,
  useDeleteAvatar,
  useProfile,
  useUpdateProfile,
  useUploadAvatar,
} from "../api/hooks";
import AvatarCropper from "./AvatarCropper.tsx";
import DashboardCard from "../shared/ui/DashboardCard.tsx";
import UserAvatar from "./UserAvatar.tsx";

// Client-side pre-check only (fast UX). The server re-validates everything:
// 512KB limit, jpeg/png/webp mimetype + extension + magic bytes.
const MAX_AVATAR_BYTES = 512 * 1024;
const ACCEPTED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];

function avatarClientError(file: File): string | null {
  if (!ACCEPTED_AVATAR_TYPES.includes(file.type))
    return "Unsupported file type (jpeg, png, or webp only).";
  if (file.size === 0) return "File is empty.";
  if (file.size > MAX_AVATAR_BYTES) return "File too large (max 512KB).";
  return null;
}

const inputCls =
  "w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none disabled:opacity-50";
const primaryBtnCls =
  "rounded-xl bg-ink px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50";
const secondaryBtnCls =
  "rounded-xl border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-subtle transition-colors hover:text-ink disabled:opacity-50";

export default function ProfilePage() {
  const profile = useProfile();
  const updateProfile = useUpdateProfile();
  const changePassword = useChangePassword();
  const uploadAvatar = useUploadAvatar();
  const deleteAvatar = useDeleteAvatar();

  // ---- info section state (synced from the server profile) ----
  const [name, setName] = useState("");
  useEffect(() => {
    if (profile.data) setName(profile.data.name ?? "");
  }, [profile.data]);

  // ---- password section state ----
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);

  // ---- avatar section state ----
  // Crop-then-upload: picking a file opens the cropper with a LOCAL object
  // URL (preview of the not-yet-uploaded file). The stored avatar keeps
  // rendering through UserAvatar (server data via useProfile) until the
  // cropped result is uploaded. The two never share state.
  const [fileError, setFileError] = useState<string | null>(null);
  const [pendingAvatarUrl, setPendingAvatarUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingUrlRef = useRef<string | null>(null);
  // Safety net: the local crop preview URL is revoked eagerly on
  // cancel/confirm below; this only covers unmount while open.
  useEffect(
    () => () => {
      if (pendingUrlRef.current) URL.revokeObjectURL(pendingUrlRef.current);
    },
    [],
  );

  if (profile.isPending) {
    return (
      <section id="profile" aria-label="My Profile" className="scroll-mt-6">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight">My Profile</h2>
          <p className="mt-1 text-[13px] text-subtle">Loading…</p>
        </div>
      </section>
    );
  }

  if (profile.isError || !profile.data) {
    return (
      <section id="profile" aria-label="My Profile" className="scroll-mt-6">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight">My Profile</h2>
          <p className="mt-1 text-[13px] text-subtle">Manage your account</p>
        </div>
        <DashboardCard title="Profile" subtitle="Unavailable">
          <p className="text-sm text-clay-ink">
            {(profile.error as Error)?.message ?? "Failed to load profile."}{" "}
            <button className="underline" onClick={() => profile.refetch()}>
              Retry
            </button>
          </p>
        </DashboardCard>
      </section>
    );
  }

  const p = profile.data;

  const saveInfo = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    // Empty input clears the name (server treats null as empty).
    updateProfile.mutate({ name: trimmed === "" ? null : trimmed });
  };

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordNotice(null);
    if (newPassword !== confirmPassword) {
      setPasswordNotice("New passwords do not match.");
      return;
    }
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setPasswordNotice("Password changed.");
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
        },
      },
    );
  };

  // 400 (wrong current password) and 429 (rate limited) are plain mutation
  // errors here: the global 401 handler ignores non-401 statuses, so a
  // failed attempt never logs the user out.
  const passwordError =
    changePassword.isError
      ? (changePassword.error as ApiError)?.status === 429
        ? `${(changePassword.error as Error).message} Please try again later.`
        : (changePassword.error as Error)?.message
      : null;

  const pickFile = (next: File | null) => {
    uploadAvatar.reset();
    if (!next) {
      setFileError(null);
      return;
    }
    const err = avatarClientError(next);
    setFileError(err);
    if (err) return;
    // Valid: open the cropper instead of enabling a direct upload.
    if (pendingUrlRef.current) URL.revokeObjectURL(pendingUrlRef.current);
    const url = URL.createObjectURL(next);
    pendingUrlRef.current = url;
    setPendingAvatarUrl(url);
  };

  const closeCropper = () => {
    if (pendingUrlRef.current) URL.revokeObjectURL(pendingUrlRef.current);
    pendingUrlRef.current = null;
    setPendingAvatarUrl(null);
    setFileError(null);
    uploadAvatar.reset();
    if (inputRef.current) inputRef.current.value = "";
  };

  const confirmCropped = (croppedFile: File) => {
    // Re-validate: canvas re-encode can change the byte size, so the
    // cropped result must pass the same client check BEFORE any upload.
    const err = avatarClientError(croppedFile);
    if (err) {
      // Stay in the cropper: nothing is sent to the server, the user can
      // cancel or pick another file.
      setFileError(err);
      return;
    }
    if (pendingUrlRef.current) URL.revokeObjectURL(pendingUrlRef.current);
    pendingUrlRef.current = null;
    setPendingAvatarUrl(null);
    setFileError(null);
    uploadAvatar.mutate(croppedFile, {
      onSuccess: () => {
        if (inputRef.current) inputRef.current.value = "";
      },
    });
  };

  return (
    <section id="profile" aria-label="My Profile" className="scroll-mt-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">My Profile</h2>
        <p className="mt-1 text-[13px] text-subtle">Manage your account</p>
      </div>

      <div className="max-w-2xl space-y-6">
        <DashboardCard title="Profile info" subtitle="Update your display name">
          <form onSubmit={saveInfo} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium">Name</span>
              <input
                type="text"
                aria-label="Name"
                className={inputCls}
                value={name}
                maxLength={100}
                placeholder="Your name (optional)"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium">Email</span>
              <input
                type="email"
                aria-label="Email (read-only)"
                className={inputCls}
                value={p.email}
                disabled
                readOnly
              />
            </label>
            <button
              type="submit"
              disabled={updateProfile.isPending}
              className={primaryBtnCls}
            >
              {updateProfile.isPending ? "Saving…" : "Save"}
            </button>
            {updateProfile.isError && (
              <p className="text-sm text-clay-ink">
                {(updateProfile.error as Error).message}
              </p>
            )}
            {updateProfile.isSuccess && (
              <p className="text-sm text-green-700">Profile saved.</p>
            )}
          </form>
        </DashboardCard>

        <DashboardCard
          title="Change password"
          subtitle="Other sessions are signed out"
        >
          <form onSubmit={submitPassword} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium">
                Current password
              </span>
              <input
                type="password"
                aria-label="Current password"
                autoComplete="current-password"
                className={inputCls}
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  setPasswordNotice(null);
                  changePassword.reset();
                }}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium">
                New password
              </span>
              <input
                type="password"
                aria-label="New password"
                autoComplete="new-password"
                className={inputCls}
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setPasswordNotice(null);
                  changePassword.reset();
                }}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium">
                Confirm new password
              </span>
              <input
                type="password"
                aria-label="Confirm new password"
                autoComplete="new-password"
                className={inputCls}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setPasswordNotice(null);
                  changePassword.reset();
                }}
              />
            </label>
            <button
              type="submit"
              disabled={
                changePassword.isPending ||
                !currentPassword ||
                !newPassword ||
                !confirmPassword
              }
              className={primaryBtnCls}
            >
              {changePassword.isPending ? "Changing…" : "Change password"}
            </button>
            {passwordNotice && (
              <p
                className={`text-sm ${
                  passwordNotice === "Password changed."
                    ? "text-green-700"
                    : "text-clay-ink"
                }`}
              >
                {passwordNotice}
              </p>
            )}
            {passwordError && (
              <p className="text-sm text-clay-ink">{passwordError}</p>
            )}
          </form>
        </DashboardCard>

        <DashboardCard title="Profile photo" subtitle="JPEG, PNG, or WebP up to 512KB">
          {pendingAvatarUrl ? (
            <div>
              <AvatarCropper
                src={pendingAvatarUrl}
                onCancel={closeCropper}
                onConfirm={confirmCropped}
              />
              {fileError && (
                <p className="mt-3 text-sm text-clay-ink">
                  {fileError} Choose another file or cancel.
                </p>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-4">
                <UserAvatar email={p.email} sizeCls="h-16 w-16" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.name ?? p.email}</p>
                  <p className="text-xs text-subtle">
                    {p.hasAvatar ? "Photo set" : "No photo yet"}
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-label="Choose a photo"
                  className="block w-full text-sm text-gray-600"
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                />
                {fileError && <p className="text-sm text-clay-ink">{fileError}</p>}
                <div className="flex flex-wrap gap-2">
                  {p.hasAvatar && (
                    <button
                      type="button"
                      disabled={deleteAvatar.isPending}
                      onClick={() => deleteAvatar.mutate()}
                      className={secondaryBtnCls}
                    >
                      {deleteAvatar.isPending ? "Removing…" : "Remove"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
            {uploadAvatar.isError && (
              <p className="text-sm text-clay-ink">
                {(uploadAvatar.error as Error).message}
              </p>
            )}
            {uploadAvatar.isSuccess && (
              <p className="text-sm text-green-700">Photo uploaded.</p>
            )}
            {deleteAvatar.isError && (
              <p className="text-sm text-clay-ink">
                {(deleteAvatar.error as Error).message}
              </p>
            )}
            {deleteAvatar.isSuccess && (
              <p className="text-sm text-green-700">Photo removed.</p>
            )}
        </DashboardCard>
      </div>
    </section>
  );
}
