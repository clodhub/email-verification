import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  DEFAULT_SETTINGS, EMAIL_CODES_COLLECTION, MAXIMUM_FAILURES, MINIMUM_SECRET_LENGTH, createEmailVerification, installedSettings, normaliseEmail, settingsFrom,
  verificationPath,
} from "../implementation/server/index.ts";
import { parseCookies, serialiseCookie } from "../implementation/server/cookies.ts";
import { createStore } from "./fixtures/records.ts";
import { importRendered, placeholders } from "./render.ts";
import { verificationRoutes } from "../examples/consumer.ts";

const template = new URL("../implementation/server/settings.ts", import.meta.url);
const MINUTE = 60 * 1000;
const START = Date.parse("2026-05-04T09:00:00.000Z");
const env = { EMAIL_TOKEN_SECRET: "e".repeat(20) + "-token-secret-for-tests" };
const SECRET = env.EMAIL_TOKEN_SECRET;
// The token a verification gives for an address and expiry, computed with node:crypto apart from the component's WebCrypto code.
const tokenFor = (email: string, expires: number, secret = SECRET) =>
  `${Buffer.from(email).toString("base64url")}.${expires}.${createHmac("sha256", secret).update(`clodhub email-verification token\n${email}\n${expires}`).digest("base64url")}`;

// A double of the voucher codes' generateShort: the next code in a list, then letters from a counter.
function codesFrom(list: string[] = []) {
  const queue = [...list];
  let counter = 0;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return {
    lengths: [] as number[],
    generateShort(length: number) {
      this.lengths.push(length);
      return queue.shift() ?? Array.from({ length }, () => alphabet[counter++ % 32]).join("");
    },
  };
}

function studio(options: { list?: string[]; settings?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  let clock = START;
  const now = () => new Date(clock);
  const records = createStore({ now });
  const codes = codesFrom(options.list);
  const verification = createEmailVerification({ records, codes, now, env: options.env ?? env, settings: options.settings as never });
  return { records, codes, verification, now, advance: (ms: number) => { clock += ms; } };
}

test("the settings template names the five plain settings and renders to the defaults", async () => {
  assert.deepEqual(placeholders(template).sort(), ["codeLength", "cookieName", "expiryMinutes", "tokenMinutes", "tokenSecretVariable"]);
  // The defaults declared in authoring/spec.json collect.
  const rendered = await importRendered<{ rawSettings: Record<string, string> }>(template,
    { codeLength: 6, expiryMinutes: 15, cookieName: "shop_email_verified", tokenMinutes: 30, tokenSecretVariable: "EMAIL_TOKEN_SECRET" });
  assert.deepEqual(settingsFrom(rendered.rawSettings), DEFAULT_SETTINGS);
  assert.deepEqual(installedSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(settingsFrom({ codeLength: 8, expiryMinutes: "60", cookieName: "studio_email", tokenMinutes: "45", tokenSecretVariable: "SHOP_SECRET" }),
    { codeLength: 8, expiryMinutes: 60, cookieName: "studio_email", tokenMinutes: 45, tokenSecretVariable: "SHOP_SECRET" });
  assert.throws(() => settingsFrom({ codeLength: 3 }), /codeLength is a whole number from 4 to 12/);
  assert.throws(() => settingsFrom({ expiryMinutes: "1441" }), RangeError);
  assert.throws(() => settingsFrom({ cookieName: "shop-email" }), /identifier/);
  assert.throws(() => settingsFrom({ tokenMinutes: "4" }), RangeError);
  assert.throws(() => settingsFrom({ tokenMinutes: "1441" }), RangeError);
  assert.throws(() => settingsFrom({ tokenSecretVariable: "secret" }), /environment variable/);
});

test("addresses are kept trimmed and in lower case", () => {
  assert.equal(normaliseEmail(" Pablo@Example.com "), "pablo@example.com");
  assert.equal(normaliseEmail("pablo+gifts@studio.example.com"), "pablo+gifts@studio.example.com");
  for (const bad of ["pablo", "pablo@", "pablo@example", "pa blo@example.com", "@example.com", "pablo@exa@mple.com", 42, undefined]) {
    assert.equal(normaliseEmail(bad), null, String(bad));
  }
  assert.equal(normaliseEmail(`${"p".repeat(243)}@example.com`), null);
});

test("the verification link carries the code and the address", () => {
  assert.equal(verificationPath("/es/gift-cards", "pablo@example.com", "X4KM9P"), "/es/gift-cards?verify=X4KM9P&email=pablo%40example.com");
  assert.equal(verificationPath("/en/gift-cards?step=3", "a+b@example.com", "X4KM9P"), "/en/gift-cards?step=3&verify=X4KM9P&email=a%2Bb%40example.com");
  assert.equal(verificationPath("/en/gift-cards?", "a@example.com", "X4KM9P"), "/en/gift-cards?verify=X4KM9P&email=a%40example.com");
  assert.equal(verificationPath("/en/gift-cards#form", "a@example.com", "X4KM9P"), "/en/gift-cards?verify=X4KM9P&email=a%40example.com#form");
});

test("cookies: written with encoded values and read back from a request header", () => {
  assert.equal(serialiseCookie("shop_email_verified", "a.b", { maxAge: 1800 }), "shop_email_verified=a.b; Max-Age=1800; Path=/; SameSite=Lax");
  assert.equal(serialiseCookie("a", "b c", { secure: true, httpOnly: true, sameSite: "Strict", path: "/en" }), "a=b%20c; Path=/en; SameSite=Strict; Secure; HttpOnly");
  assert.deepEqual(parseCookies("a=1; b=x%40y; a=2; broken; =v; c=\"q\"; d=%E0%A4%A"), { a: "1", b: "x@y", c: "q", d: "%E0%A4%A" });
  assert.deepEqual(parseCookies(null), {});
});

test("the service needs a store and the voucher codes, and creates its indexes", async () => {
  assert.throws(() => createEmailVerification({ records: createStore(), codes: {} as never }), TypeError);
  assert.throws(() => createEmailVerification({ records: undefined as never, codes: codesFrom() }), TypeError);
  assert.throws(() => createEmailVerification({ records: createStore(), codes: codesFrom(), settings: { cookieName: "no good" } }), RangeError);
  const { verification, records } = studio();
  await verification.ensureIndexes();
  await verification.ensureIndexes();
  assert.deepEqual(await records.collection(EMAIL_CODES_COLLECTION).listIndexes(), [{ key: { email: 1 }, unique: true }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }]);
});

test("start keeps one code per address in the store, replacing the last", async () => {
  const { verification, records, codes } = studio({ list: ["X4KM9P", "H7QR2T"] });
  assert.deepEqual(await verification.start("nobody"), { ok: false, code: "INVALID_EMAIL" });
  assert.deepEqual(await verification.start(undefined), { ok: false, code: "INVALID_EMAIL" });
  const first = await verification.start(" Pablo@Example.com ");
  assert.deepEqual(first, { ok: true, email: "pablo@example.com", code: "X4KM9P", expiresAt: new Date(START + 15 * MINUTE) });
  const second = await verification.start("pablo@example.com");
  assert.ok(second.ok);
  assert.equal(second.code, "H7QR2T");
  assert.deepEqual(codes.lengths, [6, 6]);
  const kept = await records.collection(EMAIL_CODES_COLLECTION).find({});
  assert.equal(kept.length, 1);
  assert.equal(kept[0].code, "H7QR2T");
  assert.ok(kept[0].createdAt instanceof Date);
  const together = await Promise.all([verification.start("marta@example.com"), verification.start("marta@example.com")]);
  assert.ok(together.every((result) => result.ok));
  assert.equal(await records.collection(EMAIL_CODES_COLLECTION).countDocuments({ email: "marta@example.com" }), 1);
});

test("confirm accepts the current code once, then sets the cookie", async () => {
  const { verification } = studio({ list: ["X4KM9P", "H7QR2T"] });
  await verification.start("pablo@example.com");
  await verification.start("pablo@example.com");
  assert.deepEqual(await verification.confirm("pablo@example.com", "X4KM9P"), { ok: false, code: "INVALID_CODE" });
  assert.deepEqual(await verification.confirm("pablo@example.com", "H7QR2"), { ok: false, code: "INVALID_CODE" });
  assert.deepEqual(await verification.confirm("marta@example.com", "H7QR2T"), { ok: false, code: "INVALID_CODE" });
  assert.deepEqual(await verification.confirm("not an address", "H7QR2T"), { ok: false, code: "INVALID_CODE" });
  assert.deepEqual(await verification.confirm("pablo@example.com", null), { ok: false, code: "INVALID_CODE" });
  const confirmed = await verification.confirm(" PABLO@example.com", " h7qr2t ");
  const expires = Math.floor(START / 1000) + 30 * 60;
  assert.deepEqual(confirmed, {
    ok: true, email: "pablo@example.com", token: tokenFor("pablo@example.com", expires), expiresAt: new Date(expires * 1000),
    setCookie: `shop_email_verified=${tokenFor("pablo@example.com", expires)}; Max-Age=1800; Path=/; SameSite=Lax; HttpOnly`,
  });
  assert.deepEqual(await verification.confirm("pablo@example.com", "H7QR2T"), { ok: false, code: "INVALID_CODE" });
  const secure = studio({ list: ["X4KM9P"] }).verification;
  await secure.start("pablo@example.com");
  const confirmedSecure = await secure.confirm("pablo@example.com", "X4KM9P", { secure: true });
  assert.ok(confirmedSecure.ok);
  assert.ok(confirmedSecure.setCookie.endsWith("; Secure; HttpOnly"));
  assert.equal(await verification.verifiedEmail(confirmed.ok ? confirmed.setCookie.split(";")[0] : null), "pablo@example.com");
});

test("the token names the address for tokenMinutes, and a forged, altered, expired or foreign one names nothing", async () => {
  const { verification, advance } = studio({ list: ["X4KM9P"] });
  await verification.start("pablo@example.com");
  const confirmed = await verification.confirm("pablo@example.com", "X4KM9P");
  assert.ok(confirmed.ok);
  assert.equal(await verification.verify(confirmed.token), "pablo@example.com");
  assert.equal(await verification.verifiedEmail(`consent=yes; shop_email_verified=${encodeURIComponent(confirmed.token)}`), "pablo@example.com");
  const expires = Math.floor(START / 1000) + 30 * 60;
  const [address, , mac] = confirmed.token.split(".");
  // Only a token this server signed and that has not ended passes: not the plain address, and not a token signed without the secret.
  for (const forged of ["pablo@example.com", tokenFor("marta@example.com", expires, "f".repeat(40)), `${Buffer.from("marta@example.com").toString("base64url")}.${expires}.${mac}`,
    `${address}.${expires + 60}.${mac}`, `${address}.${expires}.${mac.slice(0, -1)}A`, `${address}.${expires}`, "", null, 42, `${address}.${expires}.${mac}.x`]) {
    assert.equal(await verification.verify(forged), null, String(forged));
  }
  // A token signed by this secret but longer-lived than tokenMinutes, or for text that is not an address as the shop keeps it.
  assert.equal(await verification.verify(tokenFor("pablo@example.com", expires + 60)), null);
  assert.equal(await verification.verify(tokenFor("Pablo@Example.com", expires)), null);
  assert.equal(await verification.verifiedEmail("shop_email_verified=pablo%40example.com"), null);
  assert.equal(await verification.verifiedEmail(null), null);
  advance(30 * MINUTE - 1000);
  assert.equal(await verification.verify(confirmed.token), "pablo@example.com");
  advance(1000);
  assert.equal(await verification.verify(confirmed.token), null);
  const other = studio({ env: { EMAIL_TOKEN_SECRET: "o".repeat(40) } }).verification;
  assert.equal(await other.verify(confirmed.token), null);
});

test("without the token secret nothing is sent or confirmed, and a short secret is refused when the service is created", async () => {
  const closed = studio({ list: ["X4KM9P"], env: {} });
  assert.equal(closed.verification.configured(), false);
  assert.deepEqual(await closed.verification.start("pablo@example.com"), { ok: false, code: "NOT_CONFIGURED" });
  assert.deepEqual(closed.codes.lengths, []);
  assert.deepEqual(await closed.verification.confirm("pablo@example.com", "X4KM9P"), { ok: false, code: "NOT_CONFIGURED" });
  assert.equal(await closed.verification.verify(tokenFor("pablo@example.com", Math.floor(START / 1000) + 60, "")), null);
  assert.equal(studio().verification.configured(), true);
  assert.equal(MINIMUM_SECRET_LENGTH, 32);
  assert.throws(() => createEmailVerification({ records: createStore(), codes: codesFrom(), env: { EMAIL_TOKEN_SECRET: "s".repeat(31) } }),
    /EMAIL_TOKEN_SECRET holds a secret of 31 characters; it needs at least 32/);
  process.env.EMAIL_TOKEN_SECRET = SECRET;
  try {
    assert.equal(createEmailVerification({ records: createStore(), codes: codesFrom() }).configured(), true);
  } finally {
    delete process.env.EMAIL_TOKEN_SECRET;
  }
});

test("after five wrong codes the address's code is refused until a new one is sent", async () => {
  const { verification, records } = studio({ list: ["X4KM9P", "H7QR2T"] });
  assert.equal(MAXIMUM_FAILURES, 5);
  await verification.start("pablo@example.com");
  for (let i = 0; i < 4; i++) await verification.confirm("pablo@example.com", "WRONG1");
  // Text that cannot be a code is not counted.
  await verification.confirm("pablo@example.com", "   ");
  await verification.confirm("pablo@example.com", undefined);
  assert.equal((await records.collection(EMAIL_CODES_COLLECTION).findOne({ email: "pablo@example.com" }))?.failures, 4);
  await verification.confirm("pablo@example.com", "WRONG1");
  assert.deepEqual(await verification.confirm("pablo@example.com", "X4KM9P"), { ok: false, code: "INVALID_CODE" });
  await verification.start("pablo@example.com");
  assert.equal((await records.collection(EMAIL_CODES_COLLECTION).findOne({ email: "pablo@example.com" }))?.failures, 0);
  assert.equal((await verification.confirm("pablo@example.com", "H7QR2T")).ok, true);
});

test("codes are kept in the store, so a code sent by one server instance is confirmed by another", async () => {
  let clock = START;
  const now = () => new Date(clock);
  const records = createStore({ now });
  const sender = createEmailVerification({ records, codes: codesFrom(["X4KM9P"]), now, env });
  const receiver = createEmailVerification({ records, codes: codesFrom(), now, env });
  await sender.start("pablo@example.com");
  clock += MINUTE;
  assert.equal((await receiver.confirm("pablo@example.com", "X4KM9P")).ok, true);
});

test("codes expire after expiryMinutes, checked by the component as well as by the store's time-to-live index", async () => {
  const { verification, advance, records } = studio({ list: ["X4KM9P", "H7QR2T"], settings: { expiryMinutes: 10 } });
  await verification.start("pablo@example.com");
  advance(10 * MINUTE - 1);
  assert.equal(await records.collection(EMAIL_CODES_COLLECTION).countDocuments({}), 1);
  await verification.start("marta@example.com");
  advance(1);
  assert.deepEqual(await verification.confirm("pablo@example.com", "X4KM9P"), { ok: false, code: "INVALID_CODE" });
  // A store that removes expired documents late (MongoDB, within a minute): the expiry is part of the match.
  let clock = START;
  const now = () => new Date(clock);
  const store = createStore({ now });
  const lagging = {
    collection(name: string) {
      const collection = store.collection(name);
      return { ...collection, createIndexes: (indexes: Array<{ key: Record<string, 1 | -1>; expireAfterSeconds?: number }>) => collection.createIndexes(indexes.map(({ expireAfterSeconds: _, ...index }) => index)) };
    },
  };
  const late = createEmailVerification({ records: lagging, codes: codesFrom(["X4KM9P"]), now, env });
  await late.start("pablo@example.com");
  clock += 15 * MINUTE;
  assert.equal(await store.collection(EMAIL_CODES_COLLECTION).countDocuments({}), 1);
  assert.deepEqual(await late.confirm("pablo@example.com", "X4KM9P"), { ok: false, code: "INVALID_CODE" });
});

test("settings reach the service: code length, cookie name, token lifetime and the secret's variable", async () => {
  const { verification, codes } = studio({
    settings: { codeLength: 8, cookieName: "studio_email", tokenMinutes: 10, tokenSecretVariable: "STUDIO_SECRET" }, env: { STUDIO_SECRET: SECRET },
  });
  const started = await verification.start("pablo@example.com");
  assert.ok(started.ok);
  assert.equal(started.code.length, 8);
  assert.deepEqual(codes.lengths, [8]);
  const confirmed = await verification.confirm("pablo@example.com", started.code);
  assert.ok(confirmed.ok);
  assert.equal(confirmed.expiresAt.getTime(), START + 10 * MINUTE);
  assert.equal(confirmed.setCookie, `studio_email=${confirmed.token}; Max-Age=600; Path=/; SameSite=Lax; HttpOnly`);
  assert.equal(await verification.verifiedEmail(`studio_email=${confirmed.token}`), "pablo@example.com");
  assert.equal(await verification.verifiedEmail(`shop_email_verified=${confirmed.token}`), null);
});

test("unexpired codes move with the records store's export and import (migration.json)", async () => {
  const { verification, records, now } = studio({ list: ["X4KM9P"] });
  await verification.start("pablo@example.com");
  const exported = records.exportAll();
  const lines = exported.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.filter((line) => line.index).map((line) => line.index), [{ key: { email: 1 }, unique: true }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }]);
  const document = lines.find((line) => line.document).document;
  assert.equal(document.expiresAt.$date, new Date(START + 15 * MINUTE).toISOString());
  // The exported code has exactly the fields of the declared document schema.
  const schema = JSON.parse(readFileSync(new URL("../interfaces/email-code.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(document).sort(), [...schema.required].sort());
  const moved = createStore({ now });
  assert.deepEqual(moved.importAll(exported), { collections: 1, records: 1 });
  const after = createEmailVerification({ records: moved, codes: codesFrom(), now, env });
  assert.equal((await after.confirm("pablo@example.com", "X4KM9P")).ok, true);
});

test("the example sends a link and confirms it from the link's query", async () => {
  const sent: Array<{ to: string; link: string }> = [];
  const routes = verificationRoutes({ records: createStore(), codes: codesFrom(["X4KM9P"]), env, send: async (to, link) => { sent.push({ to, link }); }, secure: true });
  assert.deepEqual(await routes.send({ email: "nope" }), { status: 400, json: { code: "INVALID_EMAIL" } });
  assert.deepEqual(await routes.send({ email: "Pablo@Example.com", language: "es" }), { status: 200, json: { ok: true } });
  assert.deepEqual(sent, [{ to: "pablo@example.com", link: "https://studio.example.com/es/gift-cards?verify=X4KM9P&email=pablo%40example.com" }]);
  const query = new URL(sent[0].link).searchParams;
  const confirmed = await routes.confirm({ email: query.get("email"), code: query.get("verify") });
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.headers["set-cookie"], /^shop_email_verified=[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]{43}; Max-Age=1800; Path=\/; SameSite=Lax; Secure; HttpOnly$/);
  assert.equal(await routes.verified(confirmed.headers["set-cookie"].split(";")[0]), "pablo@example.com");
  assert.equal(await routes.verifiedToken(confirmed.json.verificationToken), "pablo@example.com");
  assert.equal((await routes.confirm({ email: query.get("email"), code: query.get("verify") })).status, 400);
});
