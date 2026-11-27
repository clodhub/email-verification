# Email verification component

## Purpose and facilities
Before a shop sells a gift card to an address, or shows an app what that address has booked and bought, it confirms that the customer can read mail there: the card and its receipt then reach them, and nobody is shown another's bookings. `start(email)` gives the address a new code of `codeLength` characters from the voucher-codes component, valid for `expiryMinutes`, in place of any earlier code; the application emails a link made by `verificationPath`. `confirm(email, code)` accepts the current code once and before it expires (five wrong codes end it; each try takes one of the five before it is compared, so tries sent together cannot pass the limit) and returns a token that names the address for `tokenMinutes`: an HMAC-SHA-256 of the address and its end, signed with the server's token secret, so nobody can make one for an address they did not confirm. The same token is the browser's cookie (`setCookie`, HttpOnly) and what an app sends with each request that needs the confirmed address; `verify(token)` and `verifiedEmail(cookieHeader)` give the address back, or nothing for a forged or expired token. Codes are documents of the records store's `emailCodes` collection with a time-to-live index, so every server instance sees them, and the expiry is also checked on every confirmation because stores remove expired documents late.

Facilities: `email-verification` (Give an address a short expiring code, confirm it once, and name the confirmed address for a while with a signed token, a browser's cookie or an app's).

## User inputs
`codeLength` (4 to 12, default 6) and `expiryMinutes` (1 to 1440, default 15) shape the code; `cookieName` (an identifier, default `shop_email_verified`) names the cookie, and `tokenMinutes` (5 to 1440, default 30) is how long a token and its cookie name the address. `tokenSecretVariable` names the environment variable that holds the signing secret (`EMAIL_TOKEN_SECRET`, at least 32 characters, such as the output of `openssl rand -base64 32`), and `tokenSecret` is the reference to that secret, supplied by the deployment and never by value. List the cookie on the shop's cookie page.

- `codeLength` (integer; optional; default `6`)
- `expiryMinutes` (integer; optional; default `15`)
- `cookieName` (string, identifier; optional; default `shop_email_verified`)
- `tokenMinutes` (integer; optional; default `30`)
- `tokenSecretVariable` (string, environment; optional; default `EMAIL_TOKEN_SECRET`)
- `tokenSecret` (string, identifier; optional; secret, supplied only by reference)

## Artefacts and dependencies
`component.json` maps every `implementation/` source into `components/email-verification/`:

- `implementation/server/cookies.ts` -> `components/email-verification/server/cookies.ts`
- `implementation/server/index.ts` -> `components/email-verification/server/index.ts`
- `implementation/server/settings.ts` -> `components/email-verification/server/settings.ts`
- `implementation/server/verification.ts` -> `components/email-verification/server/verification.ts`

Dependencies: none.
`tools.lock.json` pins verification tools: node 26.5. Licence: `Apache-2.0` (`LICENCE`, `NOTICE`).

## Provided interfaces
- `interfaces/email-verification.json` defines `email-verification` (com.clodhub/email-verification) version 1.0.0.

## Required interfaces
- `records` (com.clodhub/records) version 1.0.0, supplied by the recipe or application.
- `voucher-codes` (com.clodhub/voucher-codes) version 1.0.0, supplied by the recipe or application.

## Integration
Server only. Create the service once per process with `createEmailVerification({ records, codes })`: the shop's records store and the voucher-codes component. The send route calls `start(email)` and, when it is ok, emails `verificationPath(page, email, code)`; the confirm route (or the page the link opens) calls `confirm(email, code, { secure })` with `secure` true on an https site, returns `setCookie` as the response's `Set-Cookie` header and `token` with `expiresAt` in its body. The purchase route compares the address `verify(token)` gives for the token an app sends, or `verifiedEmail(request cookie header)` gives for a browser, with the buyer's address; a route that answers what an address has booked and bought takes the address `verify(token)` gives. Without the secret, `start` and `confirm` answer `NOT_CONFIGURED`; `configured()` says so in advance.

## Visual definition and connected examples
`visual/definition.json` maps its ports to the provided and required interfaces. `visual/examples/connected.json` connects the component to an illustrative application consumer. Both image formats and a text description are retained under `visual/output/`.

## Infrastructure
No service or account: codes are kept in the records store; the application sends the email through its mail component. The token secret lives in the host's environment variables. Rate-limit the send route so nobody can flood an address with codes.

## Verification
`tests/web.test.ts` checks the settings template and its defaults, address normalising, verification links, the cookie writer and reader, the indexes, one code per address replaced by each start (also when two starts race), single-use confirmation that ignores case and surrounding space, the token and its cookie (HttpOnly, with and without `Secure`) against an HMAC computed with node:crypto, forged, altered, foreign, too long-lived and expired tokens and the plain address naming nothing, no secret giving `NOT_CONFIGURED` and a short one refused at start, the limit of five wrong codes, also for codes typed together, a code sent by one server instance and confirmed by another, expiry with and without a store that removes expired codes at once, settings reaching the service, export and import with the records store, and the example's two routes. The email-verification class suite (`classes/email-verification-class/check.mjs`) checks the shared contract against any implementation.

- `node --test tests/web.test.ts` (web, required-local; tools: node 26.5)

## Scenarios and presentation
Pablo buys a gift card at Example Studio and gives `pablo@example.com`; the shop emails him a link with the code `X4KM9P`. He opens it on his phone a few minutes later, served by another server instance than the one that sent it: the code is confirmed, the cookie names his address for 30 minutes, and the purchase continues without asking again. In the studio's app, the same confirmation gives the app the token it sends with the purchase. A code opened after 15 minutes, or a second time, is refused and he asks for a new one.

## Updates and removal
Patch updates replace the files only. Codes are short-lived documents of the records store's `emailCodes` collection (`interfaces/email-code.schema.json`); an export and import moves the unexpired ones. Removing the component leaves at most the last 15 minutes of codes, which the store's time-to-live index removes; drop the collection to remove them at once. Tokens live only in shoppers' cookies and apps, for 30 minutes; a new token secret ends them all.
