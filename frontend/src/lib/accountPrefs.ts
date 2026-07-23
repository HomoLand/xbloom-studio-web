/**
 * Non-secret account preferences (email + region only).
 * Password is never persisted.
 */

const KEY = "xbloom.accountPrefs.v1";

export type AccountPrefs = {
  email: string;
  region: "international" | "china";
  /** languageType for app API 0-3 */
  languageType: number;
};

const DEFAULT: AccountPrefs = {
  email: "",
  region: "china",
  languageType: 1,
};

export function readAccountPrefs(): AccountPrefs {
  if (typeof localStorage === "undefined") return { ...DEFAULT };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    const p = JSON.parse(raw) as Partial<AccountPrefs>;
    return {
      email: typeof p.email === "string" ? p.email : "",
      region: p.region === "international" ? "international" : "china",
      languageType:
        typeof p.languageType === "number" && p.languageType >= 0 && p.languageType <= 3
          ? p.languageType
          : DEFAULT.languageType,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function writeAccountPrefs(prefs: Partial<AccountPrefs>): AccountPrefs {
  const next = { ...readAccountPrefs(), ...prefs };
  // never store password fields if caller accidentally passes them
  const safe: AccountPrefs = {
    email: next.email,
    region: next.region,
    languageType: next.languageType,
  };
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, JSON.stringify(safe));
  }
  return safe;
}
