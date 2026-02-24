# SPEC-09: Voice Agent Integration (C05)
### NexDrive Academy — Phase 2 Never Miss a Lead
**Version:** 1.0  
**Date:** 21 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.8, §5.2, §5.3; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-03 (Booking Engine — availability & booking APIs); SPEC-05 (CRM — auto-create service); SPEC-07 (Notification Engine — callback_scheduled event)  
**Phase:** 2 (Never Miss a Lead — Weeks 7-12)  
**Estimated Effort:** 8-10 days  

---

## 1. Overview

The Voice Agent is NexDrive Academy's AI receptionist. When a call comes in to the NexDrive business number, the voice agent answers, understands the caller's intent, answers questions using the RAG knowledge engine (C07), checks instructor availability (C08), books lessons, and takes messages when it can't resolve a call. Every call is logged, every caller becomes a CRM contact, and Rob gets notified immediately when human follow-up is needed.

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **Provider-agnostic via adapter pattern.** Vapi.ai is the primary implementation target, but all voice provider logic goes through a `VoiceAgentProvider` interface (per ADR-008). Provider can be swapped without touching business logic.
2. **Every call creates or touches a CRM contact.** Caller phone number is matched to an existing contact or a new one is created via the CRM auto-create service (SPEC-05 §13). No call is anonymous in the CRM.
3. **Every call is logged.** Full record in the `call_logs` table per architecture §3.3 — transcript, summary, outcome, duration, resolution, and provider metadata.
4. **Conversation threading.** Each call creates a `conversations` record (channel = `'voice'`) and the call_log links to it. This provides a unified timeline across voice, SMS, and web chat.
5. **Callback scheduling for unresolved calls.** If the agent can't resolve a call, it offers to schedule a callback, records the request, and immediately notifies Rob via the Notification Engine (SPEC-07).
6. **Voice response latency < 2 seconds.** Per architecture §11. Function call endpoints must respond within this budget. Pre-fetch common data. Cache aggressively.
7. **Australian English throughout.** The assistant speaks in Australian English — "G'day", "no worries", distances in kilometres, dates in DD/MM format. NexDrive brand voice: friendly, professional, knowledgeable.
8. **Webhook security.** All inbound webhook endpoints verify the Vapi webhook signature (or equivalent provider signature). No unauthenticated processing.
9. **Idempotent webhook handling.** Webhooks may arrive more than once. Use `external_call_id` as deduplication key.
10. **Bookings via voice use `booked_via: 'voice_agent'`.** This tracks channel attribution for analytics and CRM.

### 1.2 Voice Call Lifecycle

```
Inbound Call (NexDrive Business Number)
     │
     ▼
┌──────────────────────────┐
│  Vapi.ai Receives Call   │  ← Provider handles STT, TTS, turn-taking
│  Triggers inbound hook   │
└────────────┬─────────────┘
             │
     ┌───────▼────────┐
     │  POST /voice/   │  ← Our webhook: create call_log, upsert contact,
     │  inbound        │     create conversation record
     └───────┬─────────┘
             │
     ┌───────▼────────────────┐
     │  Conversation Loop      │
     │                         │
     │  Caller speaks          │
     │    ↓                    │
     │  Vapi STT → intent      │
     │    ↓                    │
     │  Function call needed?  │
     │    YES → POST /voice/   │ ← Our function-call dispatcher
     │           function-call │
     │    NO → Vapi generates  │
     │          response (TTS) │
     └───────┬─────────────────┘
             │
     ┌───────▼────────┐
     │  Call Ends       │
     │  Vapi sends      │
     │  end-of-call     │
     │  event           │
     └───────┬──────────┘
             │
     ┌───────▼────────┐
     │  POST /voice/   │  ← Our event webhook: update call_log with
     │  event          │     transcript, summary, outcome, duration
     └───────┬─────────┘
             │
     ┌───────▼────────────────┐
     │  Post-Call Processing    │
     │  • Update CRM contact   │
     │  • Schedule callback     │
     │    (if unresolved)       │
     │  • Notify Rob            │
     │    (if message taken)    │
     │  • Emit events           │
     └─────────────────────────┘
```

---

## 2. File Structure

```
src/
├── lib/
│   ├── voice/
│   │   ├── index.ts                          # Barrel export
│   │   ├── types.ts                          # All voice-related types + Zod schemas
│   │   ├── errors.ts                         # Voice-specific error classes
│   │   ├── constants.ts                      # Provider config, status values, defaults
│   │   ├── provider.interface.ts             # VoiceAgentProvider adapter interface (ADR-008)
│   │   ├── vapi.adapter.ts                   # Vapi.ai implementation of provider interface
│   │   ├── vapi.webhook-verify.ts            # Vapi webhook signature verification
│   │   ├── vapi.assistant-config.ts          # Vapi assistant definition (system prompt, functions)
│   │   ├── call-log.service.ts               # Call log CRUD (write to call_logs table)
│   │   ├── conversation.service.ts           # Conversation/message threading for voice
│   │   ├── function-dispatcher.service.ts    # Routes function calls to handlers
│   │   ├── functions/
│   │   │   ├── check-availability.ts         # check_availability handler
│   │   │   ├── make-booking.ts               # make_booking handler
│   │   │   ├── get-business-info.ts          # get_business_info handler (→ RAG)
│   │   │   ├── get-student-info.ts           # get_student_info handler
│   │   │   └── request-callback.ts           # request_callback handler
│   │   ├── callback.service.ts               # Callback scheduling + notification
│   │   └── events.ts                         # CALL_COMPLETED, CALLBACK_REQUESTED events
│   │
│   ├── events/
│   │   └── types.ts                          # AppEvent union (extended)
│   │
│   └── auth/
│       └── webhook-auth.ts                   # Shared webhook verification utilities
│
├── app/
│   └── api/
│       └── v1/
│           └── voice/
│               ├── inbound/
│               │   └── route.ts              # POST /api/v1/voice/inbound
│               ├── event/
│               │   └── route.ts              # POST /api/v1/voice/event
│               └── function-call/
│                   └── route.ts              # POST /api/v1/voice/function-call
│
└── __tests__/
    └── voice/
        ├── vapi.adapter.test.ts
        ├── call-log.service.test.ts
        ├── function-dispatcher.test.ts
        ├── functions/
        │   ├── check-availability.test.ts
        │   ├── make-booking.test.ts
        │   ├── get-business-info.test.ts
        │   ├── get-student-info.test.ts
        │   └── request-callback.test.ts
        ├── callback.service.test.ts
        ├── webhook-verify.test.ts
        └── integration/
            ├── inbound-call-flow.test.ts
            └── function-call-flow.test.ts
```

---

## 3. VoiceAgentProvider Interface (`provider.interface.ts`)

Per ADR-008, the voice agent provider is behind an adapter interface. This means we can evaluate Vapi.ai, Bland.ai, or Retell.ai — or swap providers later — without changing any business logic.

```typescript
/**
 * VoiceAgentProvider — Adapter interface per ADR-008.
 *
 * All voice provider interactions go through this interface.
 * The active implementation is configured via VOICE_PROVIDER env var.
 *
 * Current implementation: VapiAdapter (vapi.adapter.ts)
 * Possible future: BlandAdapter, RetellAdapter
 */

export interface AssistantConfig {
  /** Unique identifier for the assistant on the provider platform */
  id?: string;
  /** Display name */
  name: string;
  /** System prompt defining persona + behaviour */
  systemPrompt: string;
  /** Voice model/ID for TTS */
  voiceId: string;
  /** Language/locale */
  language: string;
  /** Functions the assistant can invoke */
  functions: VoiceFunctionDefinition[];
  /** Webhook URLs for events */
  webhooks: {
    functionCallUrl: string;
    eventUrl: string;
  };
  /** Provider-specific settings (e.g. interruption handling, silence timeout) */
  providerOptions?: Record<string, unknown>;
}

export interface VoiceFunctionDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

export interface CallStatus {
  callId: string;
  status: 'ringing' | 'in_progress' | 'completed' | 'failed';
  duration_seconds?: number;
  callerPhone?: string;
  startedAt?: Date;
  endedAt?: Date;
}

export interface CallEndedEvent {
  callId: string;
  callerPhone: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  transcript: string;
  summary: string;
  endReason: 'caller_hangup' | 'assistant_hangup' | 'timeout' | 'error';
  recordingUrl?: string;
}

export interface FunctionCallRequest {
  callId: string;
  functionName: string;
  parameters: Record<string, unknown>;
  callerPhone: string;
}

export interface FunctionCallResponse {
  result: string;  // Natural language result for the assistant to speak
  data?: Record<string, unknown>;  // Structured data (optional, for assistant context)
}

export interface VoiceAgentProvider {
  /** Provider identifier (e.g., 'vapi', 'bland', 'retell') */
  readonly providerId: string;

  /**
   * Create or update the assistant configuration on the provider platform.
   * Called during setup/deployment, not per-call.
   */
  createAssistant(config: AssistantConfig): Promise<{ assistantId: string }>;

  /**
   * Update an existing assistant's configuration.
   */
  updateAssistant(assistantId: string, config: Partial<AssistantConfig>): Promise<void>;

  /**
   * Get the current status of an active or recent call.
   */
  getCallStatus(callId: string): Promise<CallStatus>;

  /**
   * Programmatically end an active call (e.g., for emergency stop or admin override).
   */
  endCall(callId: string): Promise<void>;

  /**
   * Verify that an inbound webhook request is authentic.
   * Returns the parsed payload if valid, throws if invalid.
   */
  verifyWebhook(payload: string, headers: Record<string, string>): Promise<Record<string, unknown>>;

  /**
   * Parse a provider-specific call-ended event into our canonical format.
   */
  parseCallEndedEvent(rawEvent: Record<string, unknown>): CallEndedEvent;

  /**
   * Parse a provider-specific function-call request into our canonical format.
   */
  parseFunctionCallRequest(rawRequest: Record<string, unknown>): FunctionCallRequest;

  /**
   * Format our function-call response into the provider's expected format.
   */
  formatFunctionCallResponse(response: FunctionCallResponse): Record<string, unknown>;
}
```

### 3.1 Provider Factory

```typescript
// src/lib/voice/index.ts

import { VapiAdapter } from './vapi.adapter';
import type { VoiceAgentProvider } from './provider.interface';

const providers: Record<string, () => VoiceAgentProvider> = {
  vapi: () => new VapiAdapter(),
  // bland: () => new BlandAdapter(),   // future
  // retell: () => new RetellAdapter(),  // future
};

let _instance: VoiceAgentProvider | null = null;

export function getVoiceProvider(): VoiceAgentProvider {
  if (_instance) return _instance;

  const providerId = process.env.VOICE_PROVIDER ?? 'vapi';
  const factory = providers[providerId];
  if (!factory) {
    throw new Error(`Unknown voice provider: ${providerId}. Supported: ${Object.keys(providers).join(', ')}`);
  }

  _instance = factory();
  return _instance;
}

// Re-export types
export type { VoiceAgentProvider, AssistantConfig, CallStatus, CallEndedEvent, FunctionCallRequest, FunctionCallResponse } from './provider.interface';
```

---

## 4. Vapi.ai Adapter (`vapi.adapter.ts`)

### 4.1 Implementation

```typescript
import type {
  VoiceAgentProvider,
  AssistantConfig,
  CallStatus,
  CallEndedEvent,
  FunctionCallRequest,
  FunctionCallResponse,
} from './provider.interface';
import { VoiceProviderError, WebhookVerificationError } from './errors';
import { verifyVapiWebhook } from './vapi.webhook-verify';
import { VAPI_API_BASE } from './constants';

/**
 * Vapi.ai adapter implementation.
 *
 * Vapi API docs: https://docs.vapi.ai
 *
 * Authentication: Bearer token via VAPI_API_KEY env var.
 * All API calls to: https://api.vapi.ai
 */
export class VapiAdapter implements VoiceAgentProvider {
  readonly providerId = 'vapi' as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey = process.env.VAPI_API_KEY!;
    if (!this.apiKey) throw new Error('VAPI_API_KEY environment variable is required');
    this.baseUrl = VAPI_API_BASE;
  }

  private async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(
        `Vapi API error: ${res.status} ${res.statusText}`,
        { status: res.status, body, path }
      );
    }

    return res;
  }

  async createAssistant(config: AssistantConfig): Promise<{ assistantId: string }> {
    const vapiPayload = this.toVapiAssistantPayload(config);
    const res = await this.fetch('/assistant', {
      method: 'POST',
      body: JSON.stringify(vapiPayload),
    });
    const data = await res.json() as { id: string };
    return { assistantId: data.id };
  }

  async updateAssistant(assistantId: string, config: Partial<AssistantConfig>): Promise<void> {
    const vapiPayload = this.toVapiAssistantPayload(config as AssistantConfig);
    await this.fetch(`/assistant/${assistantId}`, {
      method: 'PATCH',
      body: JSON.stringify(vapiPayload),
    });
  }

  async getCallStatus(callId: string): Promise<CallStatus> {
    const res = await this.fetch(`/call/${callId}`);
    const data = await res.json() as VapiCallResponse;

    return {
      callId: data.id,
      status: this.mapVapiCallStatus(data.status),
      duration_seconds: data.endedAt && data.startedAt
        ? Math.round((new Date(data.endedAt).getTime() - new Date(data.startedAt).getTime()) / 1000)
        : undefined,
      callerPhone: data.customer?.number,
      startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
      endedAt: data.endedAt ? new Date(data.endedAt) : undefined,
    };
  }

  async endCall(callId: string): Promise<void> {
    await this.fetch(`/call/${callId}/stop`, { method: 'POST' });
  }

  async verifyWebhook(
    payload: string,
    headers: Record<string, string>
  ): Promise<Record<string, unknown>> {
    return verifyVapiWebhook(payload, headers, process.env.VAPI_WEBHOOK_SECRET!);
  }

  parseCallEndedEvent(rawEvent: Record<string, unknown>): CallEndedEvent {
    const message = rawEvent.message as VapiEndOfCallMessage;
    const call = message.call ?? rawEvent.call as VapiCallResponse;

    return {
      callId: call.id,
      callerPhone: call.customer?.number ?? 'unknown',
      startedAt: new Date(call.startedAt),
      endedAt: new Date(call.endedAt),
      durationSeconds: Math.round(
        (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000
      ),
      transcript: message.transcript ?? '',
      summary: message.summary ?? '',
      endReason: this.mapVapiEndReason(message.endedReason ?? call.endedReason),
      recordingUrl: message.recordingUrl ?? call.recordingUrl,
    };
  }

  parseFunctionCallRequest(rawRequest: Record<string, unknown>): FunctionCallRequest {
    const message = rawRequest.message as VapiFunctionCallMessage;
    const call = message.call ?? rawRequest.call as VapiCallResponse;

    return {
      callId: call.id,
      functionName: message.functionCall.name,
      parameters: message.functionCall.parameters ?? {},
      callerPhone: call.customer?.number ?? 'unknown',
    };
  }

  formatFunctionCallResponse(response: FunctionCallResponse): Record<string, unknown> {
    // Vapi expects a specific response format for function call results
    return {
      result: response.result,
    };
  }

  // --- Private helpers ---

  private toVapiAssistantPayload(config: AssistantConfig): Record<string, unknown> {
    return {
      name: config.name,
      model: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250514',
        systemPrompt: config.systemPrompt,
        functions: config.functions.map(fn => ({
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
        })),
      },
      voice: {
        provider: '11labs',
        voiceId: config.voiceId,
      },
      firstMessage: NEXDRIVE_GREETING,
      serverUrl: config.webhooks.functionCallUrl,
      serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,
      silenceTimeoutSeconds: 30,
      maxDurationSeconds: 600,            // 10 minute max call
      endCallMessage: 'Thanks for calling NexDrive Academy! Have a great day.',
      transcriber: {
        provider: 'deepgram',
        model: 'nova-2',
        language: 'en-AU',
      },
      ...config.providerOptions,
    };
  }

  private mapVapiCallStatus(vapiStatus: string): CallStatus['status'] {
    const map: Record<string, CallStatus['status']> = {
      'queued': 'ringing',
      'ringing': 'ringing',
      'in-progress': 'in_progress',
      'forwarding': 'in_progress',
      'ended': 'completed',
    };
    return map[vapiStatus] ?? 'failed';
  }

  private mapVapiEndReason(reason: string): CallEndedEvent['endReason'] {
    const map: Record<string, CallEndedEvent['endReason']> = {
      'customer-ended-call': 'caller_hangup',
      'assistant-ended-call': 'assistant_hangup',
      'silence-timed-out': 'timeout',
      'max-duration-reached': 'timeout',
      'assistant-error': 'error',
      'pipeline-error': 'error',
    };
    return map[reason] ?? 'caller_hangup';
  }
}

const NEXDRIVE_GREETING = "G'day! Thanks for calling NexDrive Academy, Canberra's driving school. I'm NexDrive's AI assistant. How can I help you today?";

// --- Vapi-specific types (internal, not exported) ---

interface VapiCallResponse {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string;
  endedReason: string;
  recordingUrl?: string;
  customer?: { number?: string };
}

interface VapiEndOfCallMessage {
  type: 'end-of-call-report';
  call?: VapiCallResponse;
  endedReason?: string;
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
}

interface VapiFunctionCallMessage {
  type: 'function-call';
  call?: VapiCallResponse;
  functionCall: {
    name: string;
    parameters?: Record<string, unknown>;
  };
}
```

### 4.2 Webhook Signature Verification (`vapi.webhook-verify.ts`)

```typescript
import crypto from 'crypto';
import { WebhookVerificationError } from './errors';

/**
 * Verify Vapi webhook signature.
 *
 * Vapi sends a `x-vapi-signature` header containing an HMAC-SHA256
 * of the raw request body, signed with the serverUrlSecret.
 *
 * If Vapi changes their verification method, only this file needs updating.
 */
export async function verifyVapiWebhook(
  rawBody: string,
  headers: Record<string, string>,
  secret: string
): Promise<Record<string, unknown>> {
  const signature = headers['x-vapi-signature'] ?? headers['x-vapi-secret'];

  if (!signature) {
    throw new WebhookVerificationError('Missing Vapi webhook signature header');
  }

  // Vapi's token-based verification: compare secret directly
  // Some Vapi configurations use a simple secret match rather than HMAC
  if (signature === secret) {
    return JSON.parse(rawBody);
  }

  // HMAC-SHA256 verification (if Vapi uses signed webhooks)
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );

  if (!isValid) {
    throw new WebhookVerificationError('Invalid Vapi webhook signature');
  }

  return JSON.parse(rawBody);
}
```

---

## 5. Vapi Assistant Configuration (`vapi.assistant-config.ts`)

This file defines the NexDrive AI receptionist — its persona, knowledge, and capabilities.

### 5.1 System Prompt

```typescript
import type { AssistantConfig, VoiceFunctionDefinition } from './provider.interface';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://nexdriveacademy.com.au';

/**
 * NexDrive AI Receptionist — Assistant Configuration
 *
 * This is deployed to Vapi via createAssistant() during setup.
 * Update and redeploy via updateAssistant() when business info changes.
 */
export function buildAssistantConfig(): AssistantConfig {
  return {
    name: 'NexDrive Academy Receptionist',
    systemPrompt: SYSTEM_PROMPT,
    voiceId: process.env.VAPI_VOICE_ID ?? 'default-australian-female',
    language: 'en-AU',
    functions: VOICE_FUNCTIONS,
    webhooks: {
      functionCallUrl: `${BASE_URL}/api/v1/voice/function-call`,
      eventUrl: `${BASE_URL}/api/v1/voice/event`,
    },
    providerOptions: {
      // Vapi-specific tuning
      responsiveness: 0.6,               // Balance between speed and accuracy
      silenceTimeoutSeconds: 30,
      maxDurationSeconds: 600,
      backgroundSound: 'off',
      backchannelingEnabled: true,        // "mhm", "right" during caller speech
      backgroundDenoisingEnabled: true,
    },
  };
}

const SYSTEM_PROMPT = `You are the AI receptionist for NexDrive Academy, a driving school in Canberra, ACT, Australia. Your name is "NexDrive's AI assistant" — never claim to be a human.

## Your personality
- Friendly, warm, and professional Australian tone
- Use natural Australian English: "G'day", "no worries", "mate" (sparingly), "cheers"
- Confident about NexDrive services; honest when you don't know something
- Conversational, not robotic — match the caller's energy level
- Empathetic with nervous callers (learning to drive is stressful!)

## About NexDrive Academy
- Owner and head instructor: Rob Harrison
- ADI certified instructor (ADI #608) in the ACT
- Location: Canberra, ACT, Australia
- Services: Learner driving lessons, pre-test assessments, Keys2Drive free lessons
- Vehicle: Dual-control, automatic transmission
- Rob follows the ACT Government CBT&A (Competency Based Training & Assessment) system
- 23 competency tasks are tracked across all lessons

## What you CAN do
1. Answer questions about NexDrive services, pricing, lesson types, and the learning process
2. Check available lesson times using the check_availability function
3. Book lessons for callers using the make_booking function
4. Look up information for existing students using get_student_info (by phone number)
5. Provide general information about getting a learner licence in the ACT

## What you CANNOT do — take a message instead
1. Handle complaints or disputes
2. Modify or cancel existing bookings (ask them to call back or use the student portal)
3. Discuss another student's information
4. Provide legal or medical advice
5. Anything you're not confident about — it's always better to take a message

## Conversation rules
1. ALWAYS capture the caller's name and confirm their phone number early in the conversation
2. If the caller wants to book: get their preferred date/time, ask what type of lesson, then check availability
3. If a slot isn't available: offer the nearest alternatives before taking a message
4. If you can't help: use request_callback to schedule Rob to call them back. Ask when they'd prefer the callback.
5. Keep responses concise — this is a phone call, not an essay. 1-2 sentences per turn.
6. Confirm key details back to the caller: "Just to confirm, that's a 60-minute learner lesson on Tuesday the 15th at 10 AM?"
7. End every call warmly: "Thanks for calling NexDrive Academy! Have a great day."
8. NEVER share private notes, internal business details, or other students' information

## Business hours awareness
- If the call is during business hours (Mon-Fri 8am-5pm AEST/AEDT): mention Rob is likely teaching
- If outside business hours: "Rob's not available right now, but I can help with most things or take a message for him"

## Date and time formatting
- Always use Australian format: day/month (e.g., "Tuesday the 15th of March")
- Use 12-hour time with AM/PM
- Always confirm the timezone is Canberra time (AEST/AEDT)
`;
```

### 5.2 Function Definitions

```typescript
const VOICE_FUNCTIONS: VoiceFunctionDefinition[] = [
  {
    name: 'check_availability',
    description: 'Check available lesson time slots for a given date range and service type. Call this when a caller wants to know when they can book a lesson.',
    parameters: {
      type: 'object',
      properties: {
        date_from: {
          type: 'string',
          description: 'Start date to check availability (ISO 8601 format, e.g. "2026-03-15"). If caller says "next week", calculate the appropriate date.',
        },
        date_to: {
          type: 'string',
          description: 'End date to check availability (ISO 8601 format). Defaults to 7 days after date_from if not specified.',
        },
        service_type: {
          type: 'string',
          description: 'The type of lesson the caller wants',
          enum: ['learner-60', 'learner-90', 'learner-120', 'assessment', 'keys2drive'],
        },
        time_preference: {
          type: 'string',
          description: 'Caller time preference if mentioned',
          enum: ['morning', 'afternoon', 'any'],
        },
      },
      required: ['date_from'],
    },
  },
  {
    name: 'make_booking',
    description: 'Book a lesson for the caller. Only call this after confirming the details with the caller: date, time, lesson type, and their contact information.',
    parameters: {
      type: 'object',
      properties: {
        caller_name: {
          type: 'string',
          description: 'Full name of the person booking (e.g. "Sarah Chen")',
        },
        caller_phone: {
          type: 'string',
          description: 'Phone number of the caller in Australian format',
        },
        caller_email: {
          type: 'string',
          description: 'Email address (optional, but ask for it)',
        },
        service_slug: {
          type: 'string',
          description: 'Service type slug',
          enum: ['learner-60', 'learner-90', 'learner-120', 'assessment', 'keys2drive'],
        },
        date: {
          type: 'string',
          description: 'Lesson date (ISO 8601 format)',
        },
        start_time: {
          type: 'string',
          description: 'Lesson start time (HH:mm in 24-hour format, e.g. "10:00")',
        },
        pickup_address: {
          type: 'string',
          description: 'Where the student should be picked up (ask the caller)',
        },
        booking_notes: {
          type: 'string',
          description: 'Any additional notes from the caller about the lesson',
        },
      },
      required: ['caller_name', 'caller_phone', 'service_slug', 'date', 'start_time'],
    },
  },
  {
    name: 'get_business_info',
    description: 'Get information about NexDrive Academy services, pricing, the learning process, or ACT driving rules. Use this when a caller asks a question you need specific information to answer.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The caller\'s question, phrased for a knowledge base lookup',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_student_info',
    description: 'Look up an existing student\'s basic information and upcoming bookings by their phone number. Only use when the caller identifies themselves as an existing student.',
    parameters: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'The student\'s phone number',
        },
      },
      required: ['phone'],
    },
  },
  {
    name: 'request_callback',
    description: 'Schedule a callback from Rob when you cannot resolve the caller\'s request. Always try to help first — only use this as a fallback.',
    parameters: {
      type: 'object',
      properties: {
        caller_name: {
          type: 'string',
          description: 'Name of the person requesting the callback',
        },
        caller_phone: {
          type: 'string',
          description: 'Phone number to call back on',
        },
        reason: {
          type: 'string',
          description: 'Why they\'re calling and what they need help with',
        },
        preferred_callback_time: {
          type: 'string',
          description: 'When the caller would like to be called back (e.g. "tomorrow morning", "after 2pm")',
        },
        urgency: {
          type: 'string',
          description: 'How urgent the callback is',
          enum: ['low', 'normal', 'high'],
        },
      },
      required: ['caller_name', 'caller_phone', 'reason'],
    },
  },
];
```

---

## 6. Function Call Dispatcher (`function-dispatcher.service.ts`)

The dispatcher receives function calls from Vapi and routes them to the appropriate handler. Each handler is a thin wrapper that calls existing service-layer APIs (Booking Engine, RAG Engine, CRM).

```typescript
import type { FunctionCallRequest, FunctionCallResponse } from './provider.interface';
import { handleCheckAvailability } from './functions/check-availability';
import { handleMakeBooking } from './functions/make-booking';
import { handleGetBusinessInfo } from './functions/get-business-info';
import { handleGetStudentInfo } from './functions/get-student-info';
import { handleRequestCallback } from './functions/request-callback';
import { VoiceFunctionError } from './errors';

type FunctionHandler = (params: Record<string, unknown>, callContext: CallContext) => Promise<FunctionCallResponse>;

export interface CallContext {
  callId: string;
  callerPhone: string;
  contactId?: string;       // Resolved during inbound webhook
  conversationId?: string;  // Created during inbound webhook
}

const handlers: Record<string, FunctionHandler> = {
  check_availability: handleCheckAvailability,
  make_booking: handleMakeBooking,
  get_business_info: handleGetBusinessInfo,
  get_student_info: handleGetStudentInfo,
  request_callback: handleRequestCallback,
};

/**
 * Dispatch a function call from the voice agent to the appropriate handler.
 *
 * Latency budget: < 2 seconds total (architecture §11).
 * Each handler should target < 1.5s to leave headroom for serialization.
 *
 * If a handler throws, we return a graceful error message for the assistant
 * to relay to the caller, rather than crashing the call.
 */
export async function dispatchFunctionCall(
  request: FunctionCallRequest,
  context: CallContext
): Promise<FunctionCallResponse> {
  const handler = handlers[request.functionName];

  if (!handler) {
    return {
      result: "I'm sorry, I can't do that right now. Let me take a message for Rob instead.",
    };
  }

  try {
    return await handler(request.parameters, context);
  } catch (error) {
    console.error(`[Voice] Function call error: ${request.functionName}`, error);

    // Never expose internal errors to the caller
    if (error instanceof VoiceFunctionError) {
      return { result: error.callerFacingMessage };
    }

    return {
      result: "I'm having a bit of trouble looking that up right now. Would you like me to take a message and have Rob call you back?",
    };
  }
}
```

---

## 7. Function Call Handlers

### 7.1 `check_availability.ts`

```typescript
import type { FunctionCallResponse } from '../provider.interface';
import type { CallContext } from '../function-dispatcher.service';
import { getAvailableSlots } from '@/lib/booking/availability.service';
import { getDefaultInstructorId } from '@/lib/voice/constants';
import { format } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

const TIMEZONE = 'Australia/Canberra';

/**
 * Check available lesson slots.
 *
 * Calls the Booking Engine (SPEC-03) availability service.
 * Returns a natural-language summary of available times.
 *
 * Target: < 500ms (booking engine availability query is optimised)
 */
export async function handleCheckAvailability(
  params: Record<string, unknown>,
  _context: CallContext
): Promise<FunctionCallResponse> {
  const dateFrom = params.date_from as string;
  const dateTo = (params.date_to as string) ?? addDays(dateFrom, 7);
  const serviceType = params.service_type as string | undefined;
  const timePreference = params.time_preference as string | undefined;

  const instructorId = await getDefaultInstructorId();

  const slots = await getAvailableSlots({
    instructorId,
    dateFrom,
    dateTo,
    serviceSlug: serviceType,
    timePreference,
    limit: 10,  // Don't overwhelm the caller — top 10 slots
  });

  if (slots.length === 0) {
    return {
      result: `I don't have any available slots between ${formatDateForSpeech(dateFrom)} and ${formatDateForSpeech(dateTo)}. Would you like me to check a different week, or shall I take a message and Rob can find a time that works?`,
      data: { slots: [] },
    };
  }

  // Group by date for natural speech
  const grouped = groupSlotsByDate(slots);
  const speechParts: string[] = [];

  for (const [date, daySlots] of Object.entries(grouped).slice(0, 3)) {
    const times = daySlots
      .map(s => formatInTimeZone(new Date(s.start_time), TIMEZONE, 'h:mm a'))
      .join(', ');
    speechParts.push(`${formatDateForSpeech(date)} at ${times}`);
  }

  const moreText = slots.length > 5 ? ` I have more times available too.` : '';

  return {
    result: `I've got some availability coming up. ${speechParts.join('. Also, ')}. ${moreText}Would any of those work for you?`,
    data: { slots: slots.map(s => ({ date: s.date, start_time: s.start_time, service: s.service_slug })) },
  };
}

function formatDateForSpeech(isoDate: string): string {
  const d = new Date(isoDate);
  return format(d, "EEEE 'the' do 'of' MMMM"); // "Tuesday the 15th of March"
}

function groupSlotsByDate(slots: { date: string; start_time: string }[]): Record<string, typeof slots> {
  return slots.reduce((acc, slot) => {
    (acc[slot.date] ??= []).push(slot);
    return acc;
  }, {} as Record<string, typeof slots>);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
```

### 7.2 `make_booking.ts`

```typescript
import type { FunctionCallResponse } from '../provider.interface';
import type { CallContext } from '../function-dispatcher.service';
import { upsertFromChannel } from '@/lib/crm/auto-create.service';
import { reserveSlot, confirmBooking } from '@/lib/booking/booking.service';
import { resolveServiceBySlug } from '@/lib/booking/services.service';
import { getDefaultInstructorId } from '@/lib/voice/constants';
import { formatInTimeZone } from 'date-fns-tz';
import { VoiceFunctionError } from '../errors';

const TIMEZONE = 'Australia/Canberra';

/**
 * Create a booking for a voice caller.
 *
 * Steps:
 * 1. Upsert CRM contact from caller details (SPEC-05)
 * 2. Resolve service by slug
 * 3. Reserve slot via Booking Engine (SPEC-03) — 10 min hold
 * 4. Confirm booking immediately (voice bookings skip payment gate in v1)
 *
 * Bookings via voice use booked_via: 'voice_agent' and payment_status: 'unpaid'.
 * Rob collects payment at the lesson.
 */
export async function handleMakeBooking(
  params: Record<string, unknown>,
  context: CallContext
): Promise<FunctionCallResponse> {
  const callerName = params.caller_name as string;
  const callerPhone = params.caller_phone as string;
  const callerEmail = params.caller_email as string | undefined;
  const serviceSlug = params.service_slug as string;
  const date = params.date as string;
  const startTime = params.start_time as string;
  const pickupAddress = params.pickup_address as string | undefined;
  const bookingNotes = params.booking_notes as string | undefined;

  const instructorId = await getDefaultInstructorId();

  // Parse name into first/last
  const nameParts = callerName.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;

  // 1. Upsert CRM contact
  const { contact_id } = await upsertFromChannel(
    {
      phone: callerPhone,
      email: callerEmail,
      first_name: firstName,
      last_name: lastName,
      source: 'phone' as const,
      source_detail: 'voice_agent_booking',
      instructor_id: instructorId,
    },
    { role: 'system', clerkUserId: 'system' }
  );

  // 2. Resolve service
  const service = await resolveServiceBySlug(serviceSlug);
  if (!service) {
    throw new VoiceFunctionError(
      `Service not found: ${serviceSlug}`,
      "I'm sorry, I couldn't find that lesson type. Could you tell me again what kind of lesson you're after?"
    );
  }

  // 3. Build start timestamp in Canberra timezone
  const startTimestamp = buildTimestamp(date, startTime, TIMEZONE);

  // 4. Reserve slot
  let reservation;
  try {
    reservation = await reserveSlot({
      instructorId,
      serviceId: service.id,
      startTime: startTimestamp,
      contactId: contact_id,
      bookedVia: 'voice_agent',
    });
  } catch (error: any) {
    if (error.code === 'BOOKING_CONFLICT') {
      throw new VoiceFunctionError(
        `Slot conflict: ${date} ${startTime}`,
        "I'm sorry, it looks like that time slot has just been taken. Would you like me to check for another available time?"
      );
    }
    throw error;
  }

  // 5. Confirm booking (voice bookings are confirmed immediately, payment collected at lesson)
  const booking = await confirmBooking(reservation.bookingId, {
    pickupAddress,
    bookingNotes: bookingNotes
      ? `[Voice booking] ${bookingNotes}`
      : '[Voice booking]',
    paymentStatus: 'unpaid',
  });

  // Format confirmation for speech
  const dateForSpeech = formatInTimeZone(startTimestamp, TIMEZONE, "EEEE 'the' do 'of' MMMM");
  const timeForSpeech = formatInTimeZone(startTimestamp, TIMEZONE, 'h:mm a');

  return {
    result: `Excellent! I've booked a ${service.name} for you on ${dateForSpeech} at ${timeForSpeech}. Rob will pick you up at ${pickupAddress ?? 'the address on file'}. You'll get a confirmation text shortly. Is there anything else I can help with?`,
    data: {
      bookingId: booking.id,
      contactId: contact_id,
      service: service.name,
      date,
      startTime,
    },
  };
}

function buildTimestamp(date: string, time: string, timezone: string): Date {
  // Construct a Date from YYYY-MM-DD + HH:mm in the given timezone
  const dateTimeStr = `${date}T${time}:00`;
  // Use Intl to resolve the timezone offset, then create UTC timestamp
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  // Quick approach: parse as local-in-timezone
  const tzDate = new Date(new Date(dateTimeStr).toLocaleString('en-US', { timeZone: timezone }));
  return new Date(dateTimeStr + getTimezoneOffsetString(timezone, dateTimeStr));
}

function getTimezoneOffsetString(timezone: string, dateTimeStr: string): string {
  const date = new Date(dateTimeStr + 'Z');
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: timezone });
  const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  const diffHours = Math.round(diffMs / 3600000);
  const sign = diffHours >= 0 ? '+' : '-';
  const abs = Math.abs(diffHours);
  return `${sign}${String(abs).padStart(2, '0')}:00`;
}
```

### 7.3 `get_business_info.ts`

```typescript
import type { FunctionCallResponse } from '../provider.interface';
import type { CallContext } from '../function-dispatcher.service';

/**
 * Answer a business question via the RAG engine (C07, SPEC pending).
 *
 * Routes the caller's question to the internal RAG query API.
 * The RAG engine returns an answer with source references.
 *
 * Target: < 1.5s (RAG query is < 3s per arch §11, but we need margin)
 */
export async function handleGetBusinessInfo(
  params: Record<string, unknown>,
  context: CallContext
): Promise<FunctionCallResponse> {
  const question = params.question as string;

  try {
    const ragResponse = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL}/api/internal/rag/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': process.env.INTERNAL_API_SECRET!,
        },
        body: JSON.stringify({
          query: question,
          context: {
            channel: 'voice',
            caller_phone: context.callerPhone,
          },
          max_results: 3,
        }),
      }
    );

    if (!ragResponse.ok) {
      throw new Error(`RAG query failed: ${ragResponse.status}`);
    }

    const data = await ragResponse.json() as {
      answer: string;
      confidence: number;
      suggested_actions?: string[];
    };

    // If confidence is low, suggest a callback instead
    if (data.confidence < 0.6) {
      return {
        result: "I'm not 100% sure about that one. I'd rather not give you the wrong information. Would you like me to have Rob call you back with the details?",
        data: { confidence: data.confidence, suggested_actions: data.suggested_actions },
      };
    }

    // Format for speech — strip any markdown, keep it conversational
    const spokenAnswer = stripMarkdownForSpeech(data.answer);

    return {
      result: spokenAnswer,
      data: { confidence: data.confidence },
    };
  } catch (error) {
    console.error('[Voice] RAG query error:', error);
    return {
      result: "I'm having trouble looking that up at the moment. Would you like me to take a message so Rob can get back to you with the details?",
    };
  }
}

/**
 * Strip markdown formatting for natural speech output.
 * RAG answers may contain bullet points, links, or headers.
 */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/#{1,6}\s/g, '')           // Headers
    .replace(/\*\*(.*?)\*\*/g, '$1')    // Bold
    .replace(/\*(.*?)\*/g, '$1')        // Italic
    .replace(/\[(.*?)\]\(.*?\)/g, '$1') // Links → just text
    .replace(/^[-*+]\s/gm, '')          // Bullet points
    .replace(/^\d+\.\s/gm, '')          // Numbered lists
    .replace(/\n{2,}/g, '. ')           // Multiple newlines → sentence break
    .replace(/\n/g, '. ')               // Single newlines → sentence break
    .trim();
}
```

### 7.4 `get_student_info.ts`

```typescript
import type { FunctionCallResponse } from '../provider.interface';
import type { CallContext } from '../function-dispatcher.service';
import { normalisePhone } from '@/lib/crm/deduplication.service';
import { db } from '@/lib/db';
import { contacts, students, bookings, profiles } from '@/lib/db/schema';
import { eq, and, gte } from 'drizzle-orm';
import { formatInTimeZone } from 'date-fns-tz';

const TIMEZONE = 'Australia/Canberra';

/**
 * Look up an existing student by phone number.
 *
 * Returns ONLY non-sensitive information:
 * - First name
 * - Upcoming bookings (next 2)
 * - Total lesson count
 *
 * NEVER returns: private notes, competency details (those are for the student portal),
 * payment info, or other students' data.
 *
 * If the phone doesn't match a known student, says so gracefully.
 */
export async function handleGetStudentInfo(
  params: Record<string, unknown>,
  context: CallContext
): Promise<FunctionCallResponse> {
  const rawPhone = params.phone as string;
  const phone = normalisePhone(rawPhone);

  // Look up by phone → contact → student
  const contact = await db
    .select({ id: contacts.id, userId: contacts.user_id, firstName: contacts.first_name })
    .from(contacts)
    .where(eq(contacts.phone, phone))
    .limit(1)
    .then(rows => rows[0]);

  if (!contact || !contact.userId) {
    return {
      result: "I don't have a student record for that phone number. You might be registered under a different number. Would you like me to take a message for Rob to sort that out?",
    };
  }

  // Get student record
  const student = await db
    .select({ id: students.id, firstName: profiles.first_name, totalHours: students.total_hours })
    .from(students)
    .innerJoin(profiles, eq(students.profile_id, profiles.id))
    .where(eq(students.user_id, contact.userId))
    .limit(1)
    .then(rows => rows[0]);

  if (!student) {
    return {
      result: "I can see you're in our system, but I don't have a student profile linked. Rob can help sort that out — would you like me to take a message?",
    };
  }

  // Get upcoming bookings (next 2)
  const now = new Date();
  const upcoming = await db
    .select({
      scheduledDate: bookings.scheduled_date,
      startTime: bookings.start_time,
      status: bookings.status,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.student_id, student.id),
        gte(bookings.start_time, now),
        eq(bookings.status, 'confirmed')
      )
    )
    .orderBy(bookings.start_time)
    .limit(2);

  let bookingInfo = '';
  if (upcoming.length > 0) {
    const parts = upcoming.map(b => {
      const date = formatInTimeZone(b.startTime, TIMEZONE, "EEEE 'the' do 'of' MMMM");
      const time = formatInTimeZone(b.startTime, TIMEZONE, 'h:mm a');
      return `${date} at ${time}`;
    });
    bookingInfo = `Your next ${upcoming.length === 1 ? 'lesson is' : 'lessons are'} on ${parts.join(' and ')}.`;
  } else {
    bookingInfo = "You don't have any upcoming lessons booked at the moment.";
  }

  const hoursInfo = student.totalHours
    ? ` You've logged ${Number(student.totalHours).toFixed(0)} hours so far.`
    : '';

  return {
    result: `Hi ${student.firstName}! ${bookingInfo}${hoursInfo} How can I help you today?`,
    data: {
      studentId: student.id,
      upcomingBookings: upcoming.length,
    },
  };
}
```

### 7.5 `request_callback.ts`

```typescript
import type { FunctionCallResponse } from '../provider.interface';
import type { CallContext } from '../function-dispatcher.service';
import { scheduleCallback } from '../callback.service';

/**
 * Schedule a callback from Rob when the voice agent can't resolve the call.
 *
 * 1. Records the callback request in call_logs (requires_callback = true)
 * 2. Emits CALLBACK_REQUESTED event
 * 3. Notification Engine sends Rob an immediate SMS alert
 *
 * Rob sees: "[Callback] Sarah Chen (+61412345678) called about rescheduling. Prefers callback tomorrow morning."
 */
export async function handleRequestCallback(
  params: Record<string, unknown>,
  context: CallContext
): Promise<FunctionCallResponse> {
  const callerName = params.caller_name as string;
  const callerPhone = params.caller_phone as string;
  const reason = params.reason as string;
  const preferredTime = params.preferred_callback_time as string | undefined;
  const urgency = (params.urgency as string) ?? 'normal';

  await scheduleCallback({
    callId: context.callId,
    contactId: context.contactId,
    conversationId: context.conversationId,
    callerName,
    callerPhone,
    reason,
    preferredTime,
    urgency: urgency as 'low' | 'normal' | 'high',
  });

  const timeAck = preferredTime
    ? ` I've noted that you'd prefer a call back ${preferredTime}.`
    : '';

  return {
    result: `No worries, I've passed your message along to Rob.${timeAck} He'll give you a call as soon as he can. Is there anything else I can help with in the meantime?`,
    data: { callbackScheduled: true },
  };
}
```

---

## 8. Callback Service (`callback.service.ts`)

```typescript
import { db } from '@/lib/db';
import { callLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '@/lib/events';
import { parsePreferredTime } from './utils';

interface ScheduleCallbackParams {
  callId: string;
  contactId?: string;
  conversationId?: string;
  callerName: string;
  callerPhone: string;
  reason: string;
  preferredTime?: string;
  urgency: 'low' | 'normal' | 'high';
}

/**
 * Schedule a callback from Rob.
 *
 * Updates the call_log record with callback flags, then emits
 * CALLBACK_REQUESTED which the Notification Engine (SPEC-07) picks up.
 *
 * Notification Engine sends Rob an SMS like:
 * "[Callback] Sarah Chen (+61412345678) called about rescheduling.
 *  Prefers callback tomorrow morning. Urgency: normal"
 */
export async function scheduleCallback(params: ScheduleCallbackParams): Promise<void> {
  const callbackTime = params.preferredTime
    ? parsePreferredTime(params.preferredTime)
    : undefined;

  // Update the call_log record with callback info
  // Note: call_logs has created_at only (append-only per design),
  // but requires_callback and callback_scheduled_at are set at creation
  // or via update (call_logs is not append-only — only lessons/competencies/signatures/audit_log are)
  await db
    .update(callLogs)
    .set({
      requires_callback: true,
      callback_scheduled_at: callbackTime ?? null,
      caller_name: params.callerName,
      caller_reason: params.reason,
      resolution: 'callback_scheduled',
    })
    .where(eq(callLogs.external_call_id, params.callId));

  // Emit event → Notification Engine sends Rob an SMS
  emit({
    type: 'CALLBACK_REQUESTED',
    data: {
      callId: params.callId,
      contactId: params.contactId,
      callerName: params.callerName,
      callerPhone: params.callerPhone,
      reason: params.reason,
      preferredCallbackTime: callbackTime?.toISOString(),
      urgency: params.urgency,
    },
  });
}

/**
 * Mark a callback as completed (called from admin panel or manually).
 */
export async function completeCallback(callLogId: string): Promise<void> {
  await db
    .update(callLogs)
    .set({
      callback_completed_at: new Date(),
    })
    .where(eq(callLogs.id, callLogId));
}
```

---

## 9. Call Log Service (`call-log.service.ts`)

```typescript
import { db } from '@/lib/db';
import { callLogs, conversations, messages } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { CallEndedEvent } from './provider.interface';

interface CreateCallLogParams {
  externalCallId: string;
  callerPhone: string;
  contactId?: string;
  conversationId?: string;
  voiceProvider: string;
  callDirection?: 'inbound' | 'outbound';
  startedAt: Date;
}

/**
 * Create initial call log entry when a call starts.
 *
 * Called from the /voice/inbound webhook handler.
 * Returns the call log ID for later updates.
 */
export async function createCallLog(params: CreateCallLogParams): Promise<{ id: string }> {
  const [result] = await db
    .insert(callLogs)
    .values({
      external_call_id: params.externalCallId,
      caller_phone: params.callerPhone,
      contact_id: params.contactId,
      conversation_id: params.conversationId,
      voice_provider: params.voiceProvider,
      call_direction: params.callDirection ?? 'inbound',
      started_at: params.startedAt,
      outcome: 'answered',
    })
    .returning({ id: callLogs.id });

  return result;
}

/**
 * Finalise a call log with transcript, summary, outcome, and duration.
 *
 * Called from the /voice/event webhook handler when the call ends.
 * Idempotent — uses external_call_id for deduplication.
 */
export async function finaliseCallLog(
  externalCallId: string,
  event: CallEndedEvent
): Promise<void> {
  const outcome = mapEndReasonToOutcome(event.endReason);
  const resolution = event.summary?.toLowerCase().includes('callback')
    ? 'callback_scheduled'
    : event.summary?.toLowerCase().includes('booked')
      ? 'booking_made'
      : outcome === 'answered'
        ? 'resolved'
        : 'hung_up';

  await db
    .update(callLogs)
    .set({
      ended_at: event.endedAt,
      duration_seconds: event.durationSeconds,
      transcript: event.transcript,
      summary: event.summary,
      outcome,
      resolution,
    })
    .where(eq(callLogs.external_call_id, externalCallId));
}

/**
 * Store the call transcript as messages in the conversation thread.
 *
 * Parses the transcript into alternating user/assistant messages
 * and stores each as a message record, providing a unified timeline.
 */
export async function storeTranscriptAsMessages(
  conversationId: string,
  transcript: string
): Promise<void> {
  if (!transcript || !conversationId) return;

  // Parse transcript — Vapi format is typically:
  // "User: Hello\nAI: G'day! ...\nUser: I'd like...\nAI: ..."
  const lines = transcript.split('\n').filter(l => l.trim());
  const messageBatch = lines.map(line => {
    const isUser = line.startsWith('User:') || line.startsWith('Customer:');
    const content = line.replace(/^(User|Customer|AI|Assistant):\s*/i, '').trim();

    return {
      conversation_id: conversationId,
      direction: isUser ? 'inbound' : 'outbound' as const,
      sender_type: isUser ? 'user' : 'ai' as const,
      content,
    };
  }).filter(m => m.content.length > 0);

  if (messageBatch.length > 0) {
    await db.insert(messages).values(messageBatch);

    // Update conversation message count
    await db
      .update(conversations)
      .set({
        message_count: messageBatch.length,
        last_message_at: new Date(),
        status: 'closed',
      })
      .where(eq(conversations.id, conversationId));
  }
}

function mapEndReasonToOutcome(endReason: CallEndedEvent['endReason']): string {
  switch (endReason) {
    case 'caller_hangup':
    case 'assistant_hangup':
      return 'answered';
    case 'timeout':
      return 'missed';
    case 'error':
      return 'failed';
    default:
      return 'answered';
  }
}
```

---

## 10. Conversation Threading (`conversation.service.ts`)

```typescript
import { db } from '@/lib/db';
import { conversations } from '@/lib/db/schema';

interface CreateVoiceConversationParams {
  contactId?: string;
  callerPhone: string;
  userId?: string;  // Clerk user ID if known
}

/**
 * Create a conversation record for a voice call.
 *
 * Every voice call gets its own conversation (channel = 'voice').
 * The call_log links to this conversation, providing a unified
 * cross-channel timeline: voice calls, SMS threads, and web chats
 * all appear in the same contact's conversation history.
 */
export async function createVoiceConversation(
  params: CreateVoiceConversationParams
): Promise<{ id: string }> {
  const [result] = await db
    .insert(conversations)
    .values({
      contact_id: params.contactId,
      user_id: params.userId,
      channel: 'voice',
      channel_identifier: params.callerPhone,
      mode: 'prospect',  // Will be upgraded if caller is an existing student
      status: 'active',
      started_at: new Date(),
      last_message_at: new Date(),
      message_count: 0,
    })
    .returning({ id: conversations.id });

  return result;
}
```

---

## 11. Webhook Route Handlers

### 11.1 Inbound Call Handler (`/api/v1/voice/inbound/route.ts`)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getVoiceProvider } from '@/lib/voice';
import { createCallLog } from '@/lib/voice/call-log.service';
import { createVoiceConversation } from '@/lib/voice/conversation.service';
import { upsertFromChannel } from '@/lib/crm/auto-create.service';
import { logToAudit } from '@/lib/audit/audit.service';
import { rateLimiter } from '@/lib/rate-limit';

/**
 * POST /api/v1/voice/inbound
 *
 * Called by Vapi when an inbound call starts.
 * This is a webhook endpoint — no Clerk auth, verified by provider signature.
 *
 * Flow:
 * 1. Verify webhook signature
 * 2. Extract caller phone from event payload
 * 3. Upsert CRM contact from caller phone (SPEC-05 auto-create)
 * 4. Create conversation record (channel: 'voice')
 * 5. Create call_log record (initial: started, no transcript yet)
 * 6. Log to audit trail
 * 7. Return 200 immediately (Vapi expects fast response)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Rate limit: 20 inbound calls per minute (protect against webhook storms)
  const rateLimitResult = await rateLimiter.limit('voice:inbound', { max: 20, window: '1m' });
  if (!rateLimitResult.success) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  const provider = getVoiceProvider();
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers);

  // 1. Verify webhook
  let payload: Record<string, unknown>;
  try {
    payload = await provider.verifyWebhook(rawBody, headers);
  } catch {
    console.error('[Voice] Webhook verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    const messageType = (payload.message as any)?.type ?? payload.type;

    // Only process 'assistant-request' or 'call-started' type events
    if (messageType !== 'assistant-request' && messageType !== 'status-update') {
      return NextResponse.json({ ok: true });
    }

    const call = (payload.message as any)?.call ?? payload.call ?? {};
    const callId = call.id as string;
    const callerPhone = call.customer?.number as string ?? 'unknown';

    if (!callId) {
      return NextResponse.json({ ok: true });
    }

    // 2. Upsert CRM contact
    const { contact_id, is_new } = await upsertFromChannel(
      {
        phone: callerPhone,
        source: 'phone',
        source_detail: 'voice_inbound',
      },
      { role: 'system', clerkUserId: 'system' }
    );

    // 3. Create conversation record
    const conversation = await createVoiceConversation({
      contactId: contact_id,
      callerPhone,
    });

    // 4. Create call_log
    await createCallLog({
      externalCallId: callId,
      callerPhone,
      contactId: contact_id,
      conversationId: conversation.id,
      voiceProvider: provider.providerId,
      startedAt: new Date(call.startedAt ?? Date.now()),
    });

    // 5. Audit log
    await logToAudit({
      event_type: 'voice_call_started',
      actor_type: 'system',
      actor_id: 'voice_agent',
      subject_type: 'call_log',
      subject_id: callId,
      metadata: {
        caller_phone: callerPhone,
        contact_id,
        is_new_contact: is_new,
        provider: provider.providerId,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[Voice] Inbound webhook error:', error);
    // Return 200 anyway — don't make Vapi retry for our internal errors
    return NextResponse.json({ ok: true });
  }
}
```

### 11.2 Event Handler (`/api/v1/voice/event/route.ts`)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getVoiceProvider } from '@/lib/voice';
import { finaliseCallLog, storeTranscriptAsMessages } from '@/lib/voice/call-log.service';
import { logToAudit } from '@/lib/audit/audit.service';
import { emit } from '@/lib/events';
import { db } from '@/lib/db';
import { callLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { rateLimiter } from '@/lib/rate-limit';

/**
 * POST /api/v1/voice/event
 *
 * Called by Vapi when a call event occurs (call ended, transcript ready, etc.).
 * This is a webhook endpoint — no Clerk auth, verified by provider signature.
 *
 * Primary event: end-of-call-report
 * Contains: full transcript, AI-generated summary, duration, end reason.
 *
 * Flow:
 * 1. Verify webhook signature
 * 2. Parse call ended event
 * 3. Finalise call_log (transcript, summary, outcome, duration)
 * 4. Store transcript as conversation messages
 * 5. Emit CALL_COMPLETED event
 * 6. Audit log
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rateLimitResult = await rateLimiter.limit('voice:event', { max: 50, window: '1m' });
  if (!rateLimitResult.success) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  const provider = getVoiceProvider();
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers);

  // 1. Verify webhook
  let payload: Record<string, unknown>;
  try {
    payload = await provider.verifyWebhook(rawBody, headers);
  } catch {
    console.error('[Voice] Event webhook verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    const messageType = (payload.message as any)?.type ?? payload.type;

    // Only process end-of-call-report events
    if (messageType !== 'end-of-call-report') {
      return NextResponse.json({ ok: true });
    }

    // 2. Parse event
    const callEvent = provider.parseCallEndedEvent(payload);

    // Idempotency check: skip if already finalised
    const existing = await db
      .select({ id: callLogs.id, conversationId: callLogs.conversation_id, ended_at: callLogs.ended_at })
      .from(callLogs)
      .where(eq(callLogs.external_call_id, callEvent.callId))
      .limit(1)
      .then(rows => rows[0]);

    if (!existing) {
      console.warn(`[Voice] Call log not found for external ID: ${callEvent.callId}`);
      return NextResponse.json({ ok: true });
    }

    if (existing.ended_at) {
      // Already processed — idempotent
      return NextResponse.json({ ok: true });
    }

    // 3. Finalise call log
    await finaliseCallLog(callEvent.callId, callEvent);

    // 4. Store transcript as messages
    if (existing.conversationId) {
      await storeTranscriptAsMessages(existing.conversationId, callEvent.transcript);
    }

    // 5. Emit event
    emit({
      type: 'CALL_COMPLETED',
      data: {
        callLogId: existing.id,
        callerPhone: callEvent.callerPhone,
        durationSeconds: callEvent.durationSeconds,
        summary: callEvent.summary,
        transcript: callEvent.transcript,
      },
    });

    // 6. Audit log
    await logToAudit({
      event_type: 'voice_call_completed',
      actor_type: 'system',
      actor_id: 'voice_agent',
      subject_type: 'call_log',
      subject_id: existing.id,
      metadata: {
        external_call_id: callEvent.callId,
        duration_seconds: callEvent.durationSeconds,
        end_reason: callEvent.endReason,
        provider: provider.providerId,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[Voice] Event webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
```

### 11.3 Function Call Handler (`/api/v1/voice/function-call/route.ts`)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getVoiceProvider } from '@/lib/voice';
import { dispatchFunctionCall, type CallContext } from '@/lib/voice/function-dispatcher.service';
import { db } from '@/lib/db';
import { callLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { rateLimiter } from '@/lib/rate-limit';

/**
 * POST /api/v1/voice/function-call
 *
 * Called by Vapi when the assistant wants to invoke a function.
 * This is the critical latency path — must respond < 2 seconds (arch §11).
 *
 * Flow:
 * 1. Verify webhook signature
 * 2. Parse function call request
 * 3. Load call context (contact_id, conversation_id) from call_logs
 * 4. Dispatch to appropriate handler
 * 5. Format response for provider
 * 6. Return result (Vapi reads it aloud to the caller)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rateLimitResult = await rateLimiter.limit('voice:function', { max: 60, window: '1m' });
  if (!rateLimitResult.success) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  const provider = getVoiceProvider();
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers);

  // 1. Verify webhook
  let payload: Record<string, unknown>;
  try {
    payload = await provider.verifyWebhook(rawBody, headers);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    // 2. Parse function call
    const functionRequest = provider.parseFunctionCallRequest(payload);

    // 3. Load call context from existing call_log
    const callLog = await db
      .select({
        contactId: callLogs.contact_id,
        conversationId: callLogs.conversation_id,
      })
      .from(callLogs)
      .where(eq(callLogs.external_call_id, functionRequest.callId))
      .limit(1)
      .then(rows => rows[0]);

    const context: CallContext = {
      callId: functionRequest.callId,
      callerPhone: functionRequest.callerPhone,
      contactId: callLog?.contactId ?? undefined,
      conversationId: callLog?.conversationId ?? undefined,
    };

    // 4. Dispatch to handler
    const response = await dispatchFunctionCall(functionRequest, context);

    // 5. Format and return
    const formatted = provider.formatFunctionCallResponse(response);
    return NextResponse.json(formatted);
  } catch (error) {
    console.error('[Voice] Function call error:', error);

    // Return a graceful error message — never let the call crash
    const fallback = provider.formatFunctionCallResponse({
      result: "I'm sorry, I'm having a bit of trouble with that right now. Would you like me to take a message for Rob instead?",
    });
    return NextResponse.json(fallback);
  }
}
```

---

## 12. Event Types (`events.ts`)

Extend the `AppEvent` union defined in SPEC-03:

```typescript
// Add to the existing AppEvent union in src/lib/events/types.ts

| { type: 'CALL_COMPLETED'; data: {
    callLogId: string;
    callerPhone: string;
    durationSeconds: number;
    summary: string;
    transcript: string;
  }}
| { type: 'CALLBACK_REQUESTED'; data: {
    callId: string;
    contactId?: string;
    callerName: string;
    callerPhone: string;
    reason: string;
    preferredCallbackTime?: string;
    urgency: 'low' | 'normal' | 'high';
  }}
```

**Event subscribers (downstream):**

| Event | Subscribers |
|-------|------------|
| `CALL_COMPLETED` | CRM (update `last_contact_at`, increment `total_interactions`), Analytics (call volume tracking) |
| `CALLBACK_REQUESTED` | Notification Engine (immediate SMS to Rob per SPEC-07 `callback_scheduled` template), Admin Panel (callback queue) |

---

## 13. Types & Validation (`types.ts`)

```typescript
import { z } from 'zod';

// --- Zod schemas for input validation ---

export const VapiWebhookPayloadSchema = z.object({
  message: z.object({
    type: z.string(),
    call: z.object({
      id: z.string(),
      customer: z.object({
        number: z.string().optional(),
      }).optional(),
      startedAt: z.string().optional(),
      endedAt: z.string().optional(),
      endedReason: z.string().optional(),
    }).optional(),
    transcript: z.string().optional(),
    summary: z.string().optional(),
    recordingUrl: z.string().optional(),
    functionCall: z.object({
      name: z.string(),
      parameters: z.record(z.unknown()).optional(),
    }).optional(),
  }).optional(),
}).passthrough();

export const CheckAvailabilityParamsSchema = z.object({
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  service_type: z.enum(['learner-60', 'learner-90', 'learner-120', 'assessment', 'keys2drive']).optional(),
  time_preference: z.enum(['morning', 'afternoon', 'any']).optional(),
});

export const MakeBookingParamsSchema = z.object({
  caller_name: z.string().min(1),
  caller_phone: z.string().min(8),
  caller_email: z.string().email().optional(),
  service_slug: z.enum(['learner-60', 'learner-90', 'learner-120', 'assessment', 'keys2drive']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  pickup_address: z.string().optional(),
  booking_notes: z.string().optional(),
});

export const RequestCallbackParamsSchema = z.object({
  caller_name: z.string().min(1),
  caller_phone: z.string().min(8),
  reason: z.string().min(1),
  preferred_callback_time: z.string().optional(),
  urgency: z.enum(['low', 'normal', 'high']).default('normal'),
});

// --- Response types ---

export type CallOutcome = 'answered' | 'voicemail' | 'missed' | 'failed';
export type CallResolution = 'resolved' | 'booking_made' | 'message_taken' | 'callback_scheduled' | 'transferred' | 'hung_up';

export interface CallLogRecord {
  id: string;
  contact_id: string | null;
  conversation_id: string | null;
  caller_phone: string;
  call_direction: 'inbound' | 'outbound';
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number | null;
  outcome: CallOutcome;
  resolution: CallResolution | null;
  transcript: string | null;
  summary: string | null;
  caller_name: string | null;
  caller_reason: string | null;
  voice_provider: string;
  external_call_id: string;
  requires_callback: boolean;
  callback_scheduled_at: Date | null;
  callback_completed_at: Date | null;
  created_at: Date;
}
```

---

## 14. Error Classes (`errors.ts`)

```typescript
export class VoiceProviderError extends Error {
  constructor(
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'VoiceProviderError';
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Error thrown by function call handlers when they want to provide
 * a caller-friendly message instead of a generic error.
 */
export class VoiceFunctionError extends Error {
  constructor(
    message: string,
    /** Message that will be spoken to the caller */
    public callerFacingMessage: string
  ) {
    super(message);
    this.name = 'VoiceFunctionError';
  }
}
```

---

## 15. Constants (`constants.ts`)

```typescript
import { db } from '@/lib/db';
import { instructors } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const VAPI_API_BASE = 'https://api.vapi.ai';

export const VOICE_PROVIDER_IDS = ['vapi', 'bland', 'retell'] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

/** Max call duration in seconds (10 minutes) */
export const MAX_CALL_DURATION = 600;

/** Silence timeout before ending call (30 seconds) */
export const SILENCE_TIMEOUT = 30;

/** Confidence threshold below which the agent should take a message */
export const RAG_CONFIDENCE_THRESHOLD = 0.6;

/** Default instructor ID (Rob — solo operation) */
let _defaultInstructorId: string | null = null;

export async function getDefaultInstructorId(): Promise<string> {
  if (_defaultInstructorId) return _defaultInstructorId;

  const owner = await db
    .select({ id: instructors.id })
    .from(instructors)
    .where(eq(instructors.is_owner, true))
    .limit(1)
    .then(rows => rows[0]);

  if (!owner) throw new Error('No owner instructor found');
  _defaultInstructorId = owner.id;
  return _defaultInstructorId;
}
```

---

## 16. Environment Variables

Add to `.env.local` (and Vercel environment settings):

```bash
# Voice Agent — Vapi.ai
VOICE_PROVIDER=vapi
VAPI_API_KEY=                          # Vapi API key (from dashboard)
VAPI_WEBHOOK_SECRET=                   # Shared secret for webhook verification
VAPI_VOICE_ID=                         # ElevenLabs voice ID for Australian accent
VAPI_ASSISTANT_ID=                     # Set after first deployment via createAssistant()

# Internal API secret (for RAG and other internal-only endpoints)
INTERNAL_API_SECRET=                   # Shared secret for service-to-service calls
```

---

## 17. Setup & Deployment Script

```typescript
// scripts/setup-voice-agent.ts
// Run once during initial setup, then again whenever assistant config changes.

import { getVoiceProvider } from '@/lib/voice';
import { buildAssistantConfig } from '@/lib/voice/vapi.assistant-config';

async function main() {
  const provider = getVoiceProvider();
  const config = buildAssistantConfig();

  const existingId = process.env.VAPI_ASSISTANT_ID;

  if (existingId) {
    console.log(`Updating existing assistant: ${existingId}`);
    await provider.updateAssistant(existingId, config);
    console.log('✅ Assistant updated');
  } else {
    console.log('Creating new assistant...');
    const { assistantId } = await provider.createAssistant(config);
    console.log(`✅ Assistant created: ${assistantId}`);
    console.log(`⚠️  Add VAPI_ASSISTANT_ID=${assistantId} to your environment variables`);
  }
}

main().catch(console.error);
```

---

## 18. Testing Strategy

### 18.1 Unit Tests

| Test File | Coverage |
|-----------|----------|
| `vapi.adapter.test.ts` | Adapter methods: payload construction, response parsing, status mapping, end reason mapping |
| `call-log.service.test.ts` | Create call log, finalise call log, idempotency (double-finalise), transcript parsing |
| `function-dispatcher.test.ts` | Routing to correct handler, unknown function fallback, error handling returns caller-friendly message |
| `webhook-verify.test.ts` | Valid signature passes, invalid signature rejects, missing header rejects, tampered body rejects |
| `check-availability.test.ts` | Available slots found, no slots found, time preference filtering, date range defaults |
| `make-booking.test.ts` | Successful booking, slot conflict handling, CRM contact upsert, invalid service slug |
| `get-business-info.test.ts` | RAG returns high confidence, RAG returns low confidence triggers callback suggestion, RAG failure fallback |
| `get-student-info.test.ts` | Known student found, unknown phone, student with upcoming bookings, student with no bookings |
| `request-callback.test.ts` | Callback scheduled, CALLBACK_REQUESTED event emitted, preferred time parsing |
| `callback.service.test.ts` | Schedule callback, complete callback, event emission |

### 18.2 Integration Tests

| Test File | Scenario |
|-----------|----------|
| `inbound-call-flow.test.ts` | Full inbound call: webhook → contact upsert → conversation → call_log → verify all records created |
| `function-call-flow.test.ts` | Function call webhook → dispatcher → handler → response format. Test each function with mocked services. |

### 18.3 Manual E2E Testing

Before going live, test the full flow with a real Vapi assistant:

1. Configure Vapi assistant with test webhook URLs (ngrok or Vercel preview)
2. Call the Vapi test number
3. Verify: greeting plays, questions are answered via RAG, availability check returns real slots, booking creates a real booking record, callback request triggers SMS to Rob's phone
4. After call: verify call_log has transcript and summary, conversation record exists, CRM contact was created/updated

---

## 19. Performance Optimisation

| Concern | Strategy |
|---------|----------|
| Function call latency (<2s) | Pre-cache default instructor ID. Booking availability query is optimised (SPEC-03). RAG query runs against local pgvector (Neon Sydney). |
| Webhook processing speed | Return 200 immediately on inbound hook. Async processing for non-critical operations (audit log, analytics). |
| Database query count per function call | Single query per handler where possible. `getDefaultInstructorId()` cached in module scope. |
| RAG query latency | Target <1.5s from voice function handler. RAG engine (SPEC pending) should target <1s for cached queries. |
| Concurrent calls | Redis rate limiting prevents webhook flooding. Each call gets independent records — no shared state between calls. |

---

## 20. Security Considerations

| Concern | Mitigation |
|---------|------------|
| Webhook authentication | Vapi signature verification on all three endpoints. Secret stored in env var, never committed. |
| Rate limiting | Per-endpoint rate limits via Upstash Redis (20/min inbound, 60/min function-call, 50/min event). |
| Caller data exposure | `get_student_info` returns only first name, upcoming bookings, total hours. Never returns: private notes, payment details, competency breakdown, other students' data. |
| Input validation | All function call parameters validated with Zod schemas before processing. |
| SQL injection | Drizzle ORM parameterised queries only. No raw SQL. |
| Audit trail | Every call start and end logged to audit trail with actor_type = 'system', actor_id = 'voice_agent'. |
| PII in transcripts | Call transcripts contain caller speech. Stored in call_logs (access: admin only per RBAC matrix). Not accessible to students or parents. |

---

## 21. Dependencies

```json
{
  "dependencies": {
    "date-fns": "^3.x",
    "date-fns-tz": "^3.x",
    "zod": "^3.x"
  }
}
```

No Vapi SDK required — we use the Vapi REST API directly via `fetch()`. This keeps the dependency surface minimal and makes the adapter pattern cleaner (no provider-specific SDK to abstract away).

---

## 22. Deployment Checklist

- [ ] Environment variables set in Vercel (VAPI_API_KEY, VAPI_WEBHOOK_SECRET, VAPI_VOICE_ID, INTERNAL_API_SECRET)
- [ ] Run `scripts/setup-voice-agent.ts` to create/update Vapi assistant
- [ ] Set VAPI_ASSISTANT_ID in environment after first run
- [ ] Configure Vapi phone number to forward NexDrive business calls
- [ ] Verify webhook URLs are accessible (Vercel deployment)
- [ ] Test inbound call flow end-to-end
- [ ] Verify CRM contact creation from test call
- [ ] Verify callback notification reaches Rob's phone
- [ ] Monitor Sentry for first 24 hours of live traffic
- [ ] Review first 10 call transcripts for quality and accuracy

---

## 23. Future Enhancements (Out of Scope for v1)

1. **Outbound calls** — Proactive calls for booking reminders, payment follow-ups
2. **Call transfer to Rob** — Live transfer when caller requests a human (requires Vapi call forwarding)
3. **Voicemail handling** — Detect voicemail, leave message, transcribe
4. **Multi-language** — Mandarin, Hindi, Arabic support for Canberra's diverse population
5. **Sentiment analysis** — Real-time caller sentiment tracking, escalate frustrated callers
6. **Call recording storage** — Store audio files in Cloudflare R2 (currently transcript-only)
7. **After-hours IVR** — Different greeting and routing outside business hours
8. **Multiple phone numbers** — Per-instructor routing when contractors join

---

*End of SPEC-09: Voice Agent Integration*

*Depends on: SPEC-01 (DB), SPEC-02 (Auth), SPEC-03 (Booking Engine), SPEC-05 (CRM), SPEC-07 (Notification Engine)*  
*Depended on by: SPEC-10 (SMS Agent — shared patterns), SPEC-11 (Web Chat — shared RAG integration)*
