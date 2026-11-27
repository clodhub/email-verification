import { parseCookies, serialiseCookie } from "./cookies.ts";
import { rawSettings } from "./settings.ts";

export const EMAIL_CODES_COLLECTION = "emailCodes";

export type EmailVerificationSettings = { codeLength: number; expiryMinutes: number; cookieName: string; tokenMinutes: number; tokenSecretVariable: string };

// The parts of the records store and of the voucher codes that verification uses.
type CodeDocument = { _id: string; email: string; code: string; createdAt: Date; expiresAt: Date; failures: number };
type CodeCollection = {
  updateOne(filter: Record<string, unknown>, update: { $set?: Record<string, unknown>; $inc?: Record<string, number> }, options?: { upsert?: boolean }): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  createIndexes(indexes: Array<{ key: Record<string, 1 | -1>; unique?: boolean; expireAfterSeconds?: number }>): Promise<void>;
};
export type RecordsLike = { collection(name: string): unknown };
export type ShortCodes = { generateShort(length: number): string };

export type EmailVerificationDeps = {
  records: RecordsLike;
  codes: ShortCodes;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  settings?: Partial<EmailVerificationSettings>;
};
export type StartResult = { ok: true; email: string; code: string; expiresAt: Date } | { ok: false; code: "INVALID_EMAIL" | "NOT_CONFIGURED" };
export type ConfirmResult = { ok: true; email: string; token: string; expiresAt: Date; setCookie: string } | { ok: false; code: "INVALID_CODE" | "NOT_CONFIGURED" };

export type EmailVerification = {
  readonly settings: EmailVerificationSettings;
  ensureIndexes(): Promise<void>;
  start(email: unknown): Promise<StartResult>;
  confirm(email: unknown, code: unknown, options?: { secure?: boolean }): Promise<ConfirmResult>;
  verify(token: unknown): Promise<string | null>;
  verifiedEmail(cookieHeader: string | null | undefined): Promise<string | null>;
  configured(): boolean;
};

export const DEFAULT_SETTINGS: EmailVerificationSettings = Object.freeze({
  codeLength: 6, expiryMinutes: 15, cookieName: "shop_email_verified", tokenMinutes: 30, tokenSecretVariable: "EMAIL_TOKEN_SECRET",
});

// Wrong codes an address's code survives; with 6 characters (30 bits) this keeps guessing hopeless.
export const MAXIMUM_FAILURES = 5;
export const MINIMUM_SECRET_LENGTH = 32;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENVIRONMENT = /^[A-Z][A-Z0-9_]{0,63}$/;
// <base64url of the address>.<expiry in Unix seconds>.<HMAC-SHA-256 of the address and expiry, base64url without padding>
const TOKEN = /^([A-Za-z0-9_-]{4,400})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/;
const HMAC = { name: "HMAC", hash: "SHA-256" } as const;
const encoder = new TextEncoder();

// A value still in its {{name}} form (the source, before installation renders it) takes the default.
const unrendered = (value: unknown) => typeof value === "string" && /^\{\{[A-Za-z][A-Za-z0-9_.-]*\}\}$/.test(value);
const given = (value: unknown, fallback: unknown) => (value === undefined || unrendered(value) ? fallback : value);

function whole(value: unknown, name: string, low: number, high: number): number {
  const number = typeof value === "string" && /^[0-9]{1,10}$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < low || number > high) {
    throw new RangeError(`${name} is a whole number from ${low} to ${high}`);
  }
  return number;
}

export function settingsFrom(raw: { [K in keyof EmailVerificationSettings]?: unknown } = {}): EmailVerificationSettings {
  const cookieName = given(raw.cookieName, DEFAULT_SETTINGS.cookieName);
  if (typeof cookieName !== "string" || !IDENTIFIER.test(cookieName)) throw new RangeError("cookieName is an identifier: a letter, then letters, digits and _");
  const tokenSecretVariable = given(raw.tokenSecretVariable, DEFAULT_SETTINGS.tokenSecretVariable);
  if (typeof tokenSecretVariable !== "string" || !ENVIRONMENT.test(tokenSecretVariable)) {
    throw new RangeError("tokenSecretVariable is an environment variable name such as EMAIL_TOKEN_SECRET");
  }
  return {
    codeLength: whole(given(raw.codeLength, DEFAULT_SETTINGS.codeLength), "codeLength", 4, 12),
    expiryMinutes: whole(given(raw.expiryMinutes, DEFAULT_SETTINGS.expiryMinutes), "expiryMinutes", 1, 1440),
    cookieName,
    tokenMinutes: whole(given(raw.tokenMinutes, DEFAULT_SETTINGS.tokenMinutes), "tokenMinutes", 5, 1440),
    tokenSecretVariable,
  };
}

export const installedSettings = (): EmailVerificationSettings => settingsFrom(rawSettings);

export function normaliseEmail(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const email = text.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) ? email : null;
}

export function verificationPath(path: string, email: string, code: string): string {
  const hash = path.indexOf("#");
  const base = hash < 0 ? path : path.slice(0, hash);
  const fragment = hash < 0 ? "" : path.slice(hash);
  const separator = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
  return `${base}${separator}verify=${encodeURIComponent(code)}&email=${encodeURIComponent(email)}${fragment}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

// Byte strings of one length compared without an early exit, so the time taken does not depend on where they differ.
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

const isDuplicateKey = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "duplicate-key";

export function createEmailVerification(deps: EmailVerificationDeps): EmailVerification {
  if (typeof deps?.records?.collection !== "function") throw new TypeError("createEmailVerification needs records: a records store");
  if (typeof deps.codes?.generateShort !== "function") throw new TypeError("createEmailVerification needs codes: the voucher-codes component's VoucherCodes");
  const replaced = Object.fromEntries(Object.entries(deps.settings ?? {}).filter(([, value]) => value !== undefined));
  const settings = Object.freeze(settingsFrom({ ...installedSettings(), ...replaced }));
  const now = deps.now ?? (() => new Date());
  const { codes } = deps;
  const collection = deps.records.collection(EMAIL_CODES_COLLECTION) as CodeCollection;
  const found = (deps.env ?? process.env)[settings.tokenSecretVariable];
  const secret = typeof found === "string" && found.trim() !== "" ? found.trim() : null;
  if (secret !== null && secret.length < MINIMUM_SECRET_LENGTH) {
    throw new RangeError(`${settings.tokenSecretVariable} holds a secret of ${secret.length} characters; it needs at least ${MINIMUM_SECRET_LENGTH}`);
  }
  let key: Promise<CryptoKey> | null = null;
  const signature = async (email: string, expires: number) => {
    key ??= crypto.subtle.importKey("raw", encoder.encode(secret ?? ""), HMAC, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", await key, encoder.encode(`clodhub email-verification token\n${email}\n${expires}`)));
  };
  const lifetime = settings.tokenMinutes * 60;

  let indexed: Promise<void> | null = null;
  function ensureIndexes(): Promise<void> {
    indexed ??= collection.createIndexes([{ key: { email: 1 }, unique: true }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }])
      .catch((error: unknown) => {
        indexed = null;
        throw error;
      });
    return indexed;
  }

  // The address a token names, or null when it is forged, expired, or signed with another secret.
  async function verify(token: unknown): Promise<string | null> {
    if (secret === null || typeof token !== "string") return null;
    const match = TOKEN.exec(token);
    if (!match) return null;
    const bytes = fromBase64url(match[1]);
    const mac = fromBase64url(match[3]);
    if (bytes === null || mac === null) return null;
    let email: string;
    try {
      email = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    const expires = Number(match[2]);
    const left = expires - Math.floor(now().getTime() / 1000);
    const signed = sameBytes(await signature(email, expires), mac);
    return signed && left > 0 && left <= lifetime && normaliseEmail(email) === email ? email : null;
  }

  return {
    settings,
    ensureIndexes,

    async start(input) {
      const email = normaliseEmail(input);
      if (email === null) return { ok: false, code: "INVALID_EMAIL" };
      // Without the secret no confirmation could give a token, so no code is sent.
      if (secret === null) return { ok: false, code: "NOT_CONFIGURED" };
      await ensureIndexes();
      const code = codes.generateShort(settings.codeLength);
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + settings.expiryMinutes * 60 * 1000);
      const replace = () => collection.updateOne({ email }, { $set: { code, createdAt, expiresAt, failures: 0 } }, { upsert: true });
      try {
        await replace();
      } catch (error) {
        // Two starts for one address at once: the other inserted first, so this one replaces its code.
        if (!isDuplicateKey(error)) throw error;
        await replace();
      }
      return { ok: true, email, code, expiresAt };
    },

    async confirm(input, typed, options = {}) {
      const email = normaliseEmail(input);
      const code = typeof typed === "string" ? typed.trim().toUpperCase() : "";
      if (email === null || code === "") return { ok: false, code: "INVALID_CODE" };
      if (secret === null) return { ok: false, code: "NOT_CONFIGURED" };
      // The store removes expired codes up to a minute late, so the expiry is part of the match.
      const live = { email, expiresAt: { $gt: now() }, failures: { $lt: MAXIMUM_FAILURES } };
      const { deletedCount } = await collection.deleteOne({ ...live, code });
      if (deletedCount !== 1) {
        await collection.updateOne(live, { $inc: { failures: 1 } });
        return { ok: false, code: "INVALID_CODE" };
      }
      const expires = Math.floor(now().getTime() / 1000) + lifetime;
      const token = `${base64url(encoder.encode(email))}.${expires}.${base64url(await signature(email, expires))}`;
      const setCookie = serialiseCookie(settings.cookieName, token, { maxAge: lifetime, secure: options.secure === true, httpOnly: true, sameSite: "Lax", path: "/" });
      return { ok: true, email, token, expiresAt: new Date(expires * 1000), setCookie };
    },

    verify,
    verifiedEmail: (cookieHeader) => verify(parseCookies(cookieHeader)[settings.cookieName]),
    configured: () => secret !== null,
  };
}

export type { CodeDocument };
