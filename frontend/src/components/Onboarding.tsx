/**
 * First-run onboarding for static / web-ble product path.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bluetooth, Coffee, Sparkles, X } from "lucide-react";
import { Button } from "./ui";
import { useI18n } from "../i18n/I18nContext";

const KEY = "xbloom.onboarding.v1.done";

export function Onboarding() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) !== "1") setOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-3 sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={dismiss}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-ink">
              {t("onboarding.title")}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">{t("onboarding.desc")}</p>
          </div>
          <button
            type="button"
            className="rounded-full p-1 text-ink-muted hover:bg-surface-2 hover:text-ink"
            onClick={dismiss}
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ol className="space-y-3 text-sm">
          <li className="flex gap-3 rounded-xl bg-surface-2 p-3">
            <Bluetooth className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <div>
              <div className="font-medium text-ink">{t("onboarding.step1")}</div>
              <p className="mt-0.5 text-xs text-ink-muted">
                {t("onboarding.step1hint")}
              </p>
            </div>
          </li>
          <li className="flex gap-3 rounded-xl bg-surface-2 p-3">
            <Coffee className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <div>
              <div className="font-medium text-ink">{t("onboarding.step2")}</div>
              <p className="mt-0.5 text-xs text-ink-muted">
                {t("onboarding.step2hint")}
              </p>
            </div>
          </li>
          <li className="flex gap-3 rounded-xl bg-surface-2 p-3">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <div>
              <div className="font-medium text-ink">{t("onboarding.step3")}</div>
              <p className="mt-0.5 text-xs text-ink-muted">
                {t("onboarding.step3hint")}
              </p>
            </div>
          </li>
        </ol>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={dismiss}>
            {t("onboarding.start")}
          </Button>
          <Link
            to="/settings"
            onClick={dismiss}
            className="inline-flex h-8 items-center rounded-full border border-line bg-surface-2 px-3 text-xs font-medium text-ink"
          >
            {t("onboarding.settings")}
          </Link>
        </div>
      </div>
    </div>
  );
}
