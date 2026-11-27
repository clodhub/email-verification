// Cookie headers, written here so the component imports no other component.

export type CookieOptions = { maxAge?: number; secure?: boolean; httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None"; path?: string };

export function serialiseCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  parts.push(`Path=${options.path ?? "/"}`);
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.secure) parts.push("Secure");
  if (options.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

// The cookies of a Cookie request header; the first of two with one name wins, as browsers send the most specific first.
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (typeof header !== "string") return cookies;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 1) continue;
    const name = part.slice(0, equals).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    let value = part.slice(equals + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}
