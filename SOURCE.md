# Source mapping

Reference revision: `219d7dc979278f850fe0efd83c5e11eee26c3217` of `george-mcintyre/totalsculpt` (the totalsculpt.com web monorepo). Paths below are relative to that repository's root; `src/` stands for `web/apps/beauty-center/src/`.

- `implementation/server/verification.ts` <-
  - codes, their store and their expiry: `src/lib/email-verify-store.ts:1-39` (six characters, 15 minutes, one code per address kept under the trimmed lower-case address, deleted once confirmed);
  - the send route: `src/app/api/email-verify/send/route.ts:9-19` (the address check and the link `?verify=<code>&email=<address>`);
  - the confirm route and its cookie: `src/app/api/email-verify/confirm/route.ts:4-29` (`ts_email_verified`, 90 days, `SameSite` Lax, `Path` /, `Secure` in production);
  - the purchase page's use of both: `src/app/[locale]/gift-cards/page.tsx:120-153,289-317`.
  - Generalised: codes are kept in the records store's `emailCodes` collection with a unique index on the address and a time-to-live index on `expiresAt`; the expiry is also part of the confirmation's match, since stores remove expired documents late; codes come from the voucher-codes component; the code length, expiry and cookie name are settings; addresses must look like addresses; the link keeps any query or fragment the page path has.
  - Also: confirmation is one atomic delete, so a code is accepted once even when two requests arrive together; five wrong codes end an address's code (`MAXIMUM_FAILURES`); confirmation gives a token (the address, its end after `tokenMinutes`, and an HMAC-SHA-256 of both signed with the server's token secret, WebCrypto) that is the HttpOnly cookie's value and what an app sends; `verify` and `verifiedEmail` give the address only for a token this server signed that has not ended. Without the secret nothing is sent or confirmed.
  - Left behind: the email itself and its text (`src/app/api/email-verify/send/route.ts:21-60`), which the application sends through its mail component; the page's local storage and `BroadcastChannel` signal between tabs (`src/app/[locale]/gift-cards/page.tsx:34-57,155-178`), which stay in the application.
- `implementation/server/cookies.ts`: new; writes the `Set-Cookie` value (as Next.js `cookies.set` did for the source) and reads the `Cookie` header, so the component imports no other component.
- `implementation/server/settings.ts`: new; the settings template clod renders at install.
- `implementation/server/index.ts`: new; the entry module.
- `tests/web.test.ts`: new; the test names name the source behaviours kept. `tests/fixtures/records.ts` is a byte copy of memory-records' engine.
- `examples/consumer.ts`: new.
