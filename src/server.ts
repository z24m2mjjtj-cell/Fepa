import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";

const PORT = Number(process.env.PORT ?? 3000);
const MODEL = "claude-opus-5";
const MAX_TOKENS = 8192;

const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 4000;
const MAX_TOTAL_CHARS = 60000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

const SYSTEM_PROMPT = `You are EIN-trepreneur AI, a personal business assistant built by FEPA LLC for people running or starting their own small business.

You help across three areas:
- Business: pricing, contracts, cash flow, vendor terms, and practical steps toward business credit and financing readiness.
- Professional: emails, proposals, negotiations, meetings, and hiring.
- Social: networking, difficult conversations, client communication, and reading a room.

How to answer:
- Be specific and practical. Give the actual number, the actual wording, the actual next step — not a generic pep talk.
- When the answer depends on facts you do not have, ask one focused follow-up question rather than hedging through every case.
- When someone needs a document — an email, a proposal, a scope of work — draft it in full so they can use it.
- Keep replies tight. A few short paragraphs or a compact list. No filler preamble.
- Be direct about risk. If a plan is likely to cost them money or a client, say so plainly.

Boundaries: you are not a lawyer, accountant, or licensed financial advisor, and you do not provide legal, tax, or investment advice. Give the practical general guidance you can, and when something turns on legal, tax, lending, or regulatory specifics, say plainly that it needs a professional or the institution itself — once, briefly, without repeating a disclaimer in every reply.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

const client = new Anthropic();
const app = express();

// Hosts like Render, Fly and Railway terminate TLS upstream, so req.ip is the
// proxy without this and the per-IP rate limit becomes one global bucket.
// Left off by default: trusting the header when nothing strips it lets a
// client forge its own address.
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

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

function parseMessages(body: unknown): ChatMessage[] | string {
  if (typeof body !== "object" || body === null) {
    return "Request body must be a JSON object.";
  }

  const { messages } = body as { messages?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) {
    return "`messages` must be a non-empty array.";
  }
  if (messages.length > MAX_MESSAGES) {
    return `This conversation is too long. Start a new one to keep going.`;
  }

  const parsed: ChatMessage[] = [];
  let totalChars = 0;

  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) {
      return "Each message must be an object.";
    }
    const { role, content } = raw as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      return "Each message needs a role of 'user' or 'assistant'.";
    }
    if (typeof content !== "string" || content.trim() === "") {
      return "Each message needs non-empty text content.";
    }
    if (content.length > MAX_CHARS_PER_MESSAGE) {
      return `Messages are limited to ${MAX_CHARS_PER_MESSAGE} characters.`;
    }
    totalChars += content.length;
    parsed.push({ role, content });
  }

  if (totalChars > MAX_TOTAL_CHARS) {
    return "This conversation is too long. Start a new one to keep going.";
  }
  if (parsed[0]?.role !== "user") {
    return "A conversation has to start with a user message.";
  }

  return parsed;
}

function clientFacingError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) {
    return "The assistant is handling a lot of requests right now — try again in a moment.";
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return "The assistant isn't configured correctly. Please contact FEPA support.";
  }
  if (err instanceof Anthropic.APIError) {
    return "The assistant couldn't finish that request — try asking again.";
  }
  return "Something went wrong on that request — try asking again.";
}

app.post("/api/chat", async (req, res) => {
  if (isRateLimited(req.ip ?? "unknown")) {
    res
      .status(429)
      .json({ error: "That's a lot of questions at once — give it a minute." });
    return;
  }

  const parsed = parseMessages(req.body);
  if (typeof parsed === "string") {
    res.status(400).json({ error: parsed });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: { effort: "medium" },
    messages: parsed,
  });

  // Fires on client disconnect. A normal finish has already ended the
  // response, so writableEnded distinguishes the two.
  res.on("close", () => {
    if (!res.writableEnded) stream.abort();
  });

  try {
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        send("delta", { text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      send("error", {
        message: "The assistant can't help with that one. Try a different question.",
      });
    } else {
      send("done", { stop_reason: final.stop_reason });
    }
  } catch (err) {
    if (!(err instanceof Anthropic.APIUserAbortError)) {
      console.error("[/api/chat]", err);
      send("error", { message: clientFacingError(err) });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.listen(PORT, () => {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn(
      "Warning: no ANTHROPIC_API_KEY set — /api/chat will fail until it is. See .env.example.",
    );
  }
  console.log(`FEPA EIN-trepreneur AI running at http://localhost:${PORT}`);
});
