/**
 * xBloom account cloud client (browser).
 *
 * Mirrors packages/core/xbloom_catalog.py:
 * - PKCS#1 v1.5 RSA chunked form encrypt (public app key)
 * - Ephemeral login → sync / add / delete
 * - Update = delete then create (user requirement)
 *
 * Credentials are never written to localStorage by this module.
 * Password stays in call-site memory only.
 *
 * Note: official APIs may block browser CORS from GitHub Pages; errors surface
 * as network failures. Desktop/native Python path is unaffected.
 */

import type { CoffeeRecipeContent, RecipeContent } from "../api.ts";
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
  constructor(message: string) {
    super(message);
    this.name = "CloudError";
  }
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
}): Promise<{ region: CloudRegion; session: SessionForm }> {
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
  return {
    region,
    session: appBaseForm({
      clientSecret,
      interfaceVersion: CATALOG_INTERFACE_VERSION,
      token,
      memberId,
      languageType: opts.languageType ?? 0,
    }),
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
      `no created-account recipe with tableId=${remoteTableId}; refusing delete`,
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

