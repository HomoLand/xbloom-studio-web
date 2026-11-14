import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type {
  CoffeePour,
  CoffeeRecipeContent,
  TeaPour,
  TeaRecipeContent,
  TempValue,
} from "../api";
import { useI18n } from "../i18n/I18nContext";
import {
  applyCoffeeGrinderRpm,
  coffeeGrinderRpm,
  defaultCoffeePour,
  defaultTeaPour,
  GRINDER_RPM_OPTIONS,
  POUR_PATTERNS,
  VIBRATIONS,
} from "../lib/recipeDomain";
import {
  Button,
  Field,
  IconButton,
  Segmented,
  Select,
  TextInput,
} from "./ui";

type CoffeeProps = {
  value: CoffeeRecipeContent;
  onChange: (next: CoffeeRecipeContent) => void;
  disabled?: boolean;
  fieldErrors?: Record<string, string>;
};

type TeaProps = {
  value: TeaRecipeContent;
  onChange: (next: TeaRecipeContent) => void;
  disabled?: boolean;
  fieldErrors?: Record<string, string>;
};

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function whole(v: string, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n);
}

function TempInputField({
  id,
  value,
  onChange,
  disabled,
  allowOptional = false,
}: {
  id?: string;
  value: TempValue | undefined;
  onChange: (next: TempValue | undefined) => void;
  disabled?: boolean;
  allowOptional?: boolean;
}) {
  const { t } = useI18n();
  const mode = value === "RT" ? "RT" : value === "BP" ? "BP" : "num";
  const pillCls = (active: boolean) =>
    `h-9 rounded-xl px-2.5 text-xs font-medium transition-colors ${
      active
        ? "bg-brand text-paper"
        : "border border-line bg-surface text-ink-muted hover:text-ink"
    }`;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(allowOptional && mode === "RT" ? undefined : "RT")}
        className={pillCls(mode === "RT")}
      >
        {t("editor.tempRoom")}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(allowOptional && mode === "BP" ? undefined : "BP")}
        className={pillCls(mode === "BP")}
      >
        {t("editor.tempBoiling")}
      </button>
      <TextInput
        id={id}
        type="number"
        min={40}
        max={98}
        step={1}
        placeholder={t("editor.tempCustom")}
        value={typeof value === "number" ? value : ""}
        disabled={disabled}
        className="min-w-14 flex-1"
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            if (allowOptional) onChange(undefined);
            return;
          }
          const parsed = Math.round(Number(raw));
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        onFocus={() => {
          if (!allowOptional && (value === "RT" || value === "BP")) {
            onChange(92);
          }
        }}
      />
    </div>
  );
}

/** True if swapping index with index+dir would place a center pour at index 0. */
function moveWouldPutCenterFirst(
  pours: CoffeePour[],
  index: number,
  dir: -1 | 1,
): boolean {
  const j = index + dir;
  if (j < 0 || j >= pours.length) return false;
  const next = [...pours];
  const tmp = next[index]!;
  next[index] = next[j]!;
  next[j] = tmp;
  return next[0]?.pattern === "center";
}

/** True if removing index would leave a center pour at index 0. */
function removeWouldPutCenterFirst(pours: CoffeePour[], index: number): boolean {
  if (pours.length <= 1) return false;
  const next = pours.filter((_, i) => i !== index);
  return next[0]?.pattern === "center";
}

export function CoffeeEditor({
  value,
  onChange,
  disabled,
  fieldErrors = {},
}: CoffeeProps) {
  const { t } = useI18n();
  const grinderRpm = coffeeGrinderRpm(value.pours);
  const set = <K extends keyof CoffeeRecipeContent>(
    key: K,
    v: CoffeeRecipeContent[K],
  ) => onChange({ ...value, [key]: v });

  const updatePour = (index: number, patch: Partial<CoffeePour>) => {
    // Core forbids center as the first coffee pour.
    if (index === 0 && patch.pattern === "center") {
      return;
    }
    const pours = value.pours.map((p, i) => {
      if (i !== index) return p;
      const next = { ...p, ...patch };
      if (patch.pattern != null) {
        next.rpm = patch.pattern === "center" ? 0 : grinderRpm;
      }
      return next;
    });
    onChange({ ...value, pours });
  };

  const movePour = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= value.pours.length) return;
    // Core forbids center as the first coffee pour; never rewrite a pattern
    // to make the reorder valid -- block the move instead.
    if (moveWouldPutCenterFirst(value.pours, index, dir)) return;
    const pours = [...value.pours];
    const tmp = pours[index]!;
    pours[index] = pours[j]!;
    pours[j] = tmp;
    onChange({ ...value, pours });
  };

  const removePour = (index: number) => {
    if (value.pours.length <= 2) return;
    // Removing a pour that would leave center at index 0 is a no-op.
    if (removeWouldPutCenterFirst(value.pours, index)) return;
    onChange({ ...value, pours: value.pours.filter((_, i) => i !== index) });
  };

  const addPour = () => {
    if (value.pours.length >= 5) return;
    onChange({
      ...value,
      pours: [
        ...value.pours,
        { ...defaultCoffeePour(value.pours.length), rpm: grinderRpm },
      ],
    });
  };

  const isFlash = value.kind === "flash-brew";
  const pourTargetMl = isFlash
    ? Math.max(0, Math.round(value.hot_water_ml ?? value.water_ml))
    : Math.max(0, Math.round(value.water_ml));
  const pourSumMl = value.pours.reduce(
    (sum, p) => sum + (Number.isFinite(p.ml) ? p.ml : 0),
    0,
  );
  const pourDiffMl = Math.round(pourTargetMl - pourSumMl);
  const pourMatched = Math.abs(pourDiffMl) <= 1;
  const pourPct =
    pourTargetMl > 0
      ? Math.min(100, Math.round((pourSumMl / pourTargetMl) * 100))
      : 0;
  const canScalePours =
    !disabled &&
    value.pours.length > 0 &&
    !pourMatched &&
    pourTargetMl >= value.pours.length * 10 &&
    pourTargetMl <= value.pours.length * 127;

  const scalePoursToTarget = () => {
    const n = value.pours.length;
    if (!n || pourTargetMl < n * 10) return;
    const baseSum = value.pours.reduce(
      (s, p) => s + (p.ml > 0 ? p.ml : 0),
      0,
    );
    const scaled = value.pours.map((p) => {
      const raw =
        baseSum > 0 ? (Math.max(0, p.ml) / baseSum) * pourTargetMl : pourTargetMl / n;
      return Math.min(127, Math.max(10, Math.round(raw)));
    });
    let remainder =
      pourTargetMl - scaled.reduce((sum, ml) => sum + ml, 0);
    for (let step = 0; step < Math.abs(remainder) + n * 2 && remainder !== 0; step++) {
      const idx = n - 1 - (step % n);
      if (remainder > 0 && scaled[idx]! < 127) {
        scaled[idx]! += 1;
        remainder -= 1;
      } else if (remainder < 0 && scaled[idx]! > 10) {
        scaled[idx]! -= 1;
        remainder += 1;
      }
    }
    onChange({
      ...value,
      pours: value.pours.map((p, idx) => ({ ...p, ml: scaled[idx]! })),
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("editor.name")} htmlFor="coffee-name" error={fieldErrors.name} className="sm:col-span-2">
          <TextInput
            id="coffee-name"
            value={value.name}
            disabled={disabled}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>

        <Field label={t("editor.kind")} className="sm:col-span-2">
          <Segmented
            ariaLabel={t("editor.kind")}
            value={value.kind}
            onChange={(kind) => {
              if (kind === "flash-brew") {
                onChange({
                  ...value,
                  kind,
                  hot_water_ml: value.hot_water_ml ?? Math.min(value.water_ml, 200),
                  ice_g: value.ice_g ?? 100,
                });
              } else {
                onChange({ ...value, kind });
              }
            }}
            options={[
              { value: "hot", label: t("editor.hot") },
              { value: "flash-brew", label: t("editor.flash") },
            ]}
          />
        </Field>

        <Field label={t("editor.dripper")} htmlFor="coffee-dripper" error={fieldErrors.dripper}>
          <TextInput
            id="coffee-dripper"
            value={value.dripper ?? ""}
            disabled={disabled}
            onChange={(e) => set("dripper", e.target.value)}
          />
        </Field>
        <Field label={t("editor.dose")} htmlFor="coffee-dose" error={fieldErrors.dose_g}>
          <TextInput
            id="coffee-dose"
            type="number"
            min={5}
            max={18}
            step={1}
            value={value.dose_g}
            disabled={disabled}
            onChange={(e) => set("dose_g", whole(e.target.value, value.dose_g))}
          />
        </Field>
        <Field label={t("editor.grind")} htmlFor="coffee-grind" error={fieldErrors.grind}>
          <TextInput
            id="coffee-grind"
            type="number"
            min={0}
            max={75}
            step={1}
            value={value.grind}
            disabled={disabled}
            onChange={(e) => set("grind", whole(e.target.value, value.grind))}
          />
        </Field>
        <Field label={t("editor.rpm")} htmlFor="coffee-rpm" error={fieldErrors.rpm}>
          <Select
            id="coffee-rpm"
            value={String(grinderRpm)}
            disabled={disabled}
            onChange={(e) =>
              onChange(applyCoffeeGrinderRpm(value, Number(e.target.value)))
            }
          >
            {GRINDER_RPM_OPTIONS.map((rpmOpt) => (
              <option key={rpmOpt} value={String(rpmOpt)}>
                {rpmOpt} RPM
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("editor.ratio")} htmlFor="coffee-ratio" error={fieldErrors.ratio}>
          <TextInput
            id="coffee-ratio"
            type="number"
            min={8}
            max={20}
            step={0.1}
            value={value.ratio}
            disabled={disabled}
            onChange={(e) => set("ratio", num(e.target.value, value.ratio))}
          />
        </Field>
        <Field label={t("editor.water")} htmlFor="coffee-water" error={fieldErrors.water_ml}>
          <TextInput
            id="coffee-water"
            type="number"
            min={60}
            max={540}
            value={value.water_ml}
            disabled={disabled}
            onChange={(e) => set("water_ml", num(e.target.value, value.water_ml))}
          />
        </Field>
        <Field
          label={t("editor.hotWater")}
          htmlFor="coffee-hot-water"
          error={fieldErrors.hot_water_ml}
        >
          <TextInput
            id="coffee-hot-water"
            type="number"
            min={60}
            max={360}
            value={value.hot_water_ml ?? ""}
            disabled={disabled}
            onChange={(e) =>
              set(
                "hot_water_ml",
                e.target.value === "" ? undefined : num(e.target.value, 0),
              )
            }
          />
        </Field>
        {isFlash ? (
          <Field label={t("editor.ice")} htmlFor="coffee-ice" error={fieldErrors.ice_g}>
            <TextInput
              id="coffee-ice"
              type="number"
              min={40}
              max={180}
              value={value.ice_g ?? ""}
              disabled={disabled}
              onChange={(e) =>
                set(
                  "ice_g",
                  e.target.value === "" ? undefined : num(e.target.value, 0),
                )
              }
            />
          </Field>
        ) : null}
        <Field label="Bypass (ml)" htmlFor="coffee-bypass" error={fieldErrors.bypass_ml}>
          <TextInput
            id="coffee-bypass"
            type="number"
            min={0}
            max={100}
            value={value.bypass_ml ?? ""}
            disabled={disabled}
            onChange={(e) =>
              set(
                "bypass_ml",
                e.target.value === "" ? undefined : num(e.target.value, 0),
              )
            }
          />
        </Field>
        <Field
          label={t("editor.bypassTemp")}
          htmlFor="coffee-bypass-temp"
          error={fieldErrors.bypass_temp_c}
        >
          <TempInputField
            id="coffee-bypass-temp"
            value={value.bypass_temp_c}
            disabled={disabled}
            allowOptional
            onChange={(next) => set("bypass_temp_c", next)}
          />
        </Field>
        <Field label={t("editor.note")} htmlFor="coffee-note" className="sm:col-span-2" error={fieldErrors.note}>
          <TextInput
            id="coffee-note"
            value={value.note ?? ""}
            disabled={disabled}
            maxLength={500}
            onChange={(e) => set("note", e.target.value)}
          />
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-ink">
            {t("editor.pours")}{" "}
            <span className="text-ink-faint">({value.pours.length}/5)</span>
          </h3>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || value.pours.length >= 5}
            onClick={addPour}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("editor.addPour")}
          </Button>
        </div>
        <div className="mb-3 rounded-xl border border-line bg-surface-2 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className={pourMatched ? "font-medium text-accent-green" : "font-medium text-accent-amber"}>
              {(pourMatched ? t("editor.pourSumMatch") : t("editor.pourSumDiff"))
                .replace("{sum}", String(Math.round(pourSumMl)))
                .replace("{target}", String(pourTargetMl))}
            </span>
            {canScalePours ? (
              <button
                type="button"
                onClick={scalePoursToTarget}
                className="rounded-lg border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-ink hover:bg-surface-3"
              >
                {t("editor.scalePoursToTarget").replace("{target}", String(pourTargetMl))}
              </button>
            ) : null}
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className={`h-full rounded-full transition-[width] duration-200 ${
                pourMatched
                  ? "bg-accent-green"
                  : pourTargetMl > 0 && pourSumMl > pourTargetMl * 1.1
                    ? "bg-accent-red"
                    : "bg-accent-amber"
              }`}
              style={{ width: `${pourPct}%` }}
            />
          </div>
        </div>
        <div className="space-y-2">
          {value.pours.map((p, i) => (
            <PourRowCoffee
              key={i}
              index={i}
              pour={p}
              disabled={disabled}
              canRemove={
                value.pours.length > 2 &&
                !removeWouldPutCenterFirst(value.pours, i)
              }
              canMoveUp={
                i > 0 && !moveWouldPutCenterFirst(value.pours, i, -1)
              }
              canMoveDown={
                i < value.pours.length - 1 &&
                !moveWouldPutCenterFirst(value.pours, i, 1)
              }
              onChange={(patch) => updatePour(i, patch)}
              onMove={(dir) => movePour(i, dir)}
              onRemove={() => removePour(i)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PourRowCoffee({
  index,
  pour,
  disabled,
  canRemove,
  canMoveUp,
  canMoveDown,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  pour: CoffeePour;
  disabled?: boolean;
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (patch: Partial<CoffeePour>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="rounded-2xl border border-line bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-muted">
          {t("editor.pours")} {index + 1}
        </span>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="↑"
            disabled={disabled || !canMoveUp}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
          </IconButton>
          <IconButton
            label="↓"
            disabled={disabled || !canMoveDown}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          </IconButton>
          <IconButton label={t("design.removeImage")} disabled={disabled || !canRemove} onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </IconButton>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Field label={t("editor.pourLabel")}>
          <TextInput
            value={pour.label ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </Field>
        <Field label={t("editor.ml")}>
          <TextInput
            type="number"
            min={10}
            max={127}
            value={pour.ml}
            disabled={disabled}
            onChange={(e) => onChange({ ml: num(e.target.value, pour.ml) })}
          />
        </Field>
        <Field label={t("editor.temp")}>
          <TempInputField
            value={pour.temp_c}
            disabled={disabled}
            onChange={(next) => {
              if (next !== undefined) onChange({ temp_c: next });
            }}
          />
        </Field>
        <Field label={t("editor.pattern")}>
          <Select
            value={pour.pattern}
            disabled={disabled}
            onChange={(e) =>
              onChange({ pattern: e.target.value as CoffeePour["pattern"] })
            }
          >
            {POUR_PATTERNS.map((p) => (
              <option
                key={p}
                value={p}
                disabled={index === 0 && p === "center"}
              >
                {t(`pattern.${p}` as Parameters<typeof t>[0])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("editor.pause")}>
          <TextInput
            type="number"
            min={0}
            max={60}
            value={pour.pause_s}
            disabled={disabled}
            onChange={(e) => onChange({ pause_s: num(e.target.value, pour.pause_s) })}
          />
        </Field>
        <Field label={t("editor.flow")}>
          <TextInput
            type="number"
            min={3}
            max={3.5}
            step={0.1}
            value={pour.flow_ml_s}
            disabled={disabled}
            onChange={(e) =>
              onChange({ flow_ml_s: num(e.target.value, pour.flow_ml_s) })
            }
          />
        </Field>
        <Field label={t("editor.vibration")}>
          <Select
            value={pour.vibration ?? "none"}
            disabled={disabled}
            onChange={(e) =>
              onChange({ vibration: e.target.value as CoffeePour["vibration"] })
            }
          >
            {VIBRATIONS.map((v) => (
              <option key={v} value={v}>
                {t(`vibration.${v}` as Parameters<typeof t>[0])}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
}

export function TeaEditor({
  value,
  onChange,
  disabled,
  fieldErrors = {},
}: TeaProps) {
  const { t } = useI18n();
  const set = <K extends keyof TeaRecipeContent>(
    key: K,
    v: TeaRecipeContent[K],
  ) => onChange({ ...value, [key]: v });

  const updatePour = (index: number, patch: Partial<TeaPour>) => {
    const pours = value.pours.map((p, i) => (i === index ? { ...p, ...patch } : p));
    onChange({ ...value, pours });
  };

  const movePour = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= value.pours.length) return;
    const pours = [...value.pours];
    const tmp = pours[index]!;
    pours[index] = pours[j]!;
    pours[j] = tmp;
    onChange({ ...value, pours });
  };

  const removePour = (index: number) => {
    if (value.pours.length <= 1) return;
    onChange({ ...value, pours: value.pours.filter((_, i) => i !== index) });
  };

  const addPour = () => {
    if (value.pours.length >= 4) return;
    onChange({
      ...value,
      pours: [...value.pours, defaultTeaPour(value.pours.length)],
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("editor.name")} htmlFor="tea-name" error={fieldErrors.name} className="sm:col-span-2">
          <TextInput
            id="tea-name"
            value={value.name}
            disabled={disabled}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field label={t("editor.leaf")} htmlFor="tea-leaf" error={fieldErrors.leaf_g}>
          <TextInput
            id="tea-leaf"
            type="number"
            min={3}
            max={5}
            step={0.1}
            value={value.leaf_g}
            disabled={disabled}
            onChange={(e) => set("leaf_g", num(e.target.value, value.leaf_g))}
          />
        </Field>
        <Field
          label={t("editor.output")}
          htmlFor="tea-output"
          error={fieldErrors.output_ml_per_steep}
        >
          <TextInput
            id="tea-output"
            type="number"
            min={80}
            max={160}
            value={value.output_ml_per_steep}
            disabled={disabled}
            onChange={(e) =>
              set("output_ml_per_steep", num(e.target.value, value.output_ml_per_steep))
            }
          />
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-ink">
            {t("editor.steeps")} <span className="text-ink-faint">({value.pours.length}/4)</span>
          </h3>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || value.pours.length >= 4}
            onClick={addPour}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("editor.addSteep")}
          </Button>
        </div>
        <div className="space-y-2">
          {value.pours.map((p, i) => (
            <div key={i} className="rounded-2xl border border-line bg-surface-2 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink-muted">
                  {t("editor.steepNum").replace("{n}", String(i + 1))}
                </span>
                <div className="flex items-center gap-0.5">
                  <IconButton
                    label="↑"
                    disabled={disabled || i === 0}
                    onClick={() => movePour(i, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  </IconButton>
                  <IconButton
                    label="↓"
                    disabled={disabled || i === value.pours.length - 1}
                    onClick={() => movePour(i, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </IconButton>
                  <IconButton
                    label={t("editor.remove")}
                    disabled={disabled || value.pours.length <= 1}
                    onClick={() => removePour(i)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </IconButton>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Field label={t("editor.pourLabel")}>
                  <TextInput
                    value={p.label ?? ""}
                    disabled={disabled}
                    onChange={(e) => updatePour(i, { label: e.target.value })}
                  />
                </Field>
                <Field label={t("editor.ml")}>
                  <TextInput
                    type="number"
                    min={40}
                    max={100}
                    value={p.ml}
                    disabled={disabled}
                    onChange={(e) => updatePour(i, { ml: num(e.target.value, p.ml) })}
                  />
                </Field>
                <Field label={t("editor.temp")}>
                  <TextInput
                    type="number"
                    min={70}
                    max={99}
                    value={p.temp_c}
                    disabled={disabled}
                    onChange={(e) =>
                      updatePour(i, { temp_c: num(e.target.value, p.temp_c) })
                    }
                  />
                </Field>
                <Field label={t("editor.pattern")}>
                  <Select
                    value={p.pattern}
                    disabled={disabled}
                    onChange={(e) =>
                      updatePour(i, {
                        pattern: e.target.value as TeaPour["pattern"],
                      })
                    }
                  >
                    {POUR_PATTERNS.map((pat) => (
                      <option key={pat} value={pat}>
                        {t(`pattern.${pat}` as Parameters<typeof t>[0])}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("editor.steepSec")}>
                  <TextInput
                    type="number"
                    min={1}
                    max={120}
                    value={p.pause_s}
                    disabled={disabled}
                    onChange={(e) =>
                      updatePour(i, { pause_s: num(e.target.value, p.pause_s) })
                    }
                  />
                </Field>
                <Field label={t("editor.flow")}>
                  <TextInput
                    type="number"
                    min={3}
                    max={3.5}
                    step={0.1}
                    value={p.flow_ml_s}
                    disabled={disabled}
                    onChange={(e) =>
                      updatePour(i, {
                        flow_ml_s: num(e.target.value, p.flow_ml_s),
                      })
                    }
                  />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
