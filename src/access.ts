import crypto from "node:crypto";

const TOKEN_VERSION = "v1";

// The landing page advertises a working demo, so unpaid visitors get a small
// taste before the paywall rather than a locked box.
const FREE_DEMO_MESSAGES = 5;
const FREE_DEMO_WINDOW_MS = 24 * 60 * 60 * 1000;

export function accessSecret(): string | undefined {
  return process.env.ACCESS_TOKEN_SECRET;
}

function sign(payload: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

/**
 * Lifetime access token: `v1.<base64url payload>.<hmac>`. The purchase is
 * one-time, so it does not expire. It is a bearer credential with no
 * server-side revocation list — rotating ACCESS_TOKEN_SECRET invalidates every
 * token ever issued, which is the only revocation available without a database.
 */
export function mintAccessToken(email: string, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ email, issuedAt: Date.now() }),
  ).toString("base64url");
  return `${TOKEN_VERSION}.${payload}.${sign(payload, secret)}`;
}

export function verifyAccessToken(
  token: unknown,
  secret: string,
): { email: string } | null {
  if (typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [version, payload, signature] = parts;
  if (version !== TOKEN_VERSION || !payload || !signature) return null;

  const expected = sign(payload, secret);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return null;
  if (!crypto.timingSafeEqual(given, want)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof decoded?.email !== "string") return null;
    return { email: decoded.email };
  } catch {
    return null;
  }
}

const demoUsage = new Map<string, { count: number; resetAt: number }>();

export function consumeDemoMessage(key: string): {
  allowed: boolean;
  remaining: number;
} {
  const now = Date.now();

  if (demoUsage.size > 10_000) {
    for (const [k, v] of demoUsage) {
      if (now > v.resetAt) demoUsage.delete(k);
    }
  }

  const entry = demoUsage.get(key);
  if (!entry || now > entry.resetAt) {
    demoUsage.set(key, { count: 1, resetAt: now + FREE_DEMO_WINDOW_MS });
    return { allowed: true, remaining: FREE_DEMO_MESSAGES - 1 };
  }

  if (entry.count >= FREE_DEMO_MESSAGES) {
    return { allowed: false, remaining: 0 };
  }

  entry.count += 1;
  return { allowed: true, remaining: FREE_DEMO_MESSAGES - entry.count };
}
