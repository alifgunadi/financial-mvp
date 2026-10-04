import { useAvatarUrl, useProfile } from "../api/hooks";

// Shared avatar: stored photo when present, initial-letter fallback
// otherwise. Reads ["profile"] itself so Sidebar/MobileBar stay in sync
// without props drilling from App (which only has AuthUser from /me,
// and /me carries no avatar fields by design). No new query keys.
export default function UserAvatar({
  email,
  sizeCls,
}: {
  email: string;
  sizeCls: string;
}) {
  const profile = useProfile();
  const avatarUrl = useAvatarUrl(
    profile.data?.hasAvatar ?? false,
    profile.data?.avatarUpdatedAt ?? null,
  );
  // Text size matched to the avatar size to preserve the existing look
  // (Sidebar h-9 used text-sm, ProfilePage h-16 used text-xl).
  const textCls = sizeCls.includes("h-16") ? "text-xl" : "text-sm";
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt="Profile photo"
        className={`${sizeCls} shrink-0 rounded-full object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${sizeCls} flex shrink-0 items-center justify-center rounded-full bg-sand ${textCls} font-bold text-ink`}
    >
      {email.slice(0, 1).toUpperCase()}
    </span>
  );
}
