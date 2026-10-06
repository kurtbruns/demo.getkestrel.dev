/**
 * Visitor sessions (DESIGN.md, "Session identity"). A session is a random 256-bit token in
 * a cookie, signed with `SESSION_SECRET` so the Worker only honors tokens it issued: a forged
 * or tampered cookie is treated as no cookie, and so goes through the new-session rate limit
 * like any other first visit. The token selects the visitor's Durable Object through a
 * second HMAC, so a sandbox can only be reached by holding its cookie, and nothing in a URL
 * or anything Kestrel emits names one.
 */

export const SESSION_COOKIE = "kestrel_demo";

/** The cookie's lifetime. Sandboxes expire on their own idle TTL (#8); this only has to
 *  outlive it, so a returning visitor keeps their sandbox until then. */
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const byte of b) {
    s += String.fromCharCode(byte);
  }
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The two uses of the secret are domain-separated, so a cookie's signature is never also a
 *  sandbox's name. */
const SIGN = "kestrel-demo session v1:";
const NAME = "kestrel-demo sandbox v1:";

/** A new session: the token, and the signed cookie value that carries it. */
export async function mintSession(secret: string): Promise<{ token: string; value: string }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(SIGN + token));
  return { token, value: `${token}.${base64url(sig)}` };
}

/** The request's session token, if it carries a cookie this Worker signed; otherwise null. */
export async function readSession(request: Request, secret: string): Promise<string | null> {
  const value = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  const match = value ? /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value) : null;
  const token = match?.[1];
  const sig = match?.[2] ? fromBase64url(match[2]) : null;
  if (!token || !sig) {
    return null;
  }
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    sig,
    encoder.encode(SIGN + token),
  );
  return ok ? token : null;
}

/** The visitor's sandbox: a Durable Object named by an HMAC of their token. */
export async function sandboxName(secret: string, token: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(NAME + token));
  return base64url(mac);
}

/** The `Set-Cookie` value for a new session. `Secure` holds on http://localhost too, which
 *  browsers treat as a secure context. */
export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
}

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}
