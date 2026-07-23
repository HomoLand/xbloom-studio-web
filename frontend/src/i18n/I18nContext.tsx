import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  LOCALE_LABELS,
  LOCALES,
  messages,
  type Locale,
} from "./messages";

const STORAGE_KEY = "xbloom.locale";

function detectLocale(): Locale {
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "zh-CN" || raw === "en") return raw;
    } catch {
      /* ignore */
    }
  }
  if (typeof navigator !== "undefined") {
    const nav = (navigator.language || "").toLowerCase();
    if (nav.startsWith("zh")) return "zh-CN";
  }
  return "zh-CN";
}

type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, fallback?: string) => string;
  locales: typeof LOCALES;
  localeLabels: typeof LOCALE_LABELS;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback(
    (key: string, fallback?: string) => {
      return (
        messages[locale][key] ??
        messages["zh-CN"][key] ??
        fallback ??
        key
      );
    },
    [locale],
  );

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
      locales: LOCALES,
      localeLabels: LOCALE_LABELS,
    }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n requires I18nProvider");
  return ctx;
}
