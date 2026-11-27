import { assert, load } from './runtime.mjs';
import { createStore } from './records.ts';

const m = await load('server/index.ts');
let clock = Date.parse('2026-03-02T10:00:00.000Z');
const now = () => new Date(clock);
const MINUTE = 60 * 1000;
// The token secret is read from EMAIL_TOKEN_SECRET unless the settings name another variable.
const env = { EMAIL_TOKEN_SECRET: 't'.repeat(20) + '-token-secret-for-checks' };

// A double of the voucher codes: short codes of one group from a seeded generator, with every length asked for recorded.
function shortCodes(seed = 5) {
  let x = seed;
  const lengths = [];
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return {
    lengths,
    generateShort(length) {
      lengths.push(length);
      return Array.from({ length }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return alphabet[(x >>> 0) % 32]; }).join('');
    },
  };
}

// A store that, like MongoDB, has not yet removed expired documents: expiry is left to the component's own check.
function slowExpiry(store) {
  return {
    collection(name) {
      const collection = store.collection(name);
      return new Proxy(collection, {
        get(target, key) {
          if (key === 'createIndexes') return (indexes) => target.createIndexes(indexes.map(({ expireAfterSeconds, ...index }) => index));
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

// Settings.
assert.deepEqual(m.DEFAULT_SETTINGS, { codeLength: 6, expiryMinutes: 15, cookieName: 'shop_email_verified', tokenMinutes: 30, tokenSecretVariable: 'EMAIL_TOKEN_SECRET' });
assert.deepEqual(m.settingsFrom({ codeLength: '{{codeLength}}', expiryMinutes: '{{expiryMinutes}}', cookieName: '{{cookieName}}', tokenMinutes: '{{tokenMinutes}}',
  tokenSecretVariable: '{{tokenSecretVariable}}' }), m.DEFAULT_SETTINGS);
assert.deepEqual(m.settingsFrom({ codeLength: '8', expiryMinutes: '30', cookieName: 'studio_email', tokenMinutes: '20', tokenSecretVariable: 'STUDIO_SECRET' }),
  { codeLength: 8, expiryMinutes: 30, cookieName: 'studio_email', tokenMinutes: 20, tokenSecretVariable: 'STUDIO_SECRET' });
for (const bad of [{ codeLength: '2' }, { codeLength: 'six' }, { expiryMinutes: '0' }, { cookieName: 'bad name' }, { cookieName: '1st' }, { tokenMinutes: 0 },
  { tokenSecretVariable: 'lower' }]) {
  assert.throws(() => m.settingsFrom(bad), RangeError, JSON.stringify(bad));
}
assert.deepEqual(m.settingsFrom(m.installedSettings()), m.installedSettings());

// Addresses and links.
assert.equal(m.normaliseEmail('  Ana.Lopez@Example.COM '), 'ana.lopez@example.com');
for (const bad of ['', 'ana', 'ana@', '@example.com', 'ana@example', 'ana @example.com', 'a@b@example.com', 7, null, `${'a'.repeat(250)}@example.com`]) {
  assert.equal(m.normaliseEmail(bad), null, String(bad));
}
assert.equal(m.verificationPath('/es/gift-cards', 'ana+gift@example.com', 'X4KM9P'), '/es/gift-cards?verify=X4KM9P&email=ana%2Bgift%40example.com');
assert.equal(m.verificationPath('https://studio.example.com/en/gift-cards?step=3', 'ana@example.com', 'X4KM9P'),
  'https://studio.example.com/en/gift-cards?step=3&verify=X4KM9P&email=ana%40example.com');

// The service needs a store and codes; a token secret under 32 characters is refused when it is created.
assert.throws(() => m.createEmailVerification({ codes: shortCodes(), env }), TypeError);
assert.throws(() => m.createEmailVerification({ records: createStore({ now }), env }), TypeError);
assert.throws(() => m.createEmailVerification({ records: createStore({ now }), codes: shortCodes(), env: { EMAIL_TOKEN_SECRET: 'short' } }), RangeError);
const store = createStore({ now });
const codes = shortCodes();
const verification = m.createEmailVerification({ records: store, codes, now, env });
assert.equal(verification.configured(), true);
assert.deepEqual(verification.settings, m.installedSettings());
await verification.ensureIndexes();
assert.equal(m.EMAIL_CODES_COLLECTION, 'emailCodes');
const indexes = await store.collection('emailCodes').listIndexes();
assert.ok(indexes.some((index) => index.key.email === 1 && index.unique));
assert.ok(indexes.some((index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0));

// start: a code of codeLength from the voucher codes, kept under the normalised address until expiryMinutes have passed.
assert.deepEqual(await verification.start('not an address'), { ok: false, code: 'INVALID_EMAIL' });
const started = await verification.start(' Ana@Example.com ');
assert.equal(started.ok, true);
assert.equal(started.email, 'ana@example.com');
assert.match(started.code, /^[A-Z2-9]{6}$/);
assert.deepEqual(codes.lengths, [6]);
assert.equal(started.expiresAt.getTime(), clock + 15 * MINUTE);
const kept = await store.collection('emailCodes').find({});
assert.equal(kept.length, 1);
assert.equal(kept[0].email, 'ana@example.com');
assert.equal(kept[0].code, started.code);
assert.equal(kept[0].expiresAt.getTime(), started.expiresAt.getTime());

// confirm: the current code once, case and surrounding space ignored; a signed token for tokenMinutes names the address, as the
// cookie's value and for an app.
assert.deepEqual(await verification.confirm('ana@example.com', 'WRONG1'), { ok: false, code: 'INVALID_CODE' });
assert.deepEqual(await verification.confirm('other@example.com', started.code), { ok: false, code: 'INVALID_CODE' });
assert.deepEqual(await verification.confirm('ana@example.com', 42), { ok: false, code: 'INVALID_CODE' });
assert.deepEqual(await verification.confirm('ana@example.com', ''), { ok: false, code: 'INVALID_CODE' });
const confirmed = await verification.confirm('ANA@example.com', ` ${started.code.toLowerCase()} `, { secure: true });
assert.equal(confirmed.ok, true);
assert.equal(confirmed.email, 'ana@example.com');
assert.ok(typeof confirmed.token === 'string' && confirmed.token.length > 0 && !confirmed.token.includes('ana@example.com'));
assert.equal(confirmed.expiresAt.getTime(), Math.floor(clock / 1000) * 1000 + 30 * MINUTE);
const attributes = confirmed.setCookie.split(';').map((part) => part.trim());
assert.equal(attributes[0], `shop_email_verified=${encodeURIComponent(confirmed.token)}`);
assert.ok(attributes.includes('Max-Age=1800'));
assert.ok(attributes.includes('Path=/'));
assert.ok(attributes.includes('SameSite=Lax'));
assert.ok(attributes.includes('Secure'));
assert.ok(attributes.includes('HttpOnly'));
assert.equal(await verification.verifiedEmail(`theme=dark; ${attributes[0]}`), 'ana@example.com');
assert.equal(await verification.verify(confirmed.token), 'ana@example.com');
assert.equal(await m.createEmailVerification({ records: store, codes: shortCodes(3), now, env }).verify(confirmed.token), 'ana@example.com');
assert.deepEqual(await verification.confirm('ana@example.com', started.code), { ok: false, code: 'INVALID_CODE' });
const plain = await verification.start('luis@example.com');
assert.ok(!(await verification.confirm('luis@example.com', plain.code)).setCookie.includes('Secure'));

// Nothing else names an address: the plain address, an altered or foreign token, one signed with another secret, an expired one.
for (const header of ['shop_email_verified=ana%40example.com', 'theme=dark', null, 'shop_email_verified=not-a-token']) {
  assert.equal(await verification.verifiedEmail(header), null, String(header));
}
const flip = (text, at) => text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);
for (const forged of ['ana@example.com', flip(confirmed.token, 2), flip(confirmed.token, confirmed.token.length - 5), `${confirmed.token}x`, '', null, 7]) {
  assert.equal(await verification.verify(forged), null, String(forged));
}
const foreign = m.createEmailVerification({ records: createStore({ now }), codes: shortCodes(7), now, env: { EMAIL_TOKEN_SECRET: 'f'.repeat(40) } });
assert.equal(await foreign.verify(confirmed.token), null);
const tokenAt = clock;
clock += 30 * MINUTE - 1000;
assert.equal(await verification.verify(confirmed.token), 'ana@example.com');
clock += 1000;
assert.equal(await verification.verify(confirmed.token), null);
clock = tokenAt;

// Without the token secret no code is sent and none is confirmed.
const closedCodes = shortCodes(11);
const closed = m.createEmailVerification({ records: createStore({ now }), codes: closedCodes, now, env: {} });
assert.equal(closed.configured(), false);
assert.deepEqual(await closed.start('ana@example.com'), { ok: false, code: 'NOT_CONFIGURED' });
assert.deepEqual(closedCodes.lengths, []);
assert.deepEqual(await closed.confirm('ana@example.com', 'ABCDEF'), { ok: false, code: 'NOT_CONFIGURED' });
assert.equal(await closed.verify(confirmed.token), null);

// A second start replaces the first code; of two confirmations at once only one succeeds.
const first = await verification.start('marta@example.com');
const second = await verification.start('marta@example.com');
assert.notEqual(first.code, second.code);
assert.equal(await store.collection('emailCodes').countDocuments({ email: 'marta@example.com' }), 1);
assert.deepEqual(await verification.confirm('marta@example.com', first.code), { ok: false, code: 'INVALID_CODE' });
const raced = await Promise.all([verification.confirm('marta@example.com', second.code), verification.confirm('marta@example.com', second.code)]);
assert.equal(raced.filter((result) => result.ok).length, 1);

// Five wrong codes end an address's code, so a short code cannot be found by trying them all; a new start gives a new one.
const guessed = await verification.start('lucia@example.com');
for (let i = 0; i < 5; i++) assert.deepEqual(await verification.confirm('lucia@example.com', `WRONG${i}`), { ok: false, code: 'INVALID_CODE' });
assert.deepEqual(await verification.confirm('lucia@example.com', guessed.code), { ok: false, code: 'INVALID_CODE' });
const resent = await verification.start('lucia@example.com');
for (let i = 0; i < 4; i++) await verification.confirm('lucia@example.com', `WRONG${i}`);
assert.equal((await verification.confirm('lucia@example.com', resent.code)).ok, true);

// Codes outlive the process: another instance over the same store confirms a code this one sent.
const elsewhere = m.createEmailVerification({ records: store, codes: shortCodes(9), now, env });
const sent = await verification.start('pablo@example.com');
assert.equal((await elsewhere.confirm('pablo@example.com', sent.code)).ok, true);

// Expiry is checked by the component, even before the store removes the expired code.
const lagging = m.createEmailVerification({ records: slowExpiry(createStore({ now })), codes: shortCodes(13), now, env, settings: { expiryMinutes: 10 } });
const soon = await lagging.start('sara@example.com');
assert.equal(soon.expiresAt.getTime(), clock + 10 * MINUTE);
clock += 10 * MINUTE + 1;
assert.deepEqual(await lagging.confirm('sara@example.com', soon.code), { ok: false, code: 'INVALID_CODE' });
const fresh = await lagging.start('sara@example.com');
clock += 9 * MINUTE;
assert.equal((await lagging.confirm('sara@example.com', fresh.code)).ok, true);

// Settings reach the service: code length, expiry, the cookie, the token's lifetime and the secret's variable.
const custom = m.createEmailVerification({ records: createStore({ now }), codes: shortCodes(17), now, env: { STUDIO_SECRET: env.EMAIL_TOKEN_SECRET },
  settings: { codeLength: 8, cookieName: 'studio_email', tokenMinutes: 10, tokenSecretVariable: 'STUDIO_SECRET' } });
const long = await custom.start('ana@example.com');
assert.match(long.code, /^[A-Z2-9]{8}$/);
const remembered = await custom.confirm('ana@example.com', long.code);
assert.ok(remembered.setCookie.startsWith(`studio_email=${encodeURIComponent(remembered.token)};`));
assert.ok(remembered.setCookie.includes('Max-Age=600'));
assert.equal(remembered.expiresAt.getTime(), Math.floor(clock / 1000) * 1000 + 10 * MINUTE);
assert.equal(await custom.verifiedEmail(remembered.setCookie.split(';')[0]), 'ana@example.com');
console.log('email verification class: all checks passed');
