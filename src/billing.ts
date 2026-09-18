import express, { type Request, type Response } from "express";
import Stripe from "stripe";
import { accessSecret, mintAccessToken } from "./access.js";
import { sendAccessEmail } from "./email.js";

const PRICE_CENTS = 10_000;
const PRODUCT_NAME = "EIN-trepreneur AI — Complete Access";
const PRODUCT_DESCRIPTION =
  "One-time payment. Business, professional and social guidance, plus the Business Credit Blueprint.";

let stripe: Stripe | null = null;

function getStripe(): Stripe | null {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  stripe = new Stripe(key);
  return stripe;
}

function siteUrl(req: Request): string {
  const configured = process.env.SITE_URL;
  if (configured) return configured.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

export async function createCheckoutSession(req: Request, res: Response) {
  const client = getStripe();
  if (!client) {
    res.status(503).json({
      error: "Checkout isn't set up yet. Please contact FEPA LLC to purchase.",
    });
    return;
  }

  const base = siteUrl(req);

  try {
    const session = await client.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: PRICE_CENTS,
            product_data: {
              name: PRODUCT_NAME,
              description: PRODUCT_DESCRIPTION,
            },
          },
        },
      ],
      success_url: `${base}/purchase-complete.html`,
      cancel_url: `${base}/#pricing`,
    });

    if (!session.url) {
      throw new Error("Stripe returned a session without a redirect URL");
    }
    res.json({ url: session.url });
  } catch (err) {
    console.error("[/api/checkout]", err);
    res
      .status(502)
      .json({ error: "Couldn't start checkout just now — please try again." });
  }
}

/**
 * Stripe signs the exact bytes it sent, so this route must read the raw body.
 * express.json() would have already parsed and discarded it, which is why the
 * raw parser is mounted here rather than globally.
 */
export const stripeWebhookParser = express.raw({ type: "application/json" });

export async function handleStripeWebhook(req: Request, res: Response) {
  const client = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const secret = accessSecret();

  if (!client || !webhookSecret || !secret) {
    console.error("[stripe webhook] missing STRIPE_* or ACCESS_TOKEN_SECRET");
    res.status(503).send("Billing is not configured.");
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    res.status(400).send("Missing Stripe signature.");
    return;
  }

  let event: Stripe.Event;
  try {
    event = client.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe webhook] signature verification failed", err);
    res.status(400).send("Invalid signature.");
    return;
  }

  if (event.type !== "checkout.session.completed") {
    res.json({ received: true });
    return;
  }

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") {
    res.json({ received: true });
    return;
  }

  const email =
    session.customer_details?.email ?? session.customer_email ?? null;
  if (!email) {
    console.error("[stripe webhook] paid session has no email", session.id);
    // Acknowledge anyway: retrying will not conjure an address, and an
    // unacknowledged event makes Stripe redeliver forever.
    res.json({ received: true });
    return;
  }

  const token = mintAccessToken(email, secret);
  const accessUrl = `${siteUrl(req)}/access.html#token=${encodeURIComponent(token)}`;

  try {
    await sendAccessEmail(email, accessUrl);
  } catch (err) {
    // The link is logged by the mailer fallback, so it is recoverable by hand.
    console.error("[stripe webhook] failed to send access email", err);
  }

  res.json({ received: true });
}
