import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { accessSecret, verifyAccessToken } from "./access.js";
import {
  createCheckoutSession,
  handleStripeWebhook,
  stripeWebhookParser,
} from "./billing.js";
import { handleChat } from "./chat.js";

const PORT = Number(process.env.PORT ?? 3000);

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

const app = express();

// Hosts like Render, Fly and Railway terminate TLS upstream, so req.ip is the
// proxy without this and the per-IP rate limit becomes one global bucket.
// Left off by default: trusting the header when nothing strips it lets a
// client forge its own address.
if (process.env.TRUST_PROXY) {
  app.set(
    "trust proxy",
    Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY,
  );
}

// Mounted before express.json() so Stripe's signature check still sees the
// exact bytes Stripe signed.
app.post("/api/stripe/webhook", stripeWebhookParser, handleStripeWebhook);

app.use(express.json({ limit: "128kb" }));

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);
app.use(express.static(publicDir));

const rateLimitHits = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string): boolean {
  const now = Date.now();

  if (rateLimitHits.size > 10_000) {
    for (const [k, v] of rateLimitHits) {
      if (now > v.resetAt) rateLimitHits.delete(k);
    }
  }

  const entry = rateLimitHits.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitHits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

app.use("/api", (req, res, next) => {
  if (isRateLimited(req.ip ?? "unknown")) {
    res
      .status(429)
      .json({ error: "That's a lot of requests at once — give it a minute." });
    return;
  }
  next();
});

app.post("/api/chat", handleChat);
app.post("/api/checkout", createCheckoutSession);

app.get("/api/access", (req, res) => {
  const secret = accessSecret();
  const token = String(req.query.token ?? "");
  const claims = secret ? verifyAccessToken(token, secret) : null;
  res.json({ valid: claims !== null });
});

app.listen(PORT, () => {
  const missing = [
    !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN
      ? "ANTHROPIC_API_KEY (chat will fail)"
      : null,
    !process.env.ACCESS_TOKEN_SECRET
      ? "ACCESS_TOKEN_SECRET (paid access cannot be granted)"
      : null,
    !process.env.STRIPE_SECRET_KEY ? "STRIPE_SECRET_KEY (checkout is off)" : null,
    !process.env.STRIPE_WEBHOOK_SECRET
      ? "STRIPE_WEBHOOK_SECRET (purchases cannot be confirmed)"
      : null,
  ].filter(Boolean);

  if (missing.length) {
    console.warn(`Warning: not configured — ${missing.join("; ")}. See .env.example.`);
  }
  console.log(`FEPA EIN-trepreneur AI running at http://localhost:${PORT}`);
});
