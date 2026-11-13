/**
 * xBloom account preferences.
 * - email / region / languageType → localStorage (non-secret)
 * - hosted deployments keep the official session on the host, never a password
 * - static deployments keep the password in sessionStorage only
 */

import { api } from "../api.ts";
import { isStaticDeploy } from "./deploy.ts";

const PREFS_KEY = "xbloom.accountPrefs.v1";
const PASSWORD_KEY = "xbloom.accountPassword.session";

export type AccountPrefs = {
  email: string;
  region: "international" | "china";
  /** languageType for app API 0-3 */
  languageType: number;
};

/** Credentials ready for cloud API calls. */
export type AccountCredentials = AccountPrefs & {
  password: string;
};

const DEFAULT: AccountPrefs = {
  email: "",
  region: "china",
  languageType: 1,
};

export function readAccountPrefs(): AccountPrefs {
  if (typeof localStorage === "undefined") return { ...DEFAULT };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT };
    const p = JSON.parse(raw) as Partial<AccountPrefs>;
    return {
      email: typeof p.email === "string" ? p.email : "",
      region: p.region === "international" ? "international" : "china",
      languageType:
        typeof p.languageType === "number" &&
        p.languageType >= 0 &&
        p.languageType <= 3
          ? p.languageType
          : DEFAULT.languageType,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function writeAccountPrefs(prefs: Partial<AccountPrefs>): AccountPrefs {
  const next = { ...readAccountPrefs(), ...prefs };
  const safe: AccountPrefs = {
    email: next.email.trim(),
    region: next.region,
    languageType: next.languageType,
  };
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(PREFS_KEY, JSON.stringify(safe));
  }
  return safe;
}

/** Session-only password (tab lifetime). Never writes localStorage. */
export function readSessionPassword(): string {
  if (typeof sessionStorage === "undefined") return "";
  try {
    return sessionStorage.getItem(PASSWORD_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeSessionPassword(password: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (password) sessionStorage.setItem(PASSWORD_KEY, password);
    else sessionStorage.removeItem(PASSWORD_KEY);
  } catch {
    /* private mode */
  }
}

export function clearSessionPassword(): void {
  writeSessionPassword("");
}

export function hasAccountCredentials(): boolean {
  const prefs = readAccountPrefs();
  return Boolean(prefs.email.trim() && readSessionPassword());
}

/**
 * Returns credentials for cloud calls, or null if incomplete.
 * Hosted credentials contain only account metadata; cloud calls use the host session.
 */
export async function getAccountCredentials(): Promise<AccountCredentials | null> {
  if (!isStaticDeploy()) {
    const account = await api.accountStatus();
    if (!account.configured || !account.email || !account.region) return null;
    return { email: account.email, region: account.region, languageType: account.languageType ?? 1, password: "" };
  }
  const prefs = readAccountPrefs();
  const password = readSessionPassword();
  if (!prefs.email.trim() || !password) return null;
  return { ...prefs, password };
}

/** Hosted: verify and save a bearer session. Static: save the tab password. */
export async function saveAccountSession(input: {
  email: string;
  password: string;
  region: "international" | "china";
  languageType?: number;
}): Promise<AccountCredentials> {
  if (!isStaticDeploy()) {
    await api.accountLogin(input);
    clearSessionPassword();
    const prefs = writeAccountPrefs({ email: input.email, region: input.region, languageType: input.languageType ?? 1 });
    return { ...prefs, password: "" };
  }
  const prefs = writeAccountPrefs({
    email: input.email,
    region: input.region,
    languageType: input.languageType ?? 1,
  });
  writeSessionPassword(input.password);
  return { ...prefs, password: input.password };
}
