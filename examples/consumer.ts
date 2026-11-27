import { createEmailVerification, verificationPath } from "../implementation/server/index.ts";
import type { RecordsLike, ShortCodes } from "../implementation/server/index.ts";

// The two routes of Example Studio's gift card page: send a code by email, then confirm it from the link. The confirmation sets
// the cookie the purchase route reads in a browser, and answers the same token for an app to send with its purchase.
export function verificationRoutes(deps: {
  records: RecordsLike; codes: ShortCodes; env: Record<string, string | undefined>; send: (to: string, link: string) => Promise<void>; secure: boolean;
}) {
  const verification = createEmailVerification({ records: deps.records, codes: deps.codes, env: deps.env });
  return {
    async send(body: { email?: unknown; language?: unknown }): Promise<{ status: number; json: Record<string, unknown> }> {
      const started = await verification.start(body.email);
      if (!started.ok) return { status: started.code === "NOT_CONFIGURED" ? 503 : 400, json: { code: started.code } };
      const language = body.language === "es" ? "es" : "en";
      await deps.send(started.email, verificationPath(`https://studio.example.com/${language}/gift-cards`, started.email, started.code));
      return { status: 200, json: { ok: true } };
    },
    async confirm(body: { email?: unknown; code?: unknown }): Promise<{ status: number; json: Record<string, unknown>; headers: Record<string, string> }> {
      const confirmed = await verification.confirm(body.email, body.code, { secure: deps.secure });
      if (!confirmed.ok) return { status: confirmed.code === "NOT_CONFIGURED" ? 503 : 400, json: { code: confirmed.code }, headers: {} };
      return {
        status: 200,
        json: { email: confirmed.email, verificationToken: confirmed.token, expiresAt: confirmed.expiresAt.toISOString() },
        headers: { "set-cookie": confirmed.setCookie },
      };
    },
    // The confirmed address of a browser (its cookie) or of an app (the token it sends); null when there is none.
    verified: (cookieHeader: string | null) => verification.verifiedEmail(cookieHeader),
    verifiedToken: (token: unknown) => verification.verify(token),
  };
}
