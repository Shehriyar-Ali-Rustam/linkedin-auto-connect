// Single source of truth for the safety caps. Changing these is the one edit
// that can actually get the account restricted, so they live alone in one file.

export const SAFE_DAILY_MAX = 30; // slider ceiling with no extra confirmation
export const HARD_DAILY_MAX = 50; // absolute ceiling, unlock box or not
export const WEEKLY_CAP = 100; // rolling 7 days, matches LinkedIn's own soft limit

export const DEFAULTS = {
  keywords: "",
  company: "",
  strictCompany: false,
  note: "",
  dailyLimit: 5,
  gapSec: 5,
  unlockHighVolume: false, // premium in the UI; kept for the cap logic
};

// LinkedIn truncates invite notes past this. Free accounts get 200.
export const NOTE_MAX_CHARS = 200;

export function clampDailyLimit(value, unlockHighVolume) {
  const ceiling = unlockHighVolume ? HARD_DAILY_MAX : SAFE_DAILY_MAX;
  const n = Math.floor(Number(value) || 0);
  return Math.min(Math.max(n, 0), ceiling);
}
