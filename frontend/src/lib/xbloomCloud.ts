/**
 * xBloom account cloud client (browser).
 *
 * Mirrors packages/core/xbloom_catalog.py:
 * - PKCS#1 v1.5 RSA chunked form encrypt (public app key)
 * - Host-owned session (or ephemeral login for static builds) → sync / add / delete
 * - Update = delete then create (user requirement)
 *
 * Credentials are never written to localStorage by this module.
 * Password stays in call-site memory only.
 *
 * Note: official APIs may block browser CORS from GitHub Pages; errors surface
 * as network failures. Desktop/native Python path is unaffected.
 */

import type { CoffeeRecipeContent, RecipeContent } from "../api.ts";
import { api } from "../api.ts";
import { isStaticDeploy } from "./deploy.ts";
import { isCoffeeContent, isTeaContent } from "./recipeDomain.ts";

export const APP_RSA_PUBLIC_KEY_B64 =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC4LF40GZ72SdhMyl765K/i4nY5" +
  "CPcHz2Q1IKWKZ9S79xmK7G8pUhbVf4EZLvnNF1+9IvOFQUKV5Z7ZNNviqSpnql9t" +
  "AT+8+J/He0R7pcirvVSxgdr2i9V/C/gmqAEZ5qVTzRnd3uWdFoKzPdEBxP0IporJ1" +
  "VBbCv90yBSOhVxO+QIDAQAB";

export const BASE_URLS = {
  international: "https://client-api.xbloom.com/",
  china: "https://clientcn-api.xbloomcoffee.cn/",
} as const;

export type CloudRegion = keyof typeof BASE_URLS;

export const LOGIN_ENDPOINT = "tMemberLogin.thtml";
export const APP_VERSION = "2.2.2";
export const LOGIN_INTERFACE_VERSION = 20240918;
export const CATALOG_INTERFACE_VERSION = 19700101;
export const RECIPE_WRITE_INTERFACE_VERSION = 20240918;
export const APP_SKEY = "testskey";
export const DEFAULT_CLIENT_TYPE = 7;
export const DEFAULT_RECIPE_COLOR = "#ADBDDB";

export const ENDPOINTS = {
  coffee: "tHostRecipe.thtml",
  tea: "tuTeaRecipe.tuhtml",
  created: "tuMyTeaRecipeCreated.tuhtml",
  product: "tuMyRecipeProduct.tuhtml",
  shared: "tuMyRecipeShared.tuhtml",
  easy: "tuEasyModeList.tuhtml",
  "easy-default": "tuEasyModeInitList.tuhtml",
} as const;

export const RECIPE_ADD_ENDPOINT = "tuRecipeAdd.tuhtml";
export const RECIPE_DELETE_ENDPOINT = "tuRecipeDelete.tuhtml";
export const BREW_RECORD_LIST_ENDPOINT = "tuBrewRecordList.tuhtml";

export const CLOUD_WRITE_CONFIRM = "own-account-cloud-recipe";
export const CLOUD_DELETE_CONFIRM = "own-account-cloud-recipe-delete";

export const DEFAULT_ACCOUNT_TARGETS = [
  "coffee",
  "tea",
  "created",
  "product",
  "shared",
] as const;

export type AccountTarget = (typeof DEFAULT_ACCOUNT_TARGETS)[number];

export class CloudError extends Error {
  /** Machine-readable code for UI (e.g. not_on_account). */
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "CloudError";
    this.code = code;
  }
}

export function cloudErrorMessage(
  error: unknown,
  t: (key: "cloud.networkError" | "cloud.sessionExpired") => string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  // Endpoint names such as tMemberLogin must not classify transport failures as auth.
  if (/network|fetch|cors/i.test(message)) return t("cloud.networkError");
  if (/\b(password|auth|login)\b|HTTP (401|403)\b/i.test(message)) {
    return t("cloud.sessionExpired");
  }
  return message;
}

export type SessionForm = {
  skey: string;
  phoneType: string;
  appVersion: string;
  clientDetail: string;
  clientSecretStr: string;
  interfaceVersion: number;
  token: string;
  memberId: number;
  clientType: number;
  languageType: number;
  pageNumber: number;
  countPerPage: number;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// RSA PKCS#1 v1.5 (BigInt) — matches app_encrypt_form
// ---------------------------------------------------------------------------

function derTlv(
  data: Uint8Array,
  offset: number,
): { tag: number; value: Uint8Array; end: number } {
  if (offset >= data.length) throw new CloudError("invalid RSA public key");
  const tag = data[offset]!;
  offset += 1;
  if (offset >= data.length) throw new CloudError("invalid RSA public key");
  let length = data[offset]!;
  offset += 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || offset + count > data.length) {
      throw new CloudError("invalid RSA public key");
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = (length << 8) | data[offset + i]!;
    }
    offset += count;
  }
  const end = offset + length;
  if (end > data.length) throw new CloudError("invalid RSA public key");
  return { tag, value: data.subarray(offset, end), end };
}

function rsaPublicNumbers(): { modulus: bigint; exponent: bigint } {
  const der = Uint8Array.from(atob(APP_RSA_PUBLIC_KEY_B64), (c) =>
    c.charCodeAt(0),
  );
  const spki = derTlv(der, 0);
  if (spki.tag !== 0x30 || spki.end !== der.length) {
    throw new CloudError("invalid RSA SubjectPublicKeyInfo");
  }
  // skip algorithm identifier
  const alg = derTlv(spki.value, 0);
  const bit = derTlv(spki.value, alg.end);
  if (bit.tag !== 0x03 || bit.value.length < 1 || bit.value[0] !== 0) {
    throw new CloudError("invalid RSA public-key bit string");
  }
  const rsaSeq = derTlv(bit.value.subarray(1), 0);
  if (rsaSeq.tag !== 0x30) throw new CloudError("invalid RSA public-key sequence");
  const mod = derTlv(rsaSeq.value, 0);
  if (mod.tag !== 0x02) throw new CloudError("invalid RSA modulus");
  const exp = derTlv(rsaSeq.value, mod.end);
  if (exp.tag !== 0x02) throw new CloudError("invalid RSA exponent");
  return {
    modulus: bytesToBigInt(mod.value),
    exponent: bytesToBigInt(exp.value),
  };
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = n;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function nonzeroRandom(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let filled = 0;
  let attempts = 0;
  while (filled < length) {
    attempts += 1;
    const chunk = new Uint8Array(length - filled);
    crypto.getRandomValues(chunk);
    for (const b of chunk) {
      if (b !== 0) out[filled++] = b;
      if (filled >= length) break;
    }
    if (attempts > 128 && filled < length) {
      throw new CloudError("RSA random source returned too many zero bytes");
    }
  }
  return out;
}

/** Encode one form exactly like Android BaseTransfer RSA/PKCS#1 v1.5 path. */
export function appEncryptForm(form: Record<string, unknown>): string {
  // Match Python: json.dumps(form, ensure_ascii=False, separators=(",", ":"))
  const plaintext = new TextEncoder().encode(JSON.stringify(form));
  const { modulus, exponent } = rsaPublicNumbers();
  const bitLen = modulus.toString(2).length;
  const blockSize = Math.floor((bitLen + 7) / 8);
  const chunkSize = blockSize - 11;
  const encrypted: number[] = [];
  for (let start = 0; start < plaintext.length; start += chunkSize) {
    const chunk = plaintext.subarray(start, start + chunkSize);
    const padding = nonzeroRandom(blockSize - chunk.length - 3);
    const encoded = new Uint8Array(blockSize);
    encoded[0] = 0x00;
    encoded[1] = 0x02;
    encoded.set(padding, 2);
    encoded[2 + padding.length] = 0x00;
    encoded.set(chunk, 3 + padding.length);
    const cipher = modPow(bytesToBigInt(encoded), exponent, modulus);
    encrypted.push(...bigIntToBytes(cipher, blockSize));
  }
  let bin = "";
  for (const b of encrypted) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Alias used by cloudRequest. */
export const appEncryptFormStrict = appEncryptForm;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export async function cloudRequest(
  baseUrl: string,
  endpoint: string,
  form: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<unknown> {
  if (typeof form.hostSession === "string") {
    return api.accountRequest(endpoint, form);
  }
  const encrypted = appEncryptFormStrict(form);
  // Body is a JSON string of the base64 ciphertext (double-encoded like the app).
  const body = JSON.stringify(encrypted);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "User-Agent": "xbloom-studio-web-catalog/1",
      },
      body,
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
    });
    if (!res.ok) {
      throw new CloudError(`xBloom cloud ${endpoint} returned HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text.length > 10 * 1024 * 1024) {
      throw new CloudError(`xBloom cloud ${endpoint} response exceeded size limit`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CloudError(`xBloom cloud ${endpoint} returned invalid JSON`);
    }
  } catch (e) {
    if (e instanceof CloudError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new CloudError(`xBloom cloud ${endpoint} timed out`);
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
      throw new CloudError(
        `xBloom cloud ${endpoint} request failed (network/CORS). Official APIs may block browser origins; try a local proxy or the Python skill CLI.`,
      );
    }
    throw new CloudError(`xBloom cloud ${endpoint} request failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function newClientSecret(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `web-${Date.now().toString(16)}`;
}

function normaliseRegion(region: string): CloudRegion {
  const value = region.trim().toLowerCase();
  const aliases: Record<string, CloudRegion> = {
    intl: "international",
    en: "international",
    international: "international",
    cn: "china",
    zh: "china",
    china: "china",
  };
  const resolved = aliases[value];
  if (!resolved) throw new CloudError("cloud region must be international or china");
  return resolved;
}

function appBaseForm(opts: {
  clientSecret: string;
  interfaceVersion: number;
  token?: string;
  memberId?: number;
  languageType?: number;
}): SessionForm {
  const languageType = opts.languageType ?? 0;
  if (![0, 1, 2, 3].includes(languageType)) {
    throw new CloudError("language_type must be 0-3");
  }
  return {
    skey: APP_SKEY,
    phoneType: "Android",
    appVersion: APP_VERSION,
    clientDetail: "Codex:xbloom-studio-web",
    clientSecretStr: opts.clientSecret,
    interfaceVersion: opts.interfaceVersion,
    token: opts.token ?? "",
    memberId: opts.memberId ?? 0,
    clientType: DEFAULT_CLIENT_TYPE,
    languageType,
    pageNumber: 1,
    countPerPage: 0,
  };
}

export async function loginEphemeral(opts: {
  email: string;
  password: string;
  region: string;
  languageType?: number;
  timeoutMs?: number;
}): Promise<{ region: CloudRegion; session: SessionForm | { hostSession: string; memberId: number } }> {
  if (!isStaticDeploy()) {
    const account = await api.accountStatus();
    if (!account.configured || !account.region || !account.session) {
      throw new CloudError("xBloom account login required; sign in in Settings");
    }
    return { region: account.region, session: account.session };
  }
  if (!opts.email?.trim()) throw new CloudError("xBloom account email is required");
  if (!opts.password) throw new CloudError("xBloom account password is required");
  const region = normaliseRegion(opts.region);
  const clientSecret = newClientSecret();
  const loginForm = appBaseForm({
    clientSecret,
    interfaceVersion: LOGIN_INTERFACE_VERSION,
    languageType: opts.languageType ?? 0,
  });
  Object.assign(loginForm, {
    email: opts.email.trim(),
    password: opts.password,
    jpushId: "",
  });
  const payload = (await cloudRequest(
    BASE_URLS[region],
    LOGIN_ENDPOINT,
    loginForm,
    opts.timeoutMs,
  )) as Record<string, unknown>;
  if (payload?.result !== "success") {
    const code = payload?.resultCode;
    throw new CloudError(
      `xBloom account login was rejected${code != null ? ` (resultCode=${code})` : ""}`,
    );
  }
  const token = payload.token;
  const member = payload.member as Record<string, unknown> | undefined;
  if (typeof token !== "string" || !token || !member) {
    throw new CloudError("xBloom account login returned an incomplete session");
  }
  const memberId = Number(member.tableId);
  if (!Number.isFinite(memberId) || memberId <= 0) {
    throw new CloudError("xBloom account login returned an invalid member session");
  }
  const countryId = Number(
    member.countryId ?? member.country_id ?? member.countryID ?? 0,
  );
  return {
    region,
    session: {
      ...appBaseForm({
        clientSecret,
        interfaceVersion: CATALOG_INTERFACE_VERSION,
        token,
        memberId,
        languageType: opts.languageType ?? 0,
      }),
      ...(Number.isFinite(countryId) && countryId > 0
        ? { countryId }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Sync / write
// ---------------------------------------------------------------------------

export type CloudSyncTargetResult = {
  target: string;
  endpoint: string;
  payload: unknown;
};

export async function syncAccountCatalog(opts: {
  email: string;
  password: string;
  region: string;
  include?: readonly AccountTarget[];
  languageType?: number;
  timeoutMs?: number;
}): Promise<{ region: CloudRegion; targets: CloudSyncTargetResult[] }> {
  const { region, session } = await loginEphemeral(opts);
  const include = opts.include ?? DEFAULT_ACCOUNT_TARGETS;
  const results: CloudSyncTargetResult[] = [];
  for (const target of include) {
    const endpoint = ENDPOINTS[target];
    if (!endpoint) throw new CloudError(`unknown catalog sync target: ${target}`);
    const form: Record<string, unknown> = {
      ...session,
      adaptedModel: 1,
    };
    const payload = await cloudRequest(
      BASE_URLS[region],
      endpoint,
      form,
      opts.timeoutMs,
    );
    results.push({ target, endpoint, payload });
  }
  return { region, targets: results };
}

// ---------------------------------------------------------------------------
// Account brew history (tuBrewRecordList)
// ---------------------------------------------------------------------------

export type CloudBrewRecordRaw = {
  remote_table_id: number | null;
  recipe_name: string | null;
  serving_kind: "tea" | "xpod" | "coffee";
  dose_g: number | null;
  brew_time_s: number | null;
  create_time_stamp: number | null;
  recorded_at: string | null;
  has_line_chart: boolean;
  line_chart_raw: string | null;
  group_name: string | null;
  is_pod: boolean | null;
  machine_id: number | null;
  device_id: string | null;
  mac: string | null;
};

function firstField(
  raw: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") return raw[k];
  }
  return undefined;
}

function asOptNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Secret-free normalisation matching packages/core/_normalise_brew_record. */
export function normaliseBrewRecord(
  raw: Record<string, unknown>,
  groupName?: string | null,
): CloudBrewRecordRaw {
  const tableId = asOptNumber(firstField(raw, "tableId", "table_id"));
  const createTs = asOptNumber(
    firstField(raw, "createTimeStamp", "create_time_stamp"),
  );
  let recordedAt: string | null = null;
  if (createTs != null && createTs > 0) {
    const ms = createTs > 10_000_000_000 ? createTs : createTs * 1000;
    recordedAt = new Date(ms).toISOString();
  }
  const cupType = asOptNumber(firstField(raw, "cupType", "cup_type"));
  const isPod = asOptNumber(firstField(raw, "isHavePod", "is_have_pod"));
  let recipeName = String(
    firstField(raw, "recipeName", "recipe_name", "theName", "name") ?? "",
  ).trim();
  const recipeVo = raw.recipeVo;
  if (!recipeName && recipeVo && typeof recipeVo === "object") {
    const vo = recipeVo as Record<string, unknown>;
    recipeName = String(firstField(vo, "theName", "name") ?? "").trim();
  }
  let servingKind: CloudBrewRecordRaw["serving_kind"] = "coffee";
  if (cupType === 4) servingKind = "tea";
  else if (isPod === 1) servingKind = "xpod";

  const lineChart = firstField(raw, "lineChartData", "line_chart_data");
  const lineRaw =
    lineChart == null
      ? null
      : typeof lineChart === "string"
        ? lineChart
        : JSON.stringify(lineChart);

  return {
    remote_table_id: tableId,
    recipe_name: recipeName || null,
    serving_kind: servingKind,
    dose_g: asOptNumber(firstField(raw, "dose", "dose_g")),
    brew_time_s: asOptNumber(firstField(raw, "brewTime", "brew_time")),
    create_time_stamp: createTs,
    recorded_at: recordedAt,
    has_line_chart: Boolean(lineRaw && String(lineRaw).trim()),
    line_chart_raw: lineRaw,
    group_name:
      groupName ||
      (firstField(raw, "groupName", "group_name") != null
        ? String(firstField(raw, "groupName", "group_name"))
        : null),
    is_pod: isPod === 1 ? true : isPod === 0 ? false : null,
    machine_id: asOptNumber(firstField(raw, "machineId", "machine_id")),
    device_id:
      firstField(raw, "device_id", "deviceId") != null
        ? String(firstField(raw, "device_id", "deviceId"))
        : null,
    mac:
      firstField(raw, "mac") != null ? String(firstField(raw, "mac")) : null,
  };
}

export function parseBrewRecordPayload(payload: unknown): CloudBrewRecordRaw[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  let groups = root.gList;
  if (groups == null) groups = root.list ?? root.data ?? [];
  if (!Array.isArray(groups)) return [];
  const records: CloudBrewRecordRaw[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const g = group as Record<string, unknown>;
    const groupName =
      g.groupName != null
        ? String(g.groupName)
        : g.group_name != null
          ? String(g.group_name)
          : null;
    const items = Array.isArray(g.list) ? g.list : [g];
    for (const item of items) {
      if (item && typeof item === "object") {
        records.push(
          normaliseBrewRecord(item as Record<string, unknown>, groupName),
        );
      }
    }
  }
  return records;
}

/** Login ephemerally and fetch own-account brew history. */
export async function fetchCloudBrewRecords(opts: {
  email: string;
  password: string;
  region: string;
  languageType?: number;
  timeoutMs?: number;
  keyword?: string;
}): Promise<{
  region: CloudRegion;
  count: number;
  records: CloudBrewRecordRaw[];
  endpoint: string;
}> {
  const { region, session } = await loginEphemeral(opts);
  const form: Record<string, unknown> = {
    ...session,
    adaptedModel: 1,
    pageNumber: 1,
    countPerPage: 0,
  };
  if (opts.keyword) form.keyword = opts.keyword;
  const payload = (await cloudRequest(
    BASE_URLS[region],
    BREW_RECORD_LIST_ENDPOINT,
    form,
    opts.timeoutMs,
  )) as Record<string, unknown>;
  if (payload?.result !== "success") {
    const code = payload?.resultCode;
    throw new CloudError(
      `xBloom brew-record list was rejected${code != null ? ` (resultCode=${code})` : ""}`,
    );
  }
  const records = parseBrewRecordPayload(payload);
  return {
    region,
    count: records.length,
    records,
    endpoint: BREW_RECORD_LIST_ENDPOINT,
  };
}

const APP_PATTERN_VALUES: Record<string, number> = {
  center: 1,
  spiral: 2,
  circular: 3,
  ring: 3,
};

function appPourRecord(
  index: number,
  pour: {
    ml: number;
    temp_c: number | string;
    pattern?: string;
    pause_s?: number;
    flow_ml_s?: number;
    vibration?: string;
    label?: string;
  },
): Record<string, unknown> {
  const patternName = String(pour.pattern || "center").toLowerCase();
  const pattern = APP_PATTERN_VALUES[patternName] ?? 1;
  const vib = String(pour.vibration || "none").toLowerCase();
  const temp =
    typeof pour.temp_c === "number"
      ? pour.temp_c
      : Number(pour.temp_c) || 92;
  return {
    flowRate: Number(pour.flow_ml_s ?? 3.0),
    isEnableVibrationAfter: vib === "after" || vib === "both" ? 1 : 2,
    isEnableVibrationBefore: vib === "before" || vib === "both" ? 1 : 2,
    pattern,
    pausing: Math.trunc(Number(pour.pause_s ?? 5)),
    recipeId: 0,
    temperature: temp,
    theName: pour.label || (index === 1 ? "Bloom" : `Pour ${index - 1}`),
    volume: Number(pour.ml),
  };
}

export function buildCloudCoffeeForm(
  recipe: CoffeeRecipeContent,
): Record<string, unknown> {
  const name = String(recipe.name || "").trim();
  if (!name) throw new CloudError("cloud recipe name must not be empty");
  const dripper = String(recipe.dripper || "Omni").toLowerCase();
  if (!dripper.includes("omni") && !dripper.includes("xdripper")) {
    throw new CloudError(
      "only Omni/xDripper loose-bean recipes can be added to the account",
    );
  }
  const pours = recipe.pours || [];
  if (!pours.length) throw new CloudError("recipe has no pours");
  const rpmValues = new Set(
    pours.map((p) => Math.trunc(Number(p.rpm) || 0)).filter((r) => r > 0),
  );
  if (rpmValues.size > 1) {
    throw new CloudError(
      `account schema has one global RPM; local pours use ${[...rpmValues].sort().join(",")}`,
    );
  }
  const rpm = rpmValues.values().next().value ?? 120;
  const appPours = pours.map((p, i) =>
    appPourRecord(i + 1, {
      ...p,
      label: i === 0 ? "Bloom" : `Pour ${i}`,
    }),
  );
  const noGrind = Number(recipe.grind) <= 0;
  const bypassMl = Number((recipe as { bypass_ml?: number }).bypass_ml || 0);
  const form: Record<string, unknown> = {
    adaptedModel: 1,
    cupType: 2,
    dose: Number(recipe.dose_g),
    grandWater: Number(recipe.ratio || recipe.water_ml / recipe.dose_g || 16),
    isEnableBypassWater: bypassMl > 0 ? 1 : 2,
    isSetGrinderSize: noGrind ? 2 : 1,
    pourDataJSONStr: JSON.stringify(appPours),
    rpm,
    theColor: DEFAULT_RECIPE_COLOR,
    theName: name,
  };
  if (!noGrind) form.grinderSize = Number(recipe.grind);
  if (bypassMl > 0) {
    form.bypassVolume = bypassMl;
    form.bypassTemp = Number(
      (recipe as { bypass_temp_c?: number }).bypass_temp_c || 85,
    );
  }
  return form;
}

export function buildCloudRecipeForm(
  content: RecipeContent,
  memberId?: number,
): Record<string, unknown> {
  if (isTeaContent(content)) {
    const name = String(content.name || "").trim();
    if (!name) throw new CloudError("cloud recipe name must not be empty");
    const pours = (content.pours || []).map((p, i) =>
      appPourRecord(i + 1, {
        ml: Number(p.ml),
        temp_c: p.temp_c as number,
        pattern: p.pattern,
        pause_s: p.pause_s,
        flow_ml_s: p.flow_ml_s,
        label: p.label,
      }),
    );
    const form: Record<string, unknown> = {
      adaptedModel: 1,
      bypassTemp: 85.0,
      bypassVolume: 5.0,
      cupType: 4,
      dose: Number(content.leaf_g),
      grandWater:
        pours.reduce((s, p) => s + Number(p.volume), 0) / Number(content.leaf_g),
      grinderSize: 50.0,
      isEnableBypassWater: 2,
      isSetGrinderSize: 2,
      pourDataJSONStr: JSON.stringify(pours),
      rpm: 120,
      theColor: DEFAULT_RECIPE_COLOR,
      theName: name,
    };
    if (memberId != null) form.creatorId = memberId;
    return form;
  }
  if (!isCoffeeContent(content)) {
    throw new CloudError("unsupported recipe kind for cloud upload");
  }
  return buildCloudCoffeeForm(content);
}

export async function pushCloudRecipe(opts: {
  email: string;
  password: string;
  region: string;
  content: RecipeContent;
  confirmWrite?: string;
  languageType?: number;
  timeoutMs?: number;
}): Promise<{
  status: "created" | "already-present";
  remote_table_id?: number | null;
  name: string;
  write_performed: boolean;
}> {
  if ((opts.confirmWrite ?? CLOUD_WRITE_CONFIRM) !== CLOUD_WRITE_CONFIRM) {
    throw new CloudError(
      `cloud recipe write requires confirmation ${CLOUD_WRITE_CONFIRM}`,
    );
  }
  const { region, session } = await loginEphemeral(opts);
  const name = String(
    (opts.content as { name?: string }).name || "",
  ).trim();
  const requestedName = name.toLowerCase();
  const requestedForm = buildCloudRecipeForm(opts.content, session.memberId);

  // Check created list for same-name conflict.
  const createdForm = { ...session, adaptedModel: 1 };
  const createdPayload = await cloudRequest(
    BASE_URLS[region],
    ENDPOINTS.created,
    createdForm,
    opts.timeoutMs,
  );
  for (const raw of collectRecipeRecords(createdPayload)) {
    const rawName = String(raw.theName ?? raw.name ?? "").trim();
    if (rawName.toLowerCase() !== requestedName) continue;
    const tableId = Number(raw.tableId ?? raw.table_id ?? raw.recipeId);
    // Same name exists — treat as already-present (caller may delete+recreate for update).
    return {
      status: "already-present",
      remote_table_id: Number.isFinite(tableId) ? tableId : null,
      name,
      write_performed: false,
    };
  }

  const writeForm: Record<string, unknown> = {
    ...session,
    interfaceVersion: RECIPE_WRITE_INTERFACE_VERSION,
    ...requestedForm,
  };
  const payload = (await cloudRequest(
    BASE_URLS[region],
    RECIPE_ADD_ENDPOINT,
    writeForm,
    opts.timeoutMs,
  )) as Record<string, unknown>;
  if (payload?.result !== "success") {
    const code = payload?.resultCode;
    throw new CloudError(
      `xBloom cloud recipe add was rejected${code != null ? ` (resultCode=${code})` : ""}`,
    );
  }
  const tableId = Number(payload.tableId);
  if (!Number.isFinite(tableId) || tableId <= 0) {
    throw new CloudError("xBloom cloud recipe add returned no remote recipe id");
  }
  return {
    status: "created",
    remote_table_id: tableId,
    name,
    write_performed: true,
  };
}

export async function deleteCloudRecipe(opts: {
  email: string;
  password: string;
  region: string;
  tableId: number;
  confirmDelete?: string;
  expectedName?: string;
  languageType?: number;
  timeoutMs?: number;
}): Promise<{
  status: "deleted";
  remote_table_id: number;
  name?: string;
  write_performed: boolean;
}> {
  if ((opts.confirmDelete ?? CLOUD_DELETE_CONFIRM) !== CLOUD_DELETE_CONFIRM) {
    throw new CloudError(
      `cloud recipe delete requires confirmation ${CLOUD_DELETE_CONFIRM}`,
    );
  }
  const remoteTableId = Math.trunc(opts.tableId);
  if (remoteTableId <= 0) throw new CloudError("remote table id must be positive");
  const { region, session } = await loginEphemeral(opts);

  const createdForm = { ...session, adaptedModel: 1 };
  const createdPayload = await cloudRequest(
    BASE_URLS[region],
    ENDPOINTS.created,
    createdForm,
    opts.timeoutMs,
  );
  let matchedName: string | undefined;
  let found = false;
  for (const raw of collectRecipeRecords(createdPayload)) {
    const candidateId = Number(raw.tableId ?? raw.table_id ?? raw.recipeId);
    if (candidateId !== remoteTableId) continue;
    found = true;
    matchedName = String(raw.theName ?? raw.name ?? "");
    break;
  }
  if (!found) {
    throw new CloudError(
      "This recipe is not on your account anymore (already deleted or never uploaded).",
      "not_on_account",
    );
  }
  if (
    opts.expectedName &&
    matchedName?.trim().toLowerCase() !== opts.expectedName.trim().toLowerCase()
  ) {
    throw new CloudError(
      `remote recipe name ${JSON.stringify(matchedName)} does not match expected ${JSON.stringify(opts.expectedName)}`,
    );
  }

  const deleteForm: Record<string, unknown> = {
    ...session,
    interfaceVersion: RECIPE_WRITE_INTERFACE_VERSION,
    tableId: remoteTableId,
  };
  const payload = (await cloudRequest(
    BASE_URLS[region],
    RECIPE_DELETE_ENDPOINT,
    deleteForm,
    opts.timeoutMs,
  )) as Record<string, unknown>;
  if (payload?.result !== "success") {
    const code = payload?.resultCode;
    throw new CloudError(
      `xBloom cloud recipe delete was rejected${code != null ? ` (resultCode=${code})` : ""}`,
    );
  }
  return {
    status: "deleted",
    remote_table_id: remoteTableId,
    name: matchedName,
    write_performed: true,
  };
}

/**
 * Update = delete remote then create (user-specified strategy).
 * Requires tableId of the existing own-account recipe.
 */
export async function updateCloudRecipe(opts: {
  email: string;
  password: string;
  region: string;
  tableId: number;
  content: RecipeContent;
  expectedName?: string;
  languageType?: number;
  timeoutMs?: number;
}): Promise<{
  status: "updated";
  deleted_table_id: number;
  remote_table_id: number | null;
  name: string;
  write_performed: boolean;
}> {
  const del = await deleteCloudRecipe({
    email: opts.email,
    password: opts.password,
    region: opts.region,
    tableId: opts.tableId,
    expectedName: opts.expectedName,
    languageType: opts.languageType,
    timeoutMs: opts.timeoutMs,
  });
  const add = await pushCloudRecipe({
    email: opts.email,
    password: opts.password,
    region: opts.region,
    content: opts.content,
    languageType: opts.languageType,
    timeoutMs: opts.timeoutMs,
  });
  return {
    status: "updated",
    deleted_table_id: del.remote_table_id,
    remote_table_id: add.remote_table_id ?? null,
    name: add.name,
    write_performed: add.write_performed,
  };
}

// ---------------------------------------------------------------------------
// Record extraction (lightweight)
// ---------------------------------------------------------------------------

const KNOWN_CONTAINERS = new Set([
  "list",
  "recipes",
  "recipeList",
  "easyModeDetailVoList",
  "DiskRecipeList",
  "DiskEasyModeDeviceList",
  "data",
  "payload",
  "response",
  "result",
  "value",
]);

export function collectRecipeRecords(
  payload: unknown,
  depth = 0,
): Record<string, unknown>[] {
  if (depth > 8 || payload == null) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => collectRecipeRecords(item, depth + 1));
  }
  if (typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  // A recipe-like object has a name and pour payload or dose.
  const hasName =
    typeof obj.theName === "string" || typeof obj.name === "string";
  const hasPours =
    obj.pourDataJSONStr != null ||
    obj.pourList != null ||
    Array.isArray(obj.pours);
  const hasDose = obj.dose != null || obj.dose_g != null;
  if (hasName && (hasPours || hasDose)) {
    return [obj];
  }
  const out: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (KNOWN_CONTAINERS.has(key) || Array.isArray(value) || (value && typeof value === "object")) {
      out.push(...collectRecipeRecords(value, depth + 1));
    }
    // Sometimes pour data is double-encoded JSON string of list of recipes.
    if (typeof value === "string" && value.startsWith("[") && value.length < 2_000_000) {
      try {
        out.push(...collectRecipeRecords(JSON.parse(value), depth + 1));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Share links (App H5 + account share list)
// ---------------------------------------------------------------------------

/** Public share page hosts (from share-h5 SPA + support docs). */
export const SHARE_H5_BASES = {
  international: "https://share-h5.xbloom.com/",
  china: "https://share-h5.xbloomcoffee.cn/",
} as const;

/** H5 detail API (decoded from share-h5 bundle: POST /RecipeDetail.html). */
export const RECIPE_DETAIL_ENDPOINT = "RecipeDetail.html";

/**
 * Endpoints that exist on the tenant and require login (probed 2026-07).
 * First success that returns a share URL wins.
 */
export const SHARE_CREATE_ENDPOINTS = [
  "tuRecipeShare.tuhtml",
  "tuShareRecipe.tuhtml",
  "tuRecipeShareLink.tuhtml",
  "tuRecipeShareAdd.tuhtml",
  "tuMyRecipeShare.tuhtml",
  "tuShareAdd.tuhtml",
  "tuCreateShare.tuhtml",
] as const;

export function parseShareLinkId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    if (raw.includes("://") || raw.startsWith("//")) {
      const u = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
      const id = u.searchParams.get("id");
      if (id) return decodeURIComponent(id);
    }
  } catch {
    /* fall through */
  }
  // Bare id (often already URL-encoded base64)
  if (/^[A-Za-z0-9_+\-/%=]+$/.test(raw) && raw.length >= 8) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function regionForShareUrl(url: string): CloudRegion {
  const s = url.toLowerCase();
  if (s.includes("xbloomcoffee.cn") || s.includes("-cn")) return "china";
  return "international";
}

export type ShareRecipeDetail = {
  raw: Record<string, unknown>;
  recipeVo: Record<string, unknown>;
  share_link: string | null;
  share_author: string | null;
  table_id: number | null;
  region: CloudRegion;
};

/**
 * Resolve an App share URL / id via public RecipeDetail.html (no login).
 * CORS allows browser origins (Access-Control-Allow-Origin: *).
 */
export async function fetchShareRecipeDetail(
  shareUrlOrId: string,
  opts?: { region?: CloudRegion; timeoutMs?: number },
): Promise<ShareRecipeDetail> {
  const id = parseShareLinkId(shareUrlOrId);
  if (!id) {
    throw new CloudError("Could not parse share link id (need ?id=… or bare token).");
  }
  const preferred =
    opts?.region ??
    (shareUrlOrId.includes("://")
      ? regionForShareUrl(shareUrlOrId)
      : "international");
  const regions: CloudRegion[] =
    preferred === "china"
      ? ["china", "international"]
      : ["international", "china"];

  let lastErr: unknown;
  for (const region of regions) {
    try {
      const detail = await postRecipeDetail(region, id, opts?.timeoutMs);
      if (detail) return detail;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof CloudError
    ? lastErr
    : new CloudError(
        `Share lookup failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
}

async function postRecipeDetail(
  region: CloudRegion,
  tableIdOfRSA: string,
  timeoutMs = 20_000,
): Promise<ShareRecipeDetail | null> {
  const base = BASE_URLS[region];
  const body = JSON.stringify({
    tableIdOfRSA,
    interfaceVersion: CATALOG_INTERFACE_VERSION,
    skey: APP_SKEY,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + RECIPE_DETAIL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "xbloom-studio-web-share/1",
      },
      body,
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
    });
    const text = await res.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new CloudError(`RecipeDetail returned non-JSON (${res.status})`);
    }
    if (payload.result !== "success" && payload.info) {
      throw new CloudError(String(payload.info));
    }
    const recipeVo = payload.recipeVo;
    if (!recipeVo || typeof recipeVo !== "object") {
      return null;
    }
    const vo = recipeVo as Record<string, unknown>;
    // Some tenants return empty pourList; refuse empty programs.
    const pours = vo.pourList ?? vo.pourDataJSONStr ?? vo.pours;
    const pourLen = Array.isArray(pours)
      ? pours.length
      : typeof pours === "string" && pours.startsWith("[")
        ? 1
        : 0;
    if (pourLen === 0 && Number(vo.pourCount || 0) === 0) {
      return null;
    }
    const link =
      typeof vo.shareRecipeLink === "string"
        ? vo.shareRecipeLink
        : typeof payload.shareRecipeLink === "string"
          ? payload.shareRecipeLink
          : `${SHARE_H5_BASES[region]}?id=${encodeURIComponent(tableIdOfRSA)}`;
    const author =
      (typeof payload.shareMemberName === "string" && payload.shareMemberName) ||
      (typeof vo.resourceMemberName === "string" && vo.resourceMemberName) ||
      null;
    const tableId = Number(vo.tableId ?? vo.table_id);
    return {
      raw: payload,
      recipeVo: vo,
      share_link: link,
      share_author: author,
      table_id: Number.isFinite(tableId) ? tableId : null,
      region,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the cloud for a shareable H5 link for an owned recipe tableId.
 * Tries several login-gated endpoints (decoded by probing; field names may vary).
 */
export async function createCloudShareLink(opts: {
  email: string;
  password: string;
  region: string;
  tableId: number;
  /** Existing share URL from a prior sync, if any. */
  existingShareLink?: string | null;
  languageType?: number;
  timeoutMs?: number;
}): Promise<{
  share_link: string;
  source: "existing" | "created" | "refreshed";
  endpoint?: string;
}> {
  if (
    opts.existingShareLink &&
    opts.existingShareLink.startsWith("http") &&
    opts.existingShareLink.includes("id=")
  ) {
    return { share_link: opts.existingShareLink, source: "existing" };
  }

  const { region, session } = await loginEphemeral(opts);
  const tableId = Math.trunc(opts.tableId);
  if (!Number.isFinite(tableId) || tableId <= 0) {
    throw new CloudError("create share requires a valid cloud tableId");
  }

  // Prefer re-reading owned lists — many records already carry shareRecipeLink.
  for (const target of ["created", "shared", "product"] as const) {
    try {
      const payload = await cloudRequest(
        BASE_URLS[region],
        ENDPOINTS[target],
        { ...session, adaptedModel: 1 },
        opts.timeoutMs,
      );
      for (const raw of collectRecipeRecords(payload)) {
        const id = Number(raw.tableId ?? raw.table_id ?? raw.recipeId);
        if (id !== tableId) continue;
        const link = raw.shareRecipeLink ?? raw.share_link;
        if (typeof link === "string" && link.startsWith("http")) {
          return { share_link: link, source: "refreshed", endpoint: target };
        }
      }
    } catch {
      /* continue */
    }
  }

  const attempts: Array<Record<string, unknown>> = [
    { ...session, tableId, adaptedModel: 1 },
    { ...session, tableId, interfaceVersion: RECIPE_WRITE_INTERFACE_VERSION },
    {
      ...session,
      tableId,
      adaptedModel: 1,
      interfaceVersion: RECIPE_WRITE_INTERFACE_VERSION,
    },
    { ...session, recipeId: tableId, adaptedModel: 1 },
    { ...session, tableId, shareType: 1, adaptedModel: 1 },
  ];

  let lastInfo = "";
  for (const endpoint of SHARE_CREATE_ENDPOINTS) {
    for (const form of attempts) {
      try {
        const payload = (await cloudRequest(
          BASE_URLS[region],
          endpoint,
          form,
          opts.timeoutMs,
        )) as Record<string, unknown>;
        const link = extractShareLink(payload);
        if (link) {
          return { share_link: link, source: "created", endpoint };
        }
        if (payload?.info) lastInfo = String(payload.info);
        if (payload?.result === "success") {
          // Success without link — re-list created for shareRecipeLink.
          const listed = await cloudRequest(
            BASE_URLS[region],
            ENDPOINTS.created,
            { ...session, adaptedModel: 1 },
            opts.timeoutMs,
          );
          for (const raw of collectRecipeRecords(listed)) {
            const id = Number(raw.tableId ?? raw.table_id ?? raw.recipeId);
            if (id !== tableId) continue;
            const l = raw.shareRecipeLink ?? raw.share_link;
            if (typeof l === "string" && l.startsWith("http")) {
              return {
                share_link: l,
                source: "created",
                endpoint,
              };
            }
          }
        }
      } catch (e) {
        lastInfo = e instanceof Error ? e.message : String(e);
      }
    }
  }

  throw new CloudError(
    lastInfo
      ? `Could not create share link: ${lastInfo}`
      : "Could not create share link (no working App share endpoint returned a URL). Sync the recipe first, or share once from the official App.",
  );
}

function extractShareLink(payload: Record<string, unknown>): string | null {
  const direct = [
    payload.shareRecipeLink,
    payload.share_link,
    payload.shareLink,
    payload.link,
    payload.url,
  ];
  for (const v of direct) {
    if (typeof v === "string" && v.startsWith("http")) return v;
  }
  // Nested data / result objects
  for (const key of ["data", "payload", "result", "recipeVo", "value"]) {
    const nested = payload[key];
    if (nested && typeof nested === "object") {
      const link = extractShareLink(nested as Record<string, unknown>);
      if (link) return link;
    }
  }
  return null;
}

