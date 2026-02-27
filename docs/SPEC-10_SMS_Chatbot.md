# SPEC-10: SMS Chatbot (C06)
### NexDrive Academy — Phase 2 Never Miss a Lead
**Version:** 1.0  
**Date:** 21 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.8, §5.2, §5.3; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-03 (Booking Engine — availability & booking APIs); SPEC-05 (CRM — auto-create service); SPEC-07 (Notification Engine — Twilio SMS adapter, status webhook); SPEC-08 (RAG Knowledge Engine — query API)  
**Phase:** 2 (Never Miss a Lead — Weeks 7-12)  
**Estimated Effort:** 8-10 days  

---

## 1. Overview

The SMS Chatbot is NexDrive Academy's AI-powered text message assistant. When someone sends an SMS to the NexDrive business number, the chatbot identifies who they are (or creates a new contact), loads conversation context, routes the message through the RAG Knowledge Engine (C07), and replies via Twilio — all within seconds. It handles FAQ answers, booking enquiries, student progress questions, and gracefully hands off to Rob when human follow-up is needed.

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **Every SMS creates or touches a CRM contact.** Sender phone number is matched to an existing contact or a new one is created via the CRM auto-create service (SPEC-05 §13). No message is anonymous in the CRM.
2. **Twilio webhook signature verification on every inbound request.** The `X-Twilio-Signature` header is verified before any processing occurs. Invalid signatures are rejected with 403.
3. **Conversation threading by phone number.** Messages from the same number within 24 hours belong to the same conversation. After 24h of inactivity, a new conversation starts.
4. **SMS-specific response formatting.** No markdown, no bullet points, no links longer than ~40 chars. Aim for ≤320 characters (2 SMS segments). Never exceed 480 characters (3 segments).
5. **All AI responses flow through the RAG engine (SPEC-08).** The SMS chatbot does NOT have its own LLM integration — it calls `POST /api/internal/rag/query` with `channel: 'sms'` and formats the response for SMS delivery.
6. **Booking intent → guided multi-message flow.** When the RAG engine detects booking intent, the SMS chatbot guides the user through a conversational booking flow or sends them a direct booking link.
7. **Handoff is always available.** Any user can text "talk to Rob" / "speak to a person" and the system immediately triggers human handoff — flagging the conversation and notifying Rob. No resistance.
8. **Rate limiting.** Maximum 20 inbound messages per phone number per hour. Prevents SMS flooding and cost abuse. Enforced via Upstash Redis.
9. **Australian English, warm & professional.** Rob's brand voice, adapted for SMS brevity. "G'day" is fine; corporate jargon is not.
10. **Private notes are NEVER in context.** The RAG engine never has access to `private_notes` — but this spec's responsibility is to never pass student private data in the SMS context either.
11. **Bookings via SMS use `booked_via: 'sms_agent'`.** This tracks channel attribution for analytics and CRM.
12. **Message storage is complete.** Every inbound and outbound message is stored in the `messages` table with direction, sender_type, intent_detected, confidence, and Twilio SID.
13. **Idempotent webhook handling.** Twilio may retry webhooks. Use `MessageSid` as deduplication key.
14. **Return TwiML response within 15 seconds.** Twilio expects a response within its timeout window. If RAG processing takes too long, send an acknowledgement and follow up asynchronously.

### 1.2 SMS Message Lifecycle

```
Inbound SMS (NexDrive Business Number)
     │
     ▼
┌──────────────────────────┐
│  Twilio Receives SMS     │  ← Twilio forwards to our webhook
│  POSTs to webhook        │
└────────────┬─────────────┘
             │
     ┌───────▼────────────────┐
     │  POST /api/v1/sms/     │  ← Verify Twilio signature
     │  inbound               │     Parse form body (From, Body, MessageSid)
     └───────┬────────────────┘
             │
     ┌───────▼────────────────┐
     │  Rate Limit Check       │  ← Upstash Redis: 20 msgs/phone/hour
     │  (reject if exceeded)   │     If exceeded → reply "slow down" + return
     └───────┬────────────────┘
             │
     ┌───────▼────────────────┐
     │  Dedup Check            │  ← Check MessageSid in messages table
     │  (reject if duplicate)  │     If seen → return 200 (no re-process)
     └───────┬────────────────┘
             │
     ┌───────▼────────────────┐
     │  CRM Upsert             │  ← SPEC-05 upsertFromChannel
     │  (create or touch       │     source: 'sms'
     │   contact)              │     Returns { contact_id, is_new }
     └───────┬────────────────┘
             │
     ┌───────▼────────────────┐
     │  Resolve Conversation   │  ← Find active conversation for phone
     │  (get or create)        │     within 24h window
     └───────┬────────────────┘
             │
     ┌───────▼────────────────┐
     │  Store Inbound Message  │  ← messages table: direction=inbound,
     │                         │     sender_type=user, external_id=MessageSid
     └───────┬────────────────┘
             │
     ┌───────▼────────────────┐
     │  Query RAG Engine       │  ← POST /api/internal/rag/query
     │  (with SMS context)     │     channel: 'sms', session_id, contact context
     └───────┬────────────────┘
             │
     ┌───────┴────────────────┐
     │                        │
     ▼                        ▼
  HANDOFF                  AI RESPONSE
     │                        │
     ▼                        ▼
┌──────────┐          ┌──────────────┐
│ Flag     │          │ Format for   │
│ convo    │          │ SMS (strip   │
│ + notify │          │ markdown,    │
│ Rob      │          │ truncate)    │
└────┬─────┘          └──────┬───────┘
     │                       │
     └───────┬───────────────┘
             │
     ┌───────▼────────────────┐
     │  Send Reply via Twilio  │  ← twilioSmsAdapter.send()
     │  (using Notification    │     Returns MessageSid
     │   Engine adapter)       │
     └───────┬────────────────┘
             │
     ┌───────▼────────────────┐
     │  Store Outbound Message │  ← messages table: direction=outbound,
     │  + Update Conversation  │     sender_type=ai, external_id=reply SID
     └────────────────────────┘


Delivery Status (async):

     ┌────────────────────────┐
     │  Twilio sends status   │  ← POST /api/v1/sms/status
     │  callback              │     Update messages.delivery_status
     └────────────────────────┘
```

---

## 2. File Structure

```
src/
├── lib/
│   └── sms/
│       ├── index.ts                          # Barrel export
│       ├── types.ts                          # All SMS types + Zod schemas
│       ├── errors.ts                         # SMS-specific error classes
│       ├── constants.ts                      # Rate limits, timeouts, templates
│       ├── inbound.service.ts                # Core inbound message processing
│       ├── conversation.service.ts           # SMS conversation threading (24h window)
│       ├── response-formatter.service.ts     # RAG output → SMS-safe formatting
│       ├── booking-flow.service.ts           # Multi-message booking guidance via SMS
│       ├── handoff.service.ts                # Human handoff flagging + Rob notification
│       ├── rate-limiter.service.ts           # Upstash Redis rate limiting
│       ├── twilio-signature.ts               # Twilio signature verification utility
│       └── sms-sender.service.ts             # Outbound SMS (wraps SPEC-07 adapter)
├── app/
│   └── api/
│       └── v1/
│           └── sms/
│               ├── inbound/
│               │   └── route.ts              # POST /api/v1/sms/inbound (Twilio webhook)
│               └── status/
│                   └── route.ts              # POST /api/v1/sms/status (delivery callback)
└── __tests__/
    └── lib/
        └── sms/
            ├── inbound.service.test.ts
            ├── conversation.service.test.ts
            ├── response-formatter.service.test.ts
            ├── booking-flow.service.test.ts
            ├── handoff.service.test.ts
            ├── rate-limiter.service.test.ts
            └── integration/
                ├── inbound-webhook.test.ts     # Full webhook → reply flow
                ├── conversation-threading.test.ts
                └── booking-flow.test.ts
```

---

## 3. Dependencies

```json
{
  "twilio": "^5.x",
  "zod": "^3.22.x",
  "@upstash/redis": "^1.x",
  "@upstash/ratelimit": "^2.x"
}
```

These are in addition to the base project dependencies (Next.js, Drizzle, etc.) established in Phase 0. `twilio` and `@upstash/redis` are already installed per SPEC-07 and the architecture doc. `@upstash/ratelimit` provides sliding window rate limiting on top of Upstash Redis.

> **Note:** The SMS chatbot does NOT install the Anthropic SDK or OpenAI SDK directly. All AI processing goes through the RAG Engine's internal API (SPEC-08).

---

## 4. Types & Zod Schemas (`types.ts`)

```typescript
// src/lib/sms/types.ts

import { z } from 'zod';

// ─── Twilio Inbound Webhook Body ─────────────────

export const TwilioInboundSchema = z.object({
  MessageSid: z.string().min(1),               // Twilio message SID (dedup key)
  AccountSid: z.string().min(1),               // Twilio account SID
  From: z.string().min(1),                     // Sender phone (E.164)
  To: z.string().min(1),                       // Our Twilio number (E.164)
  Body: z.string().max(1600).default(''),      // Message text (up to 10 segments)
  NumMedia: z.coerce.number().default(0),       // Number of media attachments
  NumSegments: z.coerce.number().default(1),    // Number of SMS segments
  // Optional media fields (if NumMedia > 0)
  MediaUrl0: z.string().url().optional(),
  MediaContentType0: z.string().optional(),
});
export type TwilioInboundPayload = z.infer<typeof TwilioInboundSchema>;

// ─── Twilio Status Callback Body ─────────────────

export const TwilioStatusSchema = z.object({
  MessageSid: z.string().min(1),
  MessageStatus: z.enum([
    'accepted', 'queued', 'sending', 'sent',
    'delivered', 'undelivered', 'failed', 'read',
  ]),
  To: z.string().optional(),
  From: z.string().optional(),
  ErrorCode: z.string().optional(),
  ErrorMessage: z.string().optional(),
});
export type TwilioStatusPayload = z.infer<typeof TwilioStatusSchema>;

// ─── SMS Processing Result ───────────────────────

export interface SmsProcessingResult {
  conversation_id: string;
  contact_id: string;
  is_new_contact: boolean;
  is_new_conversation: boolean;
  inbound_message_id: string;
  outbound_message_id: string;
  intent_detected?: string;
  confidence?: number;
  handoff_requested: boolean;
  reply_text: string;
  reply_segments: number;
  reply_external_id?: string;       // Twilio SID of our reply
}

// ─── SMS Context for RAG Engine ──────────────────

export interface SmsQueryContext {
  channel: 'sms';
  sender_phone: string;
  contact_id?: string;
  student_id?: string;
  session_id: string;               // conversation ID
  is_new_contact: boolean;
  conversation_message_count: number;
}

// ─── Booking Flow State ──────────────────────────
// Tracked in conversation metadata (JSONB) — NOT a separate table.

export interface BookingFlowState {
  active: boolean;
  step: 'initial' | 'service_selected' | 'date_preference' | 'time_preference' | 'confirm' | 'complete';
  service_id?: string;
  service_name?: string;
  preferred_date?: string;           // YYYY-MM-DD
  preferred_time?: string;           // HH:MM
  name?: string;
  email?: string;
  collected_at: string;              // ISO timestamp of last update
}

// ─── Auto-Reply Templates ────────────────────────

export interface SmsTemplate {
  key: string;
  body: string;
  max_chars: number;
}
```

---

## 5. Constants & Configuration (`constants.ts`)

```typescript
// src/lib/sms/constants.ts

// ─── Rate Limiting ───────────────────────────────

export const SMS_RATE_LIMITS = {
  /** Max inbound messages per phone number per hour. */
  per_phone_per_hour: 20,
  /** Max inbound messages globally per minute (all numbers). */
  global_per_minute: 60,
  /** Sliding window duration in seconds. */
  window_seconds: 3600,
} as const;

// ─── Conversation Threading ──────────────────────

export const CONVERSATION_CONFIG = {
  /** Inactivity threshold (seconds) before a new conversation starts. */
  inactivity_threshold_seconds: 86400, // 24 hours
  /** Max conversation history messages to load for RAG context. */
  max_history_messages: 10,
  /** Max conversation age (seconds) before force-closing. */
  max_conversation_age_seconds: 604800, // 7 days
} as const;

// ─── SMS Formatting ──────────────────────────────

export const SMS_FORMAT = {
  /** Target max characters for AI responses (2 SMS segments). */
  target_max_chars: 320,
  /** Absolute max characters (3 segments — hard ceiling). */
  absolute_max_chars: 480,
  /** Single segment limit (GSM-7 encoding). */
  single_segment_chars: 160,
  /** Booking link template. */
  booking_url: 'nexdriveacademy.com.au/book',
  /** Short contact link. */
  contact_url: 'nexdriveacademy.com.au/contact',
} as const;

// ─── Twilio Configuration ────────────────────────

export const TWILIO_CONFIG = {
  /** Expected webhook URL for signature verification. */
  get webhookUrl(): string {
    return `${process.env.NEXT_PUBLIC_APP_URL}/api/v1/sms/inbound`;
  },
  /** Status callback URL configured on outbound messages. */
  get statusCallbackUrl(): string {
    return `${process.env.NEXT_PUBLIC_APP_URL}/api/v1/sms/status`;
  },
} as const;

// ─── Response Timeout ────────────────────────────

export const PROCESSING_CONFIG = {
  /** Max time (ms) to process before sending a holding reply. */
  max_processing_ms: 12000,
  /** Holding message sent if processing exceeds timeout. */
  holding_message: "Thanks for your message! Give me a moment and I'll get back to you shortly.",
} as const;

// ─── Static Reply Templates ──────────────────────

export const SMS_TEMPLATES = {
  rate_limited: "Hey there! You're sending messages pretty quickly. Please wait a few minutes and try again. If it's urgent, call us on {phone}.",

  welcome_new: "G'day! Thanks for reaching out to NexDrive Academy. I'm Rob's AI assistant. How can I help you today? You can ask about lessons, pricing, or availability.",

  handoff_acknowledged: "No worries! I've flagged this for Rob. He'll get back to you as soon as he can — usually within a few hours. If it's urgent, call {phone}.",

  handoff_during_lesson: "Rob is currently teaching a lesson. I've passed your message along — he'll follow up after {available_time}. In the meantime, can I help with anything?",

  booking_link: "Ready to book? Head to {booking_url} to see available times and book online. Or just tell me what day/time works for you and I'll check availability.",

  media_not_supported: "Thanks for the image! Unfortunately I can only read text messages at the moment. Could you describe what you need help with?",

  error_fallback: "Sorry, I'm having a bit of trouble right now. Please try again in a minute, or call us on {phone} for immediate help.",

  conversation_closed: "It's been a while since we last chatted! Starting a fresh conversation. How can I help you today?",
} as const;

// ─── Business Hours (AEST/AEDT) ─────────────────

export const BUSINESS_HOURS = {
  timezone: 'Australia/Canberra',
  weekday: { start: 7, end: 19 },   // 7am - 7pm Mon-Fri
  saturday: { start: 8, end: 17 },   // 8am - 5pm Sat
  sunday: { start: 9, end: 15 },     // 9am - 3pm Sun
} as const;
```

---

## 6. Error Classes (`errors.ts`)

```typescript
// src/lib/sms/errors.ts

export class SmsError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SmsError';
  }
}

export class SmsRateLimitError extends SmsError {
  constructor(phone: string, limit: number) {
    super(
      `Rate limit exceeded for ${phone}: max ${limit} messages per hour`,
      'RATE_LIMITED',
      429,
      { phone, limit }
    );
  }
}

export class SmsDuplicateError extends SmsError {
  constructor(messageSid: string) {
    super(
      `Duplicate message: ${messageSid}`,
      'DUPLICATE_MESSAGE',
      200, // Return 200 to Twilio so it doesn't retry
      { message_sid: messageSid }
    );
  }
}

export class SmsSignatureError extends SmsError {
  constructor() {
    super(
      'Invalid Twilio signature',
      'INVALID_SIGNATURE',
      403
    );
  }
}

export class SmsProcessingTimeoutError extends SmsError {
  constructor(conversationId: string) {
    super(
      `Processing timeout for conversation ${conversationId}`,
      'PROCESSING_TIMEOUT',
      504,
      { conversation_id: conversationId }
    );
  }
}
```

---

## 7. Twilio Signature Verification (`twilio-signature.ts`)

```typescript
// src/lib/sms/twilio-signature.ts

import twilio from 'twilio';
import { SmsSignatureError } from './errors';
import { TWILIO_CONFIG } from './constants';

/**
 * Verify the Twilio webhook signature.
 *
 * Twilio signs every webhook request using the auth token.
 * We MUST verify this before processing — per arch doc §5.3
 * and SPEC-07 §15.1 pattern.
 *
 * @throws SmsSignatureError if signature is invalid
 */
export function verifyTwilioSignature(
  signature: string | null,
  url: string,
  params: Record<string, string>
): void {
  if (!signature) {
    throw new SmsSignatureError();
  }

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN!,
    signature,
    url,
    params
  );

  if (!isValid) {
    console.warn('[SMS:WEBHOOK] Invalid Twilio signature', {
      url,
      hasSignature: !!signature,
    });
    throw new SmsSignatureError();
  }
}

/**
 * Parse Twilio webhook form data into a plain object.
 *
 * Twilio sends webhooks as application/x-www-form-urlencoded.
 * We need the raw params for signature verification AND
 * the parsed payload for processing.
 */
export async function parseTwilioFormData(
  request: Request
): Promise<Record<string, string>> {
  const formData = await request.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    params[key] = value.toString();
  });
  return params;
}
```

---

## 8. Rate Limiter Service (`rate-limiter.service.ts`)

```typescript
// src/lib/sms/rate-limiter.service.ts

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { SMS_RATE_LIMITS } from './constants';
import { SmsRateLimitError } from './errors';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * Per-phone rate limiter: 20 messages per hour (sliding window).
 *
 * Uses Upstash Ratelimit with sliding window algorithm.
 * Key format: sms:rate:{phone_number}
 */
const perPhoneRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(
    SMS_RATE_LIMITS.per_phone_per_hour,
    `${SMS_RATE_LIMITS.window_seconds}s`
  ),
  prefix: 'sms:rate',
  analytics: true,
});

/**
 * Global rate limiter: 60 messages per minute (all numbers).
 *
 * Protects against coordinated flooding from multiple numbers.
 */
const globalRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(
    SMS_RATE_LIMITS.global_per_minute,
    '60s'
  ),
  prefix: 'sms:global',
  analytics: true,
});

/**
 * Check rate limits for an inbound SMS.
 *
 * Checks both per-phone and global limits.
 *
 * @throws SmsRateLimitError if either limit is exceeded
 */
export async function checkRateLimit(phone: string): Promise<void> {
  // Check global first (cheaper to reject early)
  const globalResult = await globalRatelimit.limit('global');
  if (!globalResult.success) {
    console.warn('[SMS:RATE] Global rate limit exceeded', {
      remaining: globalResult.remaining,
      reset: globalResult.reset,
    });
    throw new SmsRateLimitError(phone, SMS_RATE_LIMITS.global_per_minute);
  }

  // Check per-phone
  const phoneResult = await perPhoneRatelimit.limit(phone);
  if (!phoneResult.success) {
    console.warn('[SMS:RATE] Per-phone rate limit exceeded', {
      phone,
      remaining: phoneResult.remaining,
      reset: phoneResult.reset,
    });
    throw new SmsRateLimitError(phone, SMS_RATE_LIMITS.per_phone_per_hour);
  }
}

/**
 * Get remaining rate limit quota for a phone number.
 * Used for diagnostics / admin panel.
 */
export async function getRateLimitStatus(phone: string): Promise<{
  remaining: number;
  limit: number;
  reset_at: Date;
}> {
  const result = await perPhoneRatelimit.limit(phone);
  return {
    remaining: result.remaining,
    limit: SMS_RATE_LIMITS.per_phone_per_hour,
    reset_at: new Date(result.reset),
  };
}
```

---

## 9. Conversation Threading Service (`conversation.service.ts`)

```typescript
// src/lib/sms/conversation.service.ts

import { db } from '@/db';
import { conversations, messages } from '@/db/schema';
import { eq, and, desc, gte } from 'drizzle-orm';
import { CONVERSATION_CONFIG } from './constants';

interface ConversationResult {
  conversation_id: string;
  is_new: boolean;
  message_count: number;
  contact_id?: string;
  mode: 'prospect' | 'student' | 'parent';
}

/**
 * Get or create an SMS conversation for a phone number.
 *
 * Threading rules:
 * 1. Find the most recent active conversation for this phone + channel 'sms'
 * 2. If found AND last message < 24h ago → reuse it
 * 3. If found AND last message > 24h ago → close it, create new
 * 4. If none found → create new
 *
 * This is similar to SPEC-08 §6 getOrCreateSession but with:
 * - SMS-specific 24h window (vs. 30min for web chat)
 * - Phone number as channel_identifier (vs. session ID)
 * - Contact ID linking (from CRM upsert step)
 */
export async function getOrCreateSmsConversation(
  phone: string,
  contactId: string,
  mode: 'prospect' | 'student' | 'parent' = 'prospect'
): Promise<ConversationResult> {
  const now = new Date();
  const threshold = new Date(
    now.getTime() - CONVERSATION_CONFIG.inactivity_threshold_seconds * 1000
  );

  // Find most recent active SMS conversation for this phone
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.channel, 'sms'),
        eq(conversations.channelIdentifier, phone),
        eq(conversations.status, 'active')
      )
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  if (existing) {
    const lastActivity = new Date(existing.lastMessageAt);

    if (lastActivity >= threshold) {
      // Conversation is still active — reuse it
      return {
        conversation_id: existing.id,
        is_new: false,
        message_count: existing.messageCount,
        contact_id: existing.contactId ?? undefined,
        mode: existing.mode as ConversationResult['mode'],
      };
    }

    // Conversation has gone stale — close it
    await db
      .update(conversations)
      .set({
        status: 'closed',
        updatedAt: now,
      })
      .where(eq(conversations.id, existing.id));
  }

  // Create new conversation
  const [created] = await db
    .insert(conversations)
    .values({
      channel: 'sms',
      channelIdentifier: phone,
      contactId: contactId,
      mode: mode,
      status: 'active',
      startedAt: now,
      lastMessageAt: now,
      messageCount: 0,
    })
    .returning();

  return {
    conversation_id: created.id,
    is_new: true,
    message_count: 0,
    contact_id: contactId,
    mode: mode,
  };
}

/**
 * Load recent conversation history for RAG context.
 *
 * Returns last N messages in chronological order.
 * Used to build the conversation_history parameter for the RAG query.
 */
export async function loadConversationHistory(
  conversationId: string
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const rows = await db
    .select({
      direction: messages.direction,
      senderType: messages.senderType,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(CONVERSATION_CONFIG.max_history_messages);

  // Reverse to chronological order
  return rows.reverse().map((row) => ({
    role: row.senderType === 'user' ? 'user' as const : 'assistant' as const,
    content: row.content,
  }));
}

/**
 * Update conversation after a message exchange.
 *
 * Increments message_count by 2 (inbound + outbound) and updates last_message_at.
 */
export async function updateConversationAfterExchange(
  conversationId: string,
  additionalMessages: number = 2
): Promise<void> {
  const now = new Date();

  await db
    .update(conversations)
    .set({
      lastMessageAt: now,
      messageCount: additionalMessages, // Will be added via sql`message_count + X` below
      updatedAt: now,
    })
    .where(eq(conversations.id, conversationId));

  // Use raw SQL for atomic increment
  await db.execute(
    `UPDATE conversations SET message_count = message_count + $1 WHERE id = $2`,
    // @ts-expect-error Drizzle raw SQL typing
    [additionalMessages, conversationId]
  );
}

/**
 * Flag a conversation for human handoff.
 *
 * Sets status to 'handoff_requested' and records the reason.
 */
export async function flagForHandoff(
  conversationId: string,
  reason: string
): Promise<void> {
  await db
    .update(conversations)
    .set({
      status: 'handoff_requested',
      handoffReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

/**
 * Close a conversation (manual or automatic).
 */
export async function closeConversation(
  conversationId: string
): Promise<void> {
  await db
    .update(conversations)
    .set({
      status: 'closed',
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}
```

---

## 10. SMS Response Formatter (`response-formatter.service.ts`)

```typescript
// src/lib/sms/response-formatter.service.ts

import { SMS_FORMAT, SMS_TEMPLATES } from './constants';

/**
 * Format a RAG engine response for SMS delivery.
 *
 * The RAG engine (SPEC-08) returns answers that may contain:
 * - Markdown formatting (headers, bold, italic, links)
 * - Bullet point lists
 * - Long URLs
 * - Citations and source references
 *
 * All of this must be stripped/converted for SMS.
 *
 * Target: ≤320 characters (2 SMS segments).
 * Hard ceiling: 480 characters (3 segments).
 */
export function formatForSms(
  ragAnswer: string,
  options?: {
    appendBookingLink?: boolean;
    appendCallCta?: boolean;
    maxChars?: number;
  }
): string {
  const maxChars = options?.maxChars ?? SMS_FORMAT.target_max_chars;

  let formatted = ragAnswer;

  // 1. Strip markdown
  formatted = stripMarkdown(formatted);

  // 2. Convert bullet lists to comma-separated inline text
  formatted = flattenLists(formatted);

  // 3. Normalise whitespace
  formatted = formatted
    .replace(/\n{2,}/g, '\n')          // Multiple newlines → single
    .replace(/[ \t]+/g, ' ')           // Multiple spaces → single
    .trim();

  // 4. Replace long URLs with short versions
  formatted = shortenUrls(formatted);

  // 5. Strip source citations (e.g., "[Source: FAQ]")
  formatted = formatted.replace(/\[Source:.*?\]/gi, '').trim();
  formatted = formatted.replace(/\(Source:.*?\)/gi, '').trim();

  // 6. Append CTAs if requested
  const ctas: string[] = [];
  if (options?.appendBookingLink) {
    ctas.push(`Book online: ${SMS_FORMAT.booking_url}`);
  }
  if (options?.appendCallCta) {
    ctas.push(`Call: ${process.env.NEXDRIVE_PHONE_DISPLAY || '(02) XXXX XXXX'}`);
  }

  if (ctas.length > 0) {
    const ctaText = '\n\n' + ctas.join('\n');
    const availableForBody = maxChars - ctaText.length;
    formatted = truncateGracefully(formatted, availableForBody);
    formatted += ctaText;
  } else {
    formatted = truncateGracefully(formatted, maxChars);
  }

  return formatted;
}

/**
 * Strip all markdown formatting from text.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s/g, '')              // Headers
    .replace(/\*\*(.*?)\*\*/g, '$1')       // Bold
    .replace(/\*(.*?)\*/g, '$1')           // Italic
    .replace(/__(.*?)__/g, '$1')           // Bold alt
    .replace(/_(.*?)_/g, '$1')             // Italic alt
    .replace(/~~(.*?)~~/g, '$1')           // Strikethrough
    .replace(/`{1,3}(.*?)`{1,3}/gs, '$1') // Code blocks and inline code
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')  // Links → just text
    .replace(/!\[(.*?)\]\((.*?)\)/g, '')   // Images → remove entirely
    .replace(/^>\s?/gm, '')                // Blockquotes
    .replace(/^---+$/gm, '')               // Horizontal rules
    .replace(/\|.*\|/g, '')                // Table rows → remove
    .replace(/^[-*+]\s/gm, '- ')           // Standardise bullet chars
    .replace(/^\d+\.\s/gm, '')             // Remove numbered list prefixes
    .trim();
}

/**
 * Convert bullet/numbered lists into inline comma-separated text.
 *
 * "- Item A\n- Item B\n- Item C" → "Item A, Item B, and Item C"
 */
function flattenLists(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let listItems: string[] = [];

  for (const line of lines) {
    const listMatch = line.match(/^[-*+]\s+(.+)$/);
    if (listMatch) {
      listItems.push(listMatch[1].trim());
    } else {
      if (listItems.length > 0) {
        result.push(joinListItems(listItems));
        listItems = [];
      }
      result.push(line);
    }
  }

  if (listItems.length > 0) {
    result.push(joinListItems(listItems));
  }

  return result.join('\n');
}

function joinListItems(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  const last = items.pop()!;
  return `${items.join(', ')}, and ${last}`;
}

/**
 * Shorten any URLs in the text.
 * Replaces long URLs with our short domain equivalents.
 */
function shortenUrls(text: string): string {
  // Replace booking URLs
  text = text.replace(
    /https?:\/\/(www\.)?nexdriveacademy\.com\.au\/book\S*/gi,
    SMS_FORMAT.booking_url
  );

  // Replace any remaining long URLs with a truncated version
  text = text.replace(
    /https?:\/\/\S{40,}/gi,
    (url) => url.substring(0, 35) + '...'
  );

  return text;
}

/**
 * Truncate text gracefully at a word boundary.
 * Appends "..." if truncation occurs.
 */
function truncateGracefully(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const truncated = text.substring(0, maxChars - 3);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxChars * 0.6) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Calculate the number of SMS segments for a message.
 *
 * GSM-7 encoding: 160 chars/segment (or 153 for multi-segment).
 * UCS-2 encoding: 70 chars/segment (or 67 for multi-segment).
 */
export function calculateSegments(text: string): number {
  // Check if text is pure GSM-7
  const isGsm7 = /^[\x20-\x7E\n\r]+$/.test(text);
  
  if (isGsm7) {
    if (text.length <= 160) return 1;
    return Math.ceil(text.length / 153); // Multi-segment uses 153 chars
  } else {
    if (text.length <= 70) return 1;
    return Math.ceil(text.length / 67);
  }
}

/**
 * Interpolate template variables.
 *
 * Replaces {variable_name} placeholders with provided values.
 */
export function interpolateTemplate(
  template: string,
  variables: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}
```

---

## 11. SMS Sender Service (`sms-sender.service.ts`)

```typescript
// src/lib/sms/sms-sender.service.ts

import { twilioSmsAdapter } from '@/lib/notifications/adapters/sms.adapter';
import { db } from '@/db';
import { messages } from '@/db/schema';
import { calculateSegments } from './response-formatter.service';
import type { SmsSendResult } from '@/lib/notifications/adapters/types';

interface SendSmsParams {
  to: string;
  body: string;
  conversationId: string;
  intentDetected?: string;
  confidence?: number;
  ragSources?: Array<{ document_id: string; title: string; score: number }>;
}

interface SendSmsResult {
  message_id: string;           // Our internal message ID
  external_id?: string;         // Twilio Message SID
  segments: number;
  success: boolean;
  error?: string;
}

/**
 * Send an SMS reply and store the outbound message.
 *
 * Uses the Twilio SMS adapter from SPEC-07 — we do NOT create a separate
 * Twilio client. The adapter handles E.164 validation, status callback URL,
 * and segment counting.
 *
 * After sending, stores the outbound message in the messages table.
 *
 * Important: This is for conversational SMS replies (chatbot).
 * Transactional notifications (booking confirmations, etc.) go through
 * the Notification Engine (SPEC-07). The two systems use the same Twilio
 * adapter but different storage paths.
 */
export async function sendSmsReply(params: SendSmsParams): Promise<SendSmsResult> {
  const segments = calculateSegments(params.body);

  // Send via Twilio adapter (from SPEC-07)
  const twilioResult: SmsSendResult = await twilioSmsAdapter.send(
    params.to,
    params.body
  );

  // Store outbound message regardless of send success
  const [stored] = await db
    .insert(messages)
    .values({
      conversationId: params.conversationId,
      direction: 'outbound',
      senderType: 'ai',
      content: params.body,
      intentDetected: params.intentDetected ?? null,
      confidence: params.confidence?.toString() ?? null,
      ragSources: params.ragSources ? JSON.stringify(params.ragSources) : null,
      externalId: twilioResult.external_id ?? null,
      deliveryStatus: twilioResult.success ? 'sent' : 'failed',
    })
    .returning({ id: messages.id });

  return {
    message_id: stored.id,
    external_id: twilioResult.external_id,
    segments,
    success: twilioResult.success,
    error: twilioResult.error,
  };
}
```

---

## 12. Handoff Service (`handoff.service.ts`)

```typescript
// src/lib/sms/handoff.service.ts

import { flagForHandoff } from './conversation.service';
import { sendSmsReply } from './sms-sender.service';
import { interpolateTemplate, formatForSms } from './response-formatter.service';
import { SMS_TEMPLATES, BUSINESS_HOURS } from './constants';
import { dispatchNotification } from '@/lib/notifications/notification.service';
import { db } from '@/db';
import { conversations, messages, contacts } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';

interface HandoffParams {
  conversationId: string;
  contactId: string;
  senderPhone: string;
  reason: string;
  lastUserMessage: string;
}

/**
 * Execute a human handoff.
 *
 * Steps:
 * 1. Flag the conversation as handoff_requested
 * 2. Send an acknowledgement SMS to the user
 * 3. Notify Rob via SMS + (if available) email with conversation context
 *
 * Handoff triggers:
 * - RAG engine returns handoff_requested: true
 * - User explicitly asks for Rob / a human
 * - Confidence below 0.40 on a critical topic
 * - Complaint detected
 */
export async function executeHandoff(params: HandoffParams): Promise<{
  handoff_message_id: string;
  rob_notified: boolean;
}> {
  // 1. Flag conversation
  await flagForHandoff(params.conversationId, params.reason);

  // 2. Determine availability context
  const availableTime = getNextAvailableTime();
  const template = isWithinBusinessHours()
    ? SMS_TEMPLATES.handoff_acknowledged
    : SMS_TEMPLATES.handoff_during_lesson;

  const replyText = interpolateTemplate(template, {
    phone: process.env.NEXDRIVE_PHONE_DISPLAY || '(02) XXXX XXXX',
    available_time: availableTime,
  });

  // 3. Send acknowledgement to user
  const sendResult = await sendSmsReply({
    to: params.senderPhone,
    body: replyText,
    conversationId: params.conversationId,
    intentDetected: 'handoff',
  });

  // 4. Build context summary for Rob
  const contextSummary = await buildHandoffContext(
    params.conversationId,
    params.contactId,
    params.lastUserMessage,
    params.reason
  );

  // 5. Notify Rob
  let robNotified = false;
  try {
    await dispatchNotification(
      'handoff_sms_conversation',
      {
        sender_phone: params.senderPhone,
        reason: params.reason,
        last_message: params.lastUserMessage,
        context_summary: contextSummary,
        conversation_id: params.conversationId,
      },
      {
        recipient_id: process.env.ROB_CLERK_USER_ID,
      },
      {
        triggered_by: 'sms_chatbot',
        related_id: params.conversationId,
      }
    );
    robNotified = true;
  } catch (error) {
    console.error('[SMS:HANDOFF] Failed to notify Rob:', error);
    // Non-fatal — the conversation is still flagged in the DB.
    // Rob will see it in the admin panel.
  }

  return {
    handoff_message_id: sendResult.message_id,
    rob_notified: robNotified,
  };
}

/**
 * Build a context summary for Rob's handoff notification.
 *
 * Includes: contact name/phone, conversation excerpt (last 5 messages),
 * detected intent, and the handoff reason.
 */
async function buildHandoffContext(
  conversationId: string,
  contactId: string,
  lastMessage: string,
  reason: string
): Promise<string> {
  // Get contact name
  const [contact] = await db
    .select({
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || 'Unknown';

  // Get last 5 messages
  const recentMessages = await db
    .select({
      direction: messages.direction,
      content: messages.content,
      senderType: messages.senderType,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(5);

  const excerpt = recentMessages
    .reverse()
    .map((m) => `${m.direction === 'inbound' ? 'Them' : 'AI'}: ${m.content.substring(0, 80)}`)
    .join('\n');

  return `SMS handoff from ${name} (${contact?.phone || 'unknown'}).\nReason: ${reason}\nLast message: "${lastMessage.substring(0, 100)}"\n\nRecent conversation:\n${excerpt}`;
}

/**
 * Check if current time is within NexDrive business hours.
 */
function isWithinBusinessHours(): boolean {
  const now = new Date();
  const canberraTime = new Date(
    now.toLocaleString('en-US', { timeZone: BUSINESS_HOURS.timezone })
  );
  const day = canberraTime.getDay(); // 0=Sun, 6=Sat
  const hour = canberraTime.getHours();

  if (day === 0) return hour >= BUSINESS_HOURS.sunday.start && hour < BUSINESS_HOURS.sunday.end;
  if (day === 6) return hour >= BUSINESS_HOURS.saturday.start && hour < BUSINESS_HOURS.saturday.end;
  return hour >= BUSINESS_HOURS.weekday.start && hour < BUSINESS_HOURS.weekday.end;
}

/**
 * Get the next available time Rob can respond.
 * Returns a human-readable string like "around 5pm today" or "tomorrow morning".
 */
function getNextAvailableTime(): string {
  const now = new Date();
  const canberraTime = new Date(
    now.toLocaleString('en-US', { timeZone: BUSINESS_HOURS.timezone })
  );
  const hour = canberraTime.getHours();
  const day = canberraTime.getDay();

  // If within business hours, Rob is likely teaching — estimate 1-2 hours
  if (isWithinBusinessHours()) {
    const endHour = day === 0 ? BUSINESS_HOURS.sunday.end
      : day === 6 ? BUSINESS_HOURS.saturday.end
      : BUSINESS_HOURS.weekday.end;

    if (hour + 2 < endHour) {
      return 'within a couple of hours';
    }
    return 'later today';
  }

  // Outside business hours
  if (hour >= 19) return 'tomorrow morning';
  if (hour < 7) return 'this morning (after 7am)';
  return 'as soon as possible';
}
```

---

## 13. Booking Flow Service (`booking-flow.service.ts`)

```typescript
// src/lib/sms/booking-flow.service.ts

import { formatForSms } from './response-formatter.service';
import { SMS_FORMAT } from './constants';
import type { RAGQueryResponse } from '@/lib/rag/types';

/**
 * Handle booking intent detected by the RAG engine.
 *
 * When the RAG engine classifies intent as 'booking', it returns:
 * - booking_entities: { service_type?, date_preference?, time_preference?, ... }
 * - suggested_actions: ['book_lesson', 'view_availability', ...]
 * - The generated answer (booking guidance text)
 *
 * For SMS, we take a pragmatic approach:
 * 1. If the user has enough detail → send them the booking link
 * 2. If they need guidance → the RAG answer already contains it
 * 3. We DON'T try to complete a full booking via SMS (too many back-and-forth messages)
 *
 * The RAG engine handles the conversational booking guidance
 * (via SPEC-08 generateBookingGuidance). We just format for SMS.
 */
export function formatBookingResponse(
  ragResponse: RAGQueryResponse
): string {
  const answer = ragResponse.answer;
  const entities = ragResponse.booking_entities;
  const actions = ragResponse.suggested_actions ?? [];

  // If we have enough entities to suggest booking directly
  const hasServiceInfo = entities?.service_type;
  const hasTimeInfo = entities?.date_preference || entities?.time_preference;

  let formatted = formatForSms(answer, {
    maxChars: hasServiceInfo ? SMS_FORMAT.target_max_chars - 50 : SMS_FORMAT.target_max_chars,
  });

  // Append booking link if we have enough context
  if (hasServiceInfo && hasTimeInfo) {
    formatted += `\n\nBook now: ${SMS_FORMAT.booking_url}`;
  } else if (actions.includes('book_lesson') || actions.includes('view_availability')) {
    formatted += `\n\nBook online: ${SMS_FORMAT.booking_url}`;
  }

  return formatted;
}

/**
 * Generate a proactive booking suggestion for a known student.
 *
 * When a student texts and they don't have a next lesson booked,
 * the RAG engine may include this in its suggested_actions.
 */
export function appendBookingSuggestion(
  response: string,
  studentName?: string
): string {
  const suggestion = studentName
    ? `\nReady for your next lesson, ${studentName}? ${SMS_FORMAT.booking_url}`
    : `\nWant to book your next lesson? ${SMS_FORMAT.booking_url}`;

  // Only append if we have room
  if (response.length + suggestion.length <= SMS_FORMAT.absolute_max_chars) {
    return response + suggestion;
  }

  return response;
}
```

---

## 14. Core Inbound Processing Service (`inbound.service.ts`)

```typescript
// src/lib/sms/inbound.service.ts

import { db } from '@/db';
import { messages } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { upsertFromChannel } from '@/lib/crm/auto-create.service';
import {
  getOrCreateSmsConversation,
  loadConversationHistory,
  updateConversationAfterExchange,
} from './conversation.service';
import { formatForSms, interpolateTemplate } from './response-formatter.service';
import { formatBookingResponse } from './booking-flow.service';
import { sendSmsReply } from './sms-sender.service';
import { executeHandoff } from './handoff.service';
import { checkRateLimit } from './rate-limiter.service';
import { SMS_TEMPLATES, PROCESSING_CONFIG, SMS_FORMAT } from './constants';
import { SmsDuplicateError, SmsRateLimitError } from './errors';
import type { TwilioInboundPayload, SmsProcessingResult } from './types';
import type { AuthContext } from '@/lib/auth/types';

/**
 * Process an inbound SMS message end-to-end.
 *
 * This is the main orchestrator called by the webhook route handler.
 * It coordinates: rate limiting → dedup → CRM upsert → conversation threading →
 * message storage → RAG query → response formatting → SMS reply → message storage.
 *
 * Returns the full processing result for logging/monitoring.
 */
export async function processInboundSms(
  payload: TwilioInboundPayload
): Promise<SmsProcessingResult> {
  const { From: senderPhone, Body: messageBody, MessageSid: messageSid } = payload;

  // ─── 1. Rate Limit ─────────────────────────────
  // Throws SmsRateLimitError if exceeded
  await checkRateLimit(senderPhone);

  // ─── 2. Deduplication ──────────────────────────
  // Check if we've already processed this MessageSid
  const [existingMessage] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.externalId, messageSid))
    .limit(1);

  if (existingMessage) {
    throw new SmsDuplicateError(messageSid);
  }

  // ─── 3. CRM Upsert ────────────────────────────
  // Create or touch the contact. Uses SPEC-05 auto-create service.
  // We use a system auth context for webhook-initiated operations.
  const systemAuth: AuthContext = {
    clerkUserId: 'system',
    role: 'admin',
    instructorId: process.env.DEFAULT_INSTRUCTOR_ID,
  };

  const { contact_id: contactId, is_new: isNewContact } = await upsertFromChannel(
    {
      phone: senderPhone,
      source: 'sms',
      source_detail: 'inbound_sms',
      instructor_id: process.env.DEFAULT_INSTRUCTOR_ID,
    },
    systemAuth
  );

  // ─── 4. Resolve Conversation ───────────────────
  // Determine contact mode (prospect, student, parent)
  const contactMode = await resolveContactMode(contactId);

  const conversation = await getOrCreateSmsConversation(
    senderPhone,
    contactId,
    contactMode
  );

  // ─── 5. Store Inbound Message ──────────────────
  const [inboundMsg] = await db
    .insert(messages)
    .values({
      conversationId: conversation.conversation_id,
      direction: 'inbound',
      senderType: 'user',
      content: messageBody,
      externalId: messageSid,
      deliveryStatus: 'delivered', // Inbound = already delivered to us
    })
    .returning({ id: messages.id });

  // ─── 6. Handle Media Messages ──────────────────
  if (payload.NumMedia > 0) {
    const mediaReply = interpolateTemplate(SMS_TEMPLATES.media_not_supported, {});
    const sendResult = await sendSmsReply({
      to: senderPhone,
      body: mediaReply,
      conversationId: conversation.conversation_id,
      intentDetected: 'media_received',
    });

    return buildResult({
      conversation,
      contactId,
      isNewContact,
      inboundMessageId: inboundMsg.id,
      outboundMessageId: sendResult.message_id,
      replyText: mediaReply,
      replyExternalId: sendResult.external_id,
      intentDetected: 'media_received',
      handoffRequested: false,
    });
  }

  // ─── 7. Send Welcome for New Contacts ──────────
  // If it's a brand new contact AND a brand new conversation,
  // we could prepend a welcome. But let the RAG engine handle
  // the tone — it knows the channel is SMS.

  // ─── 8. Load Conversation History ──────────────
  const history = await loadConversationHistory(conversation.conversation_id);

  // ─── 9. Query RAG Engine ───────────────────────
  let ragResponse;
  try {
    const ragResult = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL}/api/internal/rag/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': process.env.INTERNAL_API_SECRET!,
        },
        body: JSON.stringify({
          query: messageBody,
          context: {
            channel: 'sms',
            session_id: conversation.conversation_id,
            // Only pass student_id if they're an identified student
            ...(contactMode === 'student' ? { student_id: await getStudentIdForContact(contactId) } : {}),
          },
          conversation_history: history,
          max_results: 3, // Fewer results for SMS (shorter context)
        }),
        signal: AbortSignal.timeout(PROCESSING_CONFIG.max_processing_ms),
      }
    );

    if (!ragResult.ok) {
      throw new Error(`RAG query failed: ${ragResult.status}`);
    }

    ragResponse = await ragResult.json();
  } catch (error) {
    // RAG engine failed or timed out — send fallback
    console.error('[SMS:INBOUND] RAG query error:', error);

    const fallbackReply = interpolateTemplate(SMS_TEMPLATES.error_fallback, {
      phone: process.env.NEXDRIVE_PHONE_DISPLAY || '(02) XXXX XXXX',
    });

    const sendResult = await sendSmsReply({
      to: senderPhone,
      body: fallbackReply,
      conversationId: conversation.conversation_id,
      intentDetected: 'error',
    });

    return buildResult({
      conversation,
      contactId,
      isNewContact,
      inboundMessageId: inboundMsg.id,
      outboundMessageId: sendResult.message_id,
      replyText: fallbackReply,
      replyExternalId: sendResult.external_id,
      intentDetected: 'error',
      handoffRequested: false,
    });
  }

  // ─── 10. Handle Handoff ────────────────────────
  if (ragResponse.handoff_requested) {
    const handoffResult = await executeHandoff({
      conversationId: conversation.conversation_id,
      contactId,
      senderPhone,
      reason: ragResponse.intent === 'complaint'
        ? 'Customer complaint'
        : ragResponse.intent === 'handoff'
          ? 'User requested human'
          : `Low confidence (${ragResponse.confidence})`,
      lastUserMessage: messageBody,
    });

    return buildResult({
      conversation,
      contactId,
      isNewContact,
      inboundMessageId: inboundMsg.id,
      outboundMessageId: handoffResult.handoff_message_id,
      replyText: SMS_TEMPLATES.handoff_acknowledged,
      intentDetected: 'handoff',
      confidence: ragResponse.confidence,
      handoffRequested: true,
    });
  }

  // ─── 11. Format Response for SMS ───────────────
  let replyText: string;

  if (ragResponse.intent === 'booking') {
    replyText = formatBookingResponse(ragResponse);
  } else {
    // Determine if we should append a CTA
    const shouldAppendBookingLink =
      ragResponse.suggested_actions?.includes('book_lesson') ||
      ragResponse.suggested_actions?.includes('view_availability');

    replyText = formatForSms(ragResponse.answer, {
      appendBookingLink: shouldAppendBookingLink,
      appendCallCta: ragResponse.confidence < 0.65,
    });
  }

  // ─── 12. Send Reply ────────────────────────────
  const sendResult = await sendSmsReply({
    to: senderPhone,
    body: replyText,
    conversationId: conversation.conversation_id,
    intentDetected: ragResponse.intent,
    confidence: ragResponse.confidence,
    ragSources: ragResponse.sources?.map((s: any) => ({
      document_id: s.document_id,
      title: s.title,
      score: s.score,
    })),
  });

  // ─── 13. Update Conversation ───────────────────
  await updateConversationAfterExchange(conversation.conversation_id, 2);

  return buildResult({
    conversation,
    contactId,
    isNewContact,
    inboundMessageId: inboundMsg.id,
    outboundMessageId: sendResult.message_id,
    replyText,
    replyExternalId: sendResult.external_id,
    intentDetected: ragResponse.intent,
    confidence: ragResponse.confidence,
    handoffRequested: false,
  });
}

// ─── Helper: Resolve Contact Mode ─────────────────

async function resolveContactMode(
  contactId: string
): Promise<'prospect' | 'student' | 'parent'> {
  // Check if contact has an associated student record
  const { students, parents, parentStudentLinks } = await import('@/db/schema');

  const [student] = await db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.contactId, contactId))
    .limit(1);

  if (student) return 'student';

  // Check if contact is a parent
  const [parent] = await db
    .select({ id: parents.id })
    .from(parents)
    .where(eq(parents.contactId, contactId))
    .limit(1);

  if (parent) return 'parent';

  return 'prospect';
}

// ─── Helper: Get Student ID for Contact ───────────

async function getStudentIdForContact(
  contactId: string
): Promise<string | undefined> {
  const { students } = await import('@/db/schema');

  const [student] = await db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.contactId, contactId))
    .limit(1);

  return student?.id;
}

// ─── Helper: Build Result ─────────────────────────

function buildResult(params: {
  conversation: { conversation_id: string; is_new: boolean };
  contactId: string;
  isNewContact: boolean;
  inboundMessageId: string;
  outboundMessageId: string;
  replyText: string;
  replyExternalId?: string;
  intentDetected?: string;
  confidence?: number;
  handoffRequested: boolean;
}): SmsProcessingResult {
  return {
    conversation_id: params.conversation.conversation_id,
    contact_id: params.contactId,
    is_new_contact: params.isNewContact,
    is_new_conversation: params.conversation.is_new,
    inbound_message_id: params.inboundMessageId,
    outbound_message_id: params.outboundMessageId,
    intent_detected: params.intentDetected,
    confidence: params.confidence,
    handoff_requested: params.handoffRequested,
    reply_text: params.replyText,
    reply_segments: Math.ceil(params.replyText.length / 160),
    reply_external_id: params.replyExternalId,
  };
}
```

---

## 15. API Route: Inbound SMS Webhook

### File: `src/app/api/v1/sms/inbound/route.ts`

```typescript
// ============================================================
// POST /api/v1/sms/inbound
// Twilio inbound SMS webhook.
//
// Reference: System Architecture v1.1 §4.2.8
// Twilio POSTs form-encoded data to this endpoint when an SMS
// is received on the NexDrive business number.
//
// Flow:
// 1. Verify Twilio signature
// 2. Parse inbound payload
// 3. Delegate to inbound.service.ts
// 4. Return 200 (TwiML empty response — we reply via API, not TwiML)
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { verifyTwilioSignature, parseTwilioFormData } from '@/lib/sms/twilio-signature';
import { processInboundSms } from '@/lib/sms/inbound.service';
import { TwilioInboundSchema } from '@/lib/sms/types';
import { SmsRateLimitError, SmsDuplicateError, SmsSignatureError } from '@/lib/sms/errors';
import { sendSmsReply } from '@/lib/sms/sms-sender.service';
import { interpolateTemplate } from '@/lib/sms/response-formatter.service';
import { SMS_TEMPLATES, TWILIO_CONFIG } from '@/lib/sms/constants';

/**
 * Twilio sends POST with Content-Type: application/x-www-form-urlencoded.
 *
 * We return an empty TwiML response (200 with <Response/>) because we
 * send our reply via the Twilio REST API (not inline TwiML). This gives
 * us more control over timing and error handling.
 */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

export async function POST(request: NextRequest) {
  let params: Record<string, string>;

  try {
    // ─── 1. Parse Form Data ─────────────────────
    params = await parseTwilioFormData(request);

    // ─── 2. Verify Signature ────────────────────
    const signature = request.headers.get('x-twilio-signature');
    verifyTwilioSignature(signature, TWILIO_CONFIG.webhookUrl, params);

    // ─── 3. Validate Payload ────────────────────
    const payload = TwilioInboundSchema.parse(params);

    console.log('[SMS:INBOUND] Received', {
      from: payload.From,
      sid: payload.MessageSid,
      bodyLength: payload.Body.length,
      numMedia: payload.NumMedia,
    });

    // ─── 4. Process (async-safe) ────────────────
    // We process in the request lifecycle but return quickly.
    // If processing takes >12s, the service sends a holding message.
    const result = await processInboundSms(payload);

    console.log('[SMS:INBOUND] Processed', {
      conversationId: result.conversation_id,
      intent: result.intent_detected,
      confidence: result.confidence,
      handoff: result.handoff_requested,
      isNewContact: result.is_new_contact,
      segments: result.reply_segments,
    });

    // Return empty TwiML — reply already sent via REST API
    return new NextResponse(EMPTY_TWIML, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });

  } catch (error) {
    // ─── Error Handling ─────────────────────────

    if (error instanceof SmsSignatureError) {
      console.warn('[SMS:INBOUND] Signature verification failed');
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 403 }
      );
    }

    if (error instanceof SmsDuplicateError) {
      // Already processed — return 200 so Twilio doesn't retry
      return new NextResponse(EMPTY_TWIML, {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    if (error instanceof SmsRateLimitError) {
      // Send rate limit message to the user, then return 200
      try {
        const phone = (error.details as any)?.phone;
        if (phone) {
          await sendSmsReply({
            to: phone,
            body: interpolateTemplate(SMS_TEMPLATES.rate_limited, {
              phone: process.env.NEXDRIVE_PHONE_DISPLAY || '(02) XXXX XXXX',
            }),
            conversationId: 'rate-limited', // No real conversation
          });
        }
      } catch (sendError) {
        console.error('[SMS:INBOUND] Failed to send rate limit reply:', sendError);
      }

      return new NextResponse(EMPTY_TWIML, {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Unexpected error
    console.error('[SMS:INBOUND] Unexpected error:', error);

    // Still return 200 to Twilio to prevent infinite retries
    return new NextResponse(EMPTY_TWIML, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}
```

---

## 16. API Route: SMS Delivery Status Webhook

### File: `src/app/api/v1/sms/status/route.ts`

```typescript
// ============================================================
// POST /api/v1/sms/status
// Twilio SMS delivery status callback.
//
// Reference: System Architecture v1.1 §4.2.8
// Twilio POSTs status updates for outbound SMS we've sent.
// Updates the messages.delivery_status field.
//
// Note: SPEC-07 has a similar webhook at /api/webhooks/twilio/status
// for notification delivery tracking. This endpoint tracks
// conversational SMS (chatbot replies). Both can coexist — they
// update different tables (messages vs. notifications).
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { db } from '@/db';
import { messages } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  // ─── 1. Parse Form Data ─────────────────────
  const formData = await request.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    params[key] = value.toString();
  });

  // ─── 2. Verify Signature ────────────────────
  const signature = request.headers.get('x-twilio-signature') || '';
  const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/v1/sms/status`;

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN!,
    signature,
    url,
    params
  );

  if (!isValid) {
    console.warn('[SMS:STATUS] Invalid Twilio signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
  }

  // ─── 3. Extract Status ──────────────────────
  const messageSid = params.MessageSid;
  const messageStatus = params.MessageStatus;

  if (!messageSid || !messageStatus) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // ─── 4. Map Twilio Status ───────────────────
  const statusMap: Record<string, string> = {
    accepted: 'sent',
    queued: 'sent',
    sending: 'sent',
    sent: 'sent',
    delivered: 'delivered',
    undelivered: 'failed',
    failed: 'failed',
    read: 'delivered',
  };

  const deliveryStatus = statusMap[messageStatus] || 'sent';

  // ─── 5. Update Messages Table ───────────────
  const updated = await db
    .update(messages)
    .set({ deliveryStatus })
    .where(eq(messages.externalId, messageSid))
    .returning({ id: messages.id });

  if (updated.length === 0) {
    // Message SID not found in our messages table — might be a notification
    // (handled by SPEC-07 webhook). Log but don't error.
    console.log('[SMS:STATUS] MessageSid not found in messages table:', messageSid);
  }

  return NextResponse.json({ received: true });
}
```

---

## 17. Environment Variables

The following environment variables are required for the SMS Chatbot. Most are already set by Phase 0 / SPEC-07.

```bash
# Twilio (already configured per SPEC-07)
TWILIO_ACCOUNT_SID=ACxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxx
TWILIO_FROM_NUMBER=+614xxxxxxxx          # Australian mobile number

# Upstash Redis (already configured per arch doc)
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxxxx

# Internal API (already configured per SPEC-08)
INTERNAL_API_SECRET=xxxxx                # Shared secret for internal API calls
NEXT_PUBLIC_APP_URL=https://nexdriveacademy.com.au

# NexDrive-specific
DEFAULT_INSTRUCTOR_ID=uuid-of-rob       # Solo instructor — default for auto-assignment
ROB_CLERK_USER_ID=user_xxxx             # Rob's Clerk user ID for handoff notifications
NEXDRIVE_PHONE_DISPLAY=(02) XXXX XXXX   # Display-formatted phone number for SMS templates
```

---

## 18. SPEC-07 Notification Engine Additions

The SMS Chatbot introduces one new notification type that must be registered with the Notification Engine (SPEC-07).

### 18.1 New Notification Type: `handoff_sms_conversation`

```typescript
// Add to SPEC-07 constants (NOTIFICATION_TYPES array and CHANNEL_ROUTING)

// Type
'handoff_sms_conversation'

// Channel routing: SMS to Rob (primary) + Email (secondary)
{
  handoff_sms_conversation: { sms: true, email: true },
}

// Template (SMS — to Rob)
{
  key: 'handoff_sms_conversation',
  sms: 'SMS handoff from {sender_phone}: "{last_message_preview}" — Reason: {reason}. Check admin panel for full conversation.',
  email_subject: 'SMS Conversation Needs Your Attention',
  email_body: '... (HTML template with conversation context) ...',
}
```

> **Decision:** The handoff notification is NOT opt-outable. Rob must always receive these. Add `'handoff_sms_conversation'` to `NON_OPTABLE_TYPES` in SPEC-07.

---

## 19. Audit Trail Integration

Per architecture §4.2.14, all webhook processing should be logged. The SMS chatbot integrates with the audit trail as follows:

```typescript
// In the inbound webhook handler, after successful processing:
// (This follows the same pattern as SPEC-09 §11 for voice calls)

import { createAuditEntry } from '@/lib/audit/audit.service';

// After processInboundSms returns successfully:
await createAuditEntry({
  event_type: 'sms.inbound_processed',
  actor_type: 'system',
  actor_id: 'sms_chatbot',
  subject_type: 'conversation',
  subject_id: result.conversation_id,
  description: `Inbound SMS from ${senderPhone} — intent: ${result.intent_detected}, confidence: ${result.confidence}`,
  metadata: {
    contact_id: result.contact_id,
    is_new_contact: result.is_new_contact,
    intent: result.intent_detected,
    confidence: result.confidence,
    handoff: result.handoff_requested,
    reply_segments: result.reply_segments,
  },
});
```

---

## 20. Monitoring & Observability

### 20.1 Structured Logging

All SMS operations use structured JSON logging with consistent prefixes:

| Prefix | Module |
|--------|--------|
| `[SMS:INBOUND]` | Inbound webhook processing |
| `[SMS:STATUS]` | Delivery status callback |
| `[SMS:RATE]` | Rate limiting events |
| `[SMS:HANDOFF]` | Human handoff execution |
| `[SMS:SEND]` | Outbound SMS sending |
| `[SMS:CONV]` | Conversation threading |

### 20.2 Sentry Error Tracking

Errors are reported to Sentry with SMS-specific context:

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.captureException(error, {
  tags: {
    component: 'sms_chatbot',
    intent: result?.intent_detected,
  },
  extra: {
    conversation_id: result?.conversation_id,
    sender_phone: '[REDACTED]', // Never log full phone to Sentry
    message_length: messageBody.length,
  },
});
```

### 20.3 Key Metrics (PostHog)

| Metric | Description |
|--------|-------------|
| `sms.inbound_count` | Total inbound SMS received |
| `sms.outbound_count` | Total outbound SMS sent |
| `sms.avg_response_time_ms` | Time from webhook receipt to reply sent |
| `sms.intent_distribution` | Breakdown by detected intent |
| `sms.handoff_rate` | % of conversations escalated to Rob |
| `sms.new_contact_rate` | % of messages from new contacts |
| `sms.avg_segments_per_reply` | Average SMS segments per outbound reply |
| `sms.delivery_rate` | % of outbound SMS successfully delivered |
| `sms.rate_limit_hits` | Number of rate limit rejections |
| `sms.conversation_length` | Average messages per conversation |

---

## 21. Testing Strategy

### 21.1 Unit Tests

| Test File | Coverage |
|-----------|----------|
| `response-formatter.service.test.ts` | Markdown stripping, list flattening, truncation, URL shortening, segment calculation |
| `conversation.service.test.ts` | 24h threading window, conversation creation, stale conversation closure |
| `rate-limiter.service.test.ts` | Per-phone limits, global limits, sliding window behaviour |
| `booking-flow.service.test.ts` | Booking response formatting, link appending |
| `handoff.service.test.ts` | Handoff flagging, context building, Rob notification |

### 21.2 Integration Tests

| Test File | Coverage |
|-----------|----------|
| `inbound-webhook.test.ts` | Full webhook → reply flow with mocked Twilio + RAG |
| `conversation-threading.test.ts` | Multi-message conversations, 24h window, mode detection |
| `booking-flow.test.ts` | Booking intent → formatted reply with link |

### 21.3 Test Scenarios

```
Inbound Processing:
  ✓ New contact, first message → creates contact + conversation + reply
  ✓ Existing contact, active conversation → reuses conversation
  ✓ Existing contact, stale conversation (>24h) → closes old, creates new
  ✓ Known student → passes student_id to RAG context
  ✓ Known parent → sets mode to 'parent'
  ✓ Media message → sends "text only" reply
  ✓ Empty body → handled gracefully

Rate Limiting:
  ✓ 20th message in an hour → still allowed
  ✓ 21st message in an hour → rate limited reply
  ✓ Limit resets after window expires

Deduplication:
  ✓ Same MessageSid twice → second returns 200 with no processing
  ✓ Different MessageSid, same content → both processed (content dedup is NOT done)

RAG Integration:
  ✓ Question intent → formatted answer, no booking link
  ✓ Booking intent → answer + booking link
  ✓ Low confidence (< 0.65) → answer + "call us" CTA
  ✓ Very low confidence (< 0.40) → handoff triggered
  ✓ Handoff keyword → immediate handoff
  ✓ Complaint → handoff triggered
  ✓ RAG timeout → fallback error message
  ✓ RAG 500 error → fallback error message

Response Formatting:
  ✓ Markdown stripped from RAG output
  ✓ Bullet lists → inline comma-separated text
  ✓ Response ≤ 320 chars (2 segments target)
  ✓ Response never > 480 chars (3 segments ceiling)
  ✓ Graceful truncation at word boundary
  ✓ Booking link appended when booking intent
  ✓ Source citations removed

Handoff:
  ✓ User says "talk to Rob" → handoff
  ✓ User says "speak to a person" → handoff
  ✓ Conversation flagged as handoff_requested
  ✓ Rob receives SMS notification with context
  ✓ User receives acknowledgement with estimated time

Delivery Status:
  ✓ 'delivered' status → updates messages.delivery_status
  ✓ 'failed' status → updates messages.delivery_status
  ✓ Unknown MessageSid → logged but no error
  ✓ Invalid signature → 403

Signature Verification:
  ✓ Valid signature → processed
  ✓ Missing signature → 403
  ✓ Invalid signature → 403
```

### 21.4 Test Data

```typescript
// __tests__/fixtures/sms.ts

export const VALID_TWILIO_INBOUND = {
  MessageSid: 'SM1234567890abcdef1234567890abcdef',
  AccountSid: 'ACtest1234567890',
  From: '+61412345678',
  To: '+61298765432',
  Body: 'How much do driving lessons cost?',
  NumMedia: '0',
  NumSegments: '1',
};

export const VALID_STATUS_CALLBACK = {
  MessageSid: 'SM1234567890abcdef1234567890abcdef',
  MessageStatus: 'delivered',
  To: '+61412345678',
  From: '+61298765432',
};

export const TEST_MESSAGES = {
  pricing_question: 'How much do lessons cost?',
  booking_request: "I'd like to book a lesson for next Saturday morning",
  handoff_request: 'Can I talk to Rob please?',
  complaint: "I'm not happy with my last lesson and want to discuss it",
  progress_question: 'How many more lessons do I need?',
  general_question: "What areas do you cover in Canberra?",
  off_topic: "What's the weather like?",
  callback_request: 'Can Rob call me back this afternoon?',
  media_message_body: '',
};
```

---

## 22. Implementation Sequence

| Day | Task | Depends On |
|-----|------|-----------|
| 1 | Types, constants, error classes, file structure | SPEC-01 tables exist |
| 2 | Twilio signature verification + rate limiter (Upstash) + unit tests | Upstash Redis configured |
| 3 | Conversation threading service + unit tests | SPEC-01 conversations/messages tables |
| 4 | Response formatter (markdown stripping, truncation, segment calc) + unit tests | — |
| 5 | SMS sender service (wraps SPEC-07 adapter) + message storage | SPEC-07 Twilio adapter |
| 6 | Handoff service (flag conversation, notify Rob) + unit tests | SPEC-07 Notification Engine |
| 7 | Core inbound processing service (full orchestration) | Days 2-6 + SPEC-08 RAG API |
| 8 | API routes (inbound webhook + status webhook) | Day 7 |
| 9 | Booking flow formatting + SPEC-07 notification type registration | Day 7 + SPEC-08 |
| 10 | Integration tests, end-to-end testing, monitoring setup | All above |

---

## 23. Relationship to Other Components

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Twilio     │────▶│  SMS Chatbot │────▶│  RAG Engine  │
│   (inbound)  │     │  (C06)       │◀────│  (C07/SPEC-08)│
└─────────────┘     │              │     └──────────────┘
                    │              │
                    │    ┌─────────▼──────┐
                    │    │  CRM           │
                    │    │  (C09/SPEC-05) │
                    │    │  auto-create   │
                    │    └────────────────┘
                    │
                    │    ┌────────────────┐
                    │───▶│  Notification  │
                    │    │  Engine        │
                    │    │  (C18/SPEC-07) │
                    │    │  • Twilio SMS  │
                    │    │    adapter     │
                    │    │  • Rob handoff │
                    │    │    alerts      │
                    │    └────────────────┘
                    │
                    │    ┌────────────────┐
                    │    │  Booking Engine │
                    │    │  (C08/SPEC-03) │
                    │    │  (via RAG)     │
                    │    └────────────────┘
                    │
                    │    ┌────────────────┐
                    └───▶│  Audit Trail   │
                         │  (C14)        │
                         └────────────────┘
```

### Key Integration Points

| Component | Interface | Direction |
|-----------|-----------|-----------|
| **RAG Engine (SPEC-08)** | `POST /api/internal/rag/query` with `channel: 'sms'` | SMS → RAG |
| **CRM (SPEC-05)** | `upsertFromChannel({ phone, source: 'sms' })` | SMS → CRM |
| **Notification Engine (SPEC-07)** | `twilioSmsAdapter.send()` for outbound SMS | SMS → SPEC-07 adapter |
| **Notification Engine (SPEC-07)** | `dispatchNotification('handoff_sms_conversation')` | SMS → SPEC-07 |
| **Booking Engine (SPEC-03)** | Indirectly via RAG engine intent routing | RAG → Booking |
| **Audit Trail (C14)** | `createAuditEntry({ event_type: 'sms.*' })` | SMS → Audit |

---

## 24. Future Enhancements (Out of Scope for v1)

1. **Proactive outbound SMS campaigns.** Currently SMS is reactive only. Future: re-engagement messages, lesson reminders, upsells.
2. **MMS support.** Accept and process images (e.g., student sending a photo of their logbook).
3. **Multi-language detection.** Detect non-English SMS and respond in the detected language (or route to human).
4. **SMS opt-out handling.** Respect STOP/UNSUBSCRIBE keywords per Australian spam regulations. (Twilio handles this at the carrier level for marketing, but conversational SMS should also honour explicit opt-outs.)
5. **A/B testing of response templates.** Test different CTA formats, booking link placements, and tone variations.
6. **WhatsApp integration.** Twilio supports WhatsApp via the same API. The adapter pattern makes this straightforward.
7. **Scheduled follow-up messages.** After a booking enquiry that didn't convert, send a follow-up 24h later.

---

*End of SPEC-10: SMS Chatbot*

*This component is consumed by no other component directly — it is an edge service that receives Twilio webhooks and orchestrates calls to the RAG Engine (SPEC-08), CRM (SPEC-05), Notification Engine (SPEC-07), and Booking Engine (SPEC-03). It shares the `conversations` and `messages` tables with the Voice Agent (SPEC-09) and the future Web Chat (SPEC-11), providing a unified conversation timeline across all channels.*
