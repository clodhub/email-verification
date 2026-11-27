# Email verification instructions

## For the agent
Select this component for the email-verification slot when the shop confirms customers' addresses: before it sells gift cards or packs, or before its apps bring back what an address has booked and bought. Connect `records` to the shop's records store and `voucher-codes` to the voucher-codes component. Set `tokenSecret` from the recipe's signing secret reference question; the deployment must expose that secret under the variable `tokenSecretVariable` names. Keep the other defaults unless the owner asks otherwise; if the owner renames the cookie, update the shop's cookie page with the new name.

- Select package `pkg:clod/com.clodhub/email-verification` version `0.1.0`.
- Settings to configure:
  - `codeLength` (integer; optional; default `6`)
  - `expiryMinutes` (integer; optional; default `15`)
  - `cookieName` (string, identifier; optional; default `shop_email_verified`)
  - `tokenMinutes` (integer; optional; default `30`)
  - `tokenSecretVariable` (string, environment; optional; default `EMAIL_TOKEN_SECRET`)
  - `tokenSecret` (string, identifier; optional; secret, supplied only by reference)
- Connect the provided `email-verification` (com.clodhub/email-verification 1.0.0) to the consumer that needs it.
- Supply `records` (com.clodhub/records 1.0.0) from the component that provides it.
- Supply `voucher-codes` (com.clodhub/voucher-codes 1.0.0) from the component that provides it.
- Secrets are given by reference (`secretRef`) only, never by value.

## For the developer
Supply the token secret as an environment variable (`EMAIL_TOKEN_SECRET` by default) in the host's settings, never in the repository; make it with `openssl rand -base64 32`. Add the two routes (send and confirm) and the check before checkout or before answering what an address has, send the email with the shop's mail component, pass `secure: true` on an https site, and rate-limit the send route.

## How to check
From the component directory:

- `node --test tests/web.test.ts` (web, required-local; tools: node 26.5)
- `python3 -m clod review <digest> --store STORE --policy POLICY --trusted --allow-network` runs the packaged checks.
