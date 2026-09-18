import Anthropic from "@anthropic-ai/sdk";
import { type Request, type Response } from "express";
import { accessSecret, consumeDemoMessage, verifyAccessToken } from "./access.js";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 8192;

const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 4000;
const MAX_TOTAL_CHARS = 60000;

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

function parseMessages(body: unknown): ChatMessage[] | string {
  if (typeof body !== "object" || body === null) {
    return "Request body must be a JSON object.";
  }

  const { messages } = body as { messages?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) {
    return "`messages` must be a non-empty array.";
  }
  if (messages.length > MAX_MESSAGES) {
    return "This conversation is too long. Start a new one to keep going.";
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

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value;
}

export async function handleChat(req: Request, res: Response) {
  const parsed = parseMessages(req.body);
  if (typeof parsed === "string") {
    res.status(400).json({ error: parsed });
    return;
  }

  const secret = accessSecret();
  const paid = secret
    ? verifyAccessToken(bearerToken(req), secret) !== null
    : false;

  let demoRemaining: number | null = null;
  if (!paid) {
    const demo = consumeDemoMessage(req.ip ?? "unknown");
    if (!demo.allowed) {
      res.status(402).json({
        error:
          "You've used up the free demo. Get full access for a one-time $100 to keep going.",
        code: "demo_exhausted",
      });
      return;
    }
    demoRemaining = demo.remaining;
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
        message:
          "The assistant can't help with that one. Try a different question.",
      });
    } else {
      send("done", { stop_reason: final.stop_reason, demoRemaining });
    }
  } catch (err) {
    if (!(err instanceof Anthropic.APIUserAbortError)) {
      console.error("[/api/chat]", err);
      send("error", { message: clientFacingError(err) });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}
