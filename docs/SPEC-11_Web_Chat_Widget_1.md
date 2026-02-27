# SPEC-11: Web Chat Widget (C04)

**Component:** C04 — Web Chat Widget
**Phase:** 2 (AI Communication, Weeks 7–12)
**Status:** Draft v1.0
**Depends On:** SPEC-01 (Database Schema), SPEC-05 (CRM Contacts API), SPEC-08 (RAG Knowledge Engine)
**Consumed By:** C01 (Public Website), C03 (Student Portal)

---

## 1. Purpose

The Web Chat Widget is an embeddable AI chat interface for the NexDrive Academy website. It handles prospect enquiries (unauthenticated), personalised student guidance (authenticated), and parent coaching support (authenticated). All AI processing is delegated to the RAG Knowledge Engine (SPEC-08) — this spec covers the frontend component, the public-facing API route that wraps the internal RAG endpoint, session management, CRM integration, and embedding strategy.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│                                                              │
│  ┌──────────────────────────┐                                │
│  │  ChatBubble              │  ← Floating bottom-right       │
│  │  ┌────────────────────┐  │                                │
│  │  │  ChatWindow         │  │  ← Expand/collapse panel     │
│  │  │  ┌──────────────┐  │  │                                │
│  │  │  │ MessageList   │  │  │  ← Scrollable history        │
│  │  │  │ TypingIndicator│ │  │                                │
│  │  │  │ SuggestedActions│ │  │  ← Clickable action buttons │
│  │  │  │ InputBar       │  │  │  ← Text + send              │
│  │  │  └──────────────┘  │  │                                │
│  │  └────────────────────┘  │                                │
│  └──────────────────────────┘                                │
│                                                              │
│  localStorage: session_id, message_cache                     │
└────────────────────┬────────────────────────────────────────┘
                     │  POST /api/v1/chat/message
                     │  (streaming SSE response)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Next.js API Route (public)                                  │
│  /api/v1/chat/message                                        │
│                                                              │
│  1. Rate limit (Upstash: 15 req/min per session)             │
│  2. Validate input (Zod)                                     │
│  3. Resolve auth context (Clerk session, if present)         │
│  4. CRM upsert on first message (upsertFromChannel)         │
│  5. Delegate to internal RAG: POST /api/internal/rag/query   │
│  6. Stream response back via SSE                             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  RAG Knowledge Engine (SPEC-08)                              │
│  POST /api/internal/rag/query                                │
│                                                              │
│  Intent classification → vector search → Claude generation   │
│  Returns: answer, sources, confidence, suggested_actions,    │
│           handoff_requested, booking_entities, session_id     │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Modes of Operation

| Mode | Trigger | Context Available | Welcome Message |
|------|---------|-------------------|-----------------|
| **Prospect** | No Clerk session token | None — general knowledge only | "Hi! I'm NexDrive's AI assistant. I can answer questions about lessons, pricing, the CBT&A process, or help you book. What would you like to know?" |
| **Student** | Clerk session with `role=student` | Completed tasks, current task, lesson history, upcoming bookings, logbook hours | "Hey {first_name}! I've got your progress loaded — ask me anything about your lessons, what to practice, or book your next session." |
| **Parent** | Clerk session with `role=parent` | Linked student's progress, recent Lesson Bridge Forms, recommended practice areas | "Hi {first_name}! I can help you support {student_name}'s driving journey — ask about their progress, what to practice, or coaching tips." |

Mode detection logic:

```typescript
function resolveMode(auth: AuthContext | null): 'prospect' | 'student' | 'parent' {
  if (!auth) return 'prospect';
  if (auth.role === 'student') return 'student';
  if (auth.role === 'parent') return 'parent';
  return 'prospect'; // instructors/admins fall back to prospect chat
}
```

---

## 4. File Structure

```
src/
├── components/
│   └── chat/
│       ├── ChatBubble.tsx              # Floating button + notification badge
│       ├── ChatWindow.tsx              # Main chat container
│       ├── MessageList.tsx             # Scrollable message history
│       ├── MessageBubble.tsx           # Single message (user/ai/system)
│       ├── TypingIndicator.tsx         # Animated dots during AI response
│       ├── SuggestedActions.tsx        # Clickable action buttons
│       ├── InputBar.tsx                # Text input + send button
│       ├── HandoffBanner.tsx           # "Rob will follow up" banner
│       ├── LeadCaptureForm.tsx         # Name + phone + email (inline)
│       ├── ChatProvider.tsx            # React context: state + session
│       └── index.ts                    # Public export
├── hooks/
│   └── useChat.ts                      # Chat state management hook
├── lib/
│   └── chat/
│       ├── types.ts                    # Chat-specific types + Zod schemas
│       ├── constants.ts                # Config values
│       ├── session.ts                  # localStorage session management
│       ├── api.ts                      # API client (fetch + SSE reader)
│       └── analytics.ts               # Chat event tracking
└── app/
    └── api/
        └── v1/
            └── chat/
                ├── message/route.ts    # POST — send message, get AI response
                ├── conversations/
                │   └── route.ts        # GET — list user's conversations
                ├── conversations/
                │   └── [id]/route.ts   # GET — conversation history
                ├── lead/route.ts       # POST — capture prospect lead info
                └── handoff/route.ts    # POST — request human handoff
```

---

## 5. Types & Zod Schemas

```typescript
// src/lib/chat/types.ts

import { z } from 'zod';

// ─── API Request ─────────────────────────────────

export const ChatMessageInput = z.object({
  message: z.string().min(1).max(2000),
  session_id: z.string().uuid().optional(),
  page_url: z.string().url().max(500).optional(),
});
export type ChatMessageInput = z.infer<typeof ChatMessageInput>;

// ─── API Response (JSON, non-streaming fallback) ──

export const ChatMessageResponse = z.object({
  answer: z.string(),
  session_id: z.string().uuid(),
  sources: z.array(z.object({
    title: z.string(),
    chunk_preview: z.string(),
    score: z.number(),
  })).optional(),
  confidence: z.number().min(0).max(1),
  intent: z.string(),
  suggested_actions: z.array(z.enum([
    'book_lesson',
    'view_pricing',
    'view_availability',
    'call_us',
    'view_competency_hub',
    'handoff_to_human',
    'provide_phone',
    'provide_email',
  ])).optional(),
  handoff_requested: z.boolean(),
  booking_entities: z.object({
    service_type: z.string().optional(),
    preferred_date: z.string().optional(),
    preferred_time: z.string().optional(),
  }).optional(),
});
export type ChatMessageResponse = z.infer<typeof ChatMessageResponse>;

// ─── SSE Stream Events ───────────────────────────

export type StreamEvent =
  | { type: 'token'; data: string }              // Partial answer token
  | { type: 'metadata'; data: ChatMetadata }      // Final metadata (after stream)
  | { type: 'error'; data: { code: string; message: string } }
  | { type: 'done' };

export interface ChatMetadata {
  session_id: string;
  confidence: number;
  intent: string;
  suggested_actions?: string[];
  handoff_requested: boolean;
  sources?: Array<{ title: string; chunk_preview: string; score: number }>;
  booking_entities?: Record<string, string>;
}

// ─── Lead Capture ────────────────────────────────

export const LeadCaptureInput = z.object({
  session_id: z.string().uuid(),
  first_name: z.string().min(1).max(100).optional(),
  phone: z.string().regex(/^(\+61|0)[2-578]\d{8}$/).optional(),
  email: z.string().email().max(255).optional(),
  question: z.string().max(1000).optional(),
}).refine(
  (data) => data.phone || data.email,
  { message: 'At least one of phone or email is required' }
);
export type LeadCaptureInput = z.infer<typeof LeadCaptureInput>;

// ─── Handoff Request ─────────────────────────────

export const HandoffRequestInput = z.object({
  session_id: z.string().uuid(),
  reason: z.string().max(500).optional(),
});
export type HandoffRequestInput = z.infer<typeof HandoffRequestInput>;

// ─── Client-Side Message Model ───────────────────

export interface ChatMessage {
  id: string;                            // Client-generated UUID
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  status: 'sending' | 'sent' | 'streaming' | 'error';
  suggested_actions?: string[];
  confidence?: number;
  sources?: Array<{ title: string; chunk_preview: string }>;
  handoff_requested?: boolean;
}

// ─── Chat Session (persisted to localStorage) ────

export interface ChatSession {
  session_id: string;
  mode: 'prospect' | 'student' | 'parent';
  messages: ChatMessage[];
  created_at: string;                    // ISO timestamp
  last_activity: string;                 // ISO timestamp
  contact_captured: boolean;             // Has lead info been captured?
  handoff_active: boolean;               // Is human handoff in progress?
}
```

---

## 6. Constants & Configuration

```typescript
// src/lib/chat/constants.ts

export const CHAT_CONFIG = {
  // Session
  session_ttl_ms: 30 * 60 * 1000,        // 30 minutes inactivity → new session
  local_storage_key: 'nexdrive_chat',
  max_local_messages: 100,                 // Trim oldest when exceeded

  // UI dimensions
  bubble_size: 56,                         // px (44px minimum touch target + padding)
  bubble_offset_right: 24,                 // px from right edge
  bubble_offset_bottom: 24,                // px from bottom edge

  window_width_desktop: 400,               // px
  window_height_desktop: 540,              // px (including header)
  window_max_height_desktop: '80vh',

  // Input
  max_message_length: 2000,
  min_message_length: 1,

  // Rate limiting (client-side throttle)
  min_send_interval_ms: 1000,              // 1 second between messages
  max_messages_per_minute: 12,             // Client-side guard

  // Animations
  animation_duration_ms: 300,              // Expand/collapse
  typing_indicator_delay_ms: 500,          // Show after 500ms if no tokens yet

  // Notification badge
  badge_dismiss_after_ms: 5000,            // Auto-dismiss after 5s if chat opened

  // Handoff
  handoff_estimated_response_minutes: 30,  // "Rob typically responds within 30 minutes"
  handoff_business_hours: {
    start: 8,                              // 8:00 AM AEST
    end: 18,                               // 6:00 PM AEST
    timezone: 'Australia/Canberra',
  },
} as const;

// ─── Suggested Action Configuration ──────────────

export const SUGGESTED_ACTION_CONFIG: Record<string, {
  label: string;
  icon: string;         // Lucide icon name
  action: 'navigate' | 'message' | 'callback';
  target?: string;      // URL for navigate, message text for message
}> = {
  book_lesson: {
    label: 'Book a Lesson',
    icon: 'Calendar',
    action: 'navigate',
    target: '/book',
  },
  view_pricing: {
    label: 'See Pricing',
    icon: 'DollarSign',
    action: 'navigate',
    target: '/services#pricing',
  },
  view_availability: {
    label: 'Check Availability',
    icon: 'Clock',
    action: 'navigate',
    target: '/book',
  },
  call_us: {
    label: 'Call Rob',
    icon: 'Phone',
    action: 'navigate',
    target: 'tel:+61XXXXXXXXX',       // Rob's number — env var
  },
  view_competency_hub: {
    label: 'Competency Hub',
    icon: 'BookOpen',
    action: 'navigate',
    target: '/competency-hub',
  },
  handoff_to_human: {
    label: 'Talk to Rob',
    icon: 'MessageSquare',
    action: 'callback',
  },
  provide_phone: {
    label: 'Share My Number',
    icon: 'Phone',
    action: 'callback',               // Opens lead capture form
  },
  provide_email: {
    label: 'Share My Email',
    icon: 'Mail',
    action: 'callback',               // Opens lead capture form
  },
} as const;

// ─── Welcome Messages (by mode) ──────────────────

export const WELCOME_MESSAGES: Record<string, string> = {
  prospect: "Hi! I'm NexDrive's AI assistant. I can answer questions about lessons, pricing, the CBT&A process, or help you book. What would you like to know?",
  student: "Hey {first_name}! I've got your progress loaded — ask me anything about your lessons, what to practice, or book your next session.",
  parent: "Hi {first_name}! I can help you support {student_name}'s driving journey — ask about their progress, what to practice, or coaching tips.",
} as const;

// ─── Initial Suggested Actions (by mode) ─────────

export const INITIAL_SUGGESTIONS: Record<string, string[]> = {
  prospect: ['book_lesson', 'view_pricing', 'call_us'],
  student: ['book_lesson', 'view_competency_hub'],
  parent: ['view_competency_hub'],
} as const;
```

---

## 7. Session Management

Sessions are tracked both server-side (in the `conversations` table, managed by SPEC-08) and client-side (in localStorage for message display and session continuity across page navigations).

```typescript
// src/lib/chat/session.ts

import { v4 as uuidv4 } from 'uuid';
import { CHAT_CONFIG } from './constants';
import type { ChatSession, ChatMessage } from './types';

const STORAGE_KEY = CHAT_CONFIG.local_storage_key;

/**
 * Get or create a chat session.
 *
 * Rules:
 * - If no session exists in localStorage → create new
 * - If session exists but last_activity > 30 min ago → archive and create new
 * - If session exists and fresh → resume
 *
 * The session_id here is used as the RAG Engine's session_id,
 * which maps to conversations.id in the database.
 */
export function getOrCreateSession(mode: 'prospect' | 'student' | 'parent'): ChatSession {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const session: ChatSession = JSON.parse(stored);
      const lastActivity = new Date(session.last_activity).getTime();
      const now = Date.now();

      if (now - lastActivity < CHAT_CONFIG.session_ttl_ms) {
        // Session still fresh — update mode if auth changed
        if (session.mode !== mode) {
          session.mode = mode;
          saveSession(session);
        }
        return session;
      }

      // Session expired — archive messages to sessionStorage for potential review
      try {
        sessionStorage.setItem(
          `${STORAGE_KEY}_archive_${session.session_id}`,
          stored
        );
      } catch { /* sessionStorage full — discard silently */ }
    }
  } catch {
    // localStorage unavailable or corrupted — create fresh
  }

  return createNewSession(mode);
}

function createNewSession(mode: 'prospect' | 'student' | 'parent'): ChatSession {
  const session: ChatSession = {
    session_id: uuidv4(),
    mode,
    messages: [],
    created_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    contact_captured: false,
    handoff_active: false,
  };
  saveSession(session);
  return session;
}

export function saveSession(session: ChatSession): void {
  try {
    session.last_activity = new Date().toISOString();

    // Trim messages if over limit
    if (session.messages.length > CHAT_CONFIG.max_local_messages) {
      session.messages = session.messages.slice(-CHAT_CONFIG.max_local_messages);
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage full — clear old data and retry
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch { /* Truly full — operate without persistence */ }
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* noop */ }
}

export function addMessage(session: ChatSession, message: ChatMessage): ChatSession {
  return {
    ...session,
    messages: [...session.messages, message],
    last_activity: new Date().toISOString(),
  };
}

export function updateMessageStatus(
  session: ChatSession,
  messageId: string,
  updates: Partial<ChatMessage>
): ChatSession {
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.id === messageId ? { ...m, ...updates } : m
    ),
  };
}
```

---

## 8. API Client (with SSE Streaming)

```typescript
// src/lib/chat/api.ts

import type { ChatMessageInput, ChatMessageResponse, StreamEvent, ChatMetadata } from './types';

const API_BASE = '/api/v1';

/**
 * Send a chat message and receive a streaming response.
 *
 * Uses Server-Sent Events (SSE) for token-by-token streaming.
 * Falls back to JSON response if streaming is not supported.
 *
 * @param input - Message text + session context
 * @param onToken - Callback for each partial answer token
 * @param onMetadata - Callback when metadata arrives (after stream completes)
 * @param onError - Callback on error
 * @param signal - AbortController signal for cancellation
 */
export async function sendMessage(
  input: ChatMessageInput,
  callbacks: {
    onToken: (token: string) => void;
    onMetadata: (metadata: ChatMetadata) => void;
    onError: (error: { code: string; message: string }) => void;
    onDone: () => void;
  },
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_BASE}/chat/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    callbacks.onError({
      code: body?.error?.code ?? 'HTTP_ERROR',
      message: body?.error?.message ?? `Request failed (${res.status})`,
    });
    return;
  }

  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    // ─── Streaming path ────────────────────────
    await readSSEStream(res.body!, callbacks);
  } else {
    // ─── JSON fallback ─────────────────────────
    const data: ChatMessageResponse = await res.json();
    callbacks.onToken(data.answer);
    callbacks.onMetadata({
      session_id: data.session_id,
      confidence: data.confidence,
      intent: data.intent,
      suggested_actions: data.suggested_actions,
      handoff_requested: data.handoff_requested,
      sources: data.sources,
      booking_entities: data.booking_entities as Record<string, string> | undefined,
    });
    callbacks.onDone();
  }
}

async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  callbacks: {
    onToken: (token: string) => void;
    onMetadata: (metadata: ChatMetadata) => void;
    onError: (error: { code: string; message: string }) => void;
    onDone: () => void;
  }
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          // Named event — next data line is its payload
          continue;
        }
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6); // Remove 'data: '
        if (data === '[DONE]') {
          callbacks.onDone();
          return;
        }

        try {
          const event: StreamEvent = JSON.parse(data);
          switch (event.type) {
            case 'token':
              callbacks.onToken(event.data);
              break;
            case 'metadata':
              callbacks.onMetadata(event.data);
              break;
            case 'error':
              callbacks.onError(event.data);
              return;
          }
        } catch {
          // Non-JSON line — treat as raw token
          callbacks.onToken(data);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Submit lead capture information.
 */
export async function captureLead(input: {
  session_id: string;
  first_name?: string;
  phone?: string;
  email?: string;
  question?: string;
}): Promise<{ contact_id: string }> {
  const res = await fetch(`${API_BASE}/chat/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to capture lead');
  const body = await res.json();
  return body.data;
}

/**
 * Request human handoff.
 */
export async function requestHandoff(input: {
  session_id: string;
  reason?: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/chat/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to request handoff');
}
```

---

## 9. API Routes

### 9.1 POST `/api/v1/chat/message` — Send Message

This is the primary public endpoint. It wraps the internal RAG query endpoint with rate limiting, auth resolution, CRM upsert, and SSE streaming.

```typescript
// src/app/api/v1/chat/message/route.ts

import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ChatMessageInput } from '@/lib/chat/types';
import { rateLimit } from '@/lib/rate-limit';
import { upsertFromChannel } from '@/lib/crm/auto-create.service';
import { trackEvent } from '@/lib/analytics';

const INTERNAL_RAG_URL = `${process.env.NEXT_PUBLIC_APP_URL}/api/internal/rag/query`;
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET!;

export async function POST(req: NextRequest) {
  try {
    // ─── 1. Parse & validate ─────────────────────
    const body = await req.json();
    const input = ChatMessageInput.parse(body);

    // ─── 2. Rate limit (by session or IP) ────────
    const sessionKey = input.session_id || req.ip || 'anonymous';
    const { success } = await rateLimit(`chat:${sessionKey}`, 15, 60);
    if (!success) {
      return Response.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many messages. Please wait a moment.' } },
        { status: 429 }
      );
    }

    // ─── 3. Resolve auth context ─────────────────
    const { userId, sessionClaims } = await auth();
    const role = sessionClaims?.role as string | undefined;
    const studentId = sessionClaims?.student_id as string | undefined;

    let mode: 'prospect' | 'student' | 'parent' = 'prospect';
    if (userId && role === 'student') mode = 'student';
    else if (userId && role === 'parent') mode = 'parent';

    // ─── 4. CRM upsert (first message only) ─────
    // The RAG engine creates the conversation; we handle CRM contact.
    // Only upsert if this looks like a new session (no session_id provided).
    let contactId: string | undefined;
    if (!input.session_id) {
      try {
        // For authenticated users, upsert with their known details.
        // For prospects, the contact is created minimally and enriched
        // when they submit the lead capture form.
        if (userId) {
          const { contact_id } = await upsertFromChannel({
            source: 'web_chat',
            source_detail: input.page_url || 'chat widget',
          }, { userId, role: role || 'prospect' } as any);
          contactId = contact_id;
        }
      } catch (error) {
        // CRM upsert failure is non-blocking
        console.error('Chat CRM upsert failed:', error);
      }
    }

    // ─── 5. Build RAG query ──────────────────────
    const ragInput = {
      query: input.message,
      context: {
        channel: 'web_chat' as const,
        session_id: input.session_id,
        user_id: userId || undefined,
        student_id: studentId,
        page_url: input.page_url,
      },
    };

    // ─── 6. Call internal RAG endpoint ───────────
    const ragResponse = await fetch(INTERNAL_RAG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
        'X-Session-Id': input.session_id || 'new',
      },
      body: JSON.stringify(ragInput),
    });

    if (!ragResponse.ok) {
      const error = await ragResponse.json().catch(() => ({}));
      return Response.json(
        { error: { code: 'RAG_ERROR', message: 'Failed to generate response' } },
        { status: 502 }
      );
    }

    const ragResult = await ragResponse.json();

    // ─── 7. Track analytics ──────────────────────
    trackEvent('chat_message_sent', {
      mode,
      intent: ragResult.intent,
      confidence: ragResult.confidence,
      handoff: ragResult.handoff_requested,
      session_id: ragResult.session_id,
    });

    // ─── 8. Return as SSE stream or JSON ─────────
    const acceptsSSE = req.headers.get('accept')?.includes('text/event-stream');

    if (acceptsSSE) {
      // Stream the answer token-by-token for perceived speed.
      // In v1, we simulate streaming by chunking the complete answer.
      // In v2, pipe Claude's stream directly through.
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Stream answer in word-sized chunks
          const words = ragResult.answer.split(' ');
          let i = 0;

          function sendNext() {
            if (i < words.length) {
              const token = (i === 0 ? '' : ' ') + words[i];
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: 'token', data: token })}\n\n`)
              );
              i++;
              // Simulate natural typing speed: 20-40ms per word
              setTimeout(sendNext, 25);
            } else {
              // Send metadata after all tokens
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({
                  type: 'metadata',
                  data: {
                    session_id: ragResult.session_id,
                    confidence: ragResult.confidence,
                    intent: ragResult.intent,
                    suggested_actions: ragResult.suggested_actions,
                    handoff_requested: ragResult.handoff_requested,
                    sources: ragResult.sources?.map((s: any) => ({
                      title: s.title,
                      chunk_preview: s.chunk_content,
                      score: s.score,
                    })),
                    booking_entities: ragResult.booking_entities,
                  },
                })}\n\n`)
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          }

          sendNext();
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    // JSON fallback
    return Response.json({
      data: {
        answer: ragResult.answer,
        session_id: ragResult.session_id,
        confidence: ragResult.confidence,
        intent: ragResult.intent,
        suggested_actions: ragResult.suggested_actions,
        handoff_requested: ragResult.handoff_requested,
        sources: ragResult.sources?.map((s: any) => ({
          title: s.title,
          chunk_preview: s.chunk_content,
          score: s.score,
        })),
        booking_entities: ragResult.booking_entities,
      },
    });

  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return Response.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid message format' } },
        { status: 422 }
      );
    }
    console.error('Chat message error:', error);
    return Response.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } },
      { status: 500 }
    );
  }
}
```

### 9.2 POST `/api/v1/chat/lead` — Lead Capture

```typescript
// src/app/api/v1/chat/lead/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { LeadCaptureInput } from '@/lib/chat/types';
import { upsertFromChannel } from '@/lib/crm/auto-create.service';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Capture prospect contact info during chat.
 * Creates/updates a contact in the CRM with source='web_chat'.
 * 
 * Called when:
 * - User clicks "Talk to Rob" → lead form appears
 * - User provides phone/email proactively
 * - AI detects booking intent and needs contact info
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = LeadCaptureInput.parse(body);

    // Rate limit by session
    const { success } = await rateLimit(`lead:${input.session_id}`, 3, 300);
    if (!success) {
      return NextResponse.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
        { status: 429 }
      );
    }

    // System auth context for CRM upsert (no user session for prospects)
    const systemAuth = { role: 'system', isInternal: true } as any;

    const { contact_id, is_new } = await upsertFromChannel({
      first_name: input.first_name,
      phone: input.phone,
      email: input.email,
      source: 'web_chat',
      source_detail: `Chat lead capture (session: ${input.session_id})`,
    }, systemAuth);

    return NextResponse.json({
      data: { contact_id, is_new },
    });

  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('Lead capture error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to save contact info' } },
      { status: 500 }
    );
  }
}
```

### 9.3 POST `/api/v1/chat/handoff` — Request Human Handoff

```typescript
// src/app/api/v1/chat/handoff/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { HandoffRequestInput } from '@/lib/chat/types';
import { flagForHandoff } from '@/lib/rag/conversation.service';
import { eventBus } from '@/lib/events';

/**
 * Explicitly request human handoff.
 * Updates conversation status and notifies Rob.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = HandoffRequestInput.parse(body);

    await flagForHandoff(
      input.session_id,
      input.reason || 'User requested human handoff via chat widget'
    );

    // Emit event → Notification Engine sends Rob an alert
    eventBus.emit({
      type: 'CALLBACK_REQUESTED',
      data: {
        session_id: input.session_id,
        channel: 'web_chat',
        reason: input.reason || 'Human handoff requested',
      },
    });

    return NextResponse.json({
      data: {
        status: 'handoff_requested',
        message: 'Rob will follow up as soon as possible.',
      },
    });

  } catch (error) {
    console.error('Handoff request error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to process handoff' } },
      { status: 500 }
    );
  }
}
```

---

## 10. React Components

### 10.1 ChatProvider — State Context

```typescript
// src/components/chat/ChatProvider.tsx

'use client';

import React, { createContext, useContext, useReducer, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateSession, saveSession, addMessage, updateMessageStatus } from '@/lib/chat/session';
import { sendMessage, captureLead, requestHandoff } from '@/lib/chat/api';
import { CHAT_CONFIG, WELCOME_MESSAGES, INITIAL_SUGGESTIONS } from '@/lib/chat/constants';
import type { ChatSession, ChatMessage, ChatMetadata } from '@/lib/chat/types';

interface ChatState {
  isOpen: boolean;
  session: ChatSession | null;
  isTyping: boolean;         // AI is generating response
  hasUnread: boolean;        // Notification badge
  error: string | null;
}

type ChatAction =
  | { type: 'TOGGLE_OPEN' }
  | { type: 'SET_SESSION'; session: ChatSession }
  | { type: 'ADD_MESSAGE'; message: ChatMessage }
  | { type: 'UPDATE_MESSAGE'; id: string; updates: Partial<ChatMessage> }
  | { type: 'SET_TYPING'; isTyping: boolean }
  | { type: 'SET_UNREAD'; hasUnread: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_HANDOFF'; active: boolean };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'TOGGLE_OPEN':
      return { ...state, isOpen: !state.isOpen, hasUnread: false };
    case 'SET_SESSION':
      return { ...state, session: action.session };
    case 'ADD_MESSAGE':
      if (!state.session) return state;
      return {
        ...state,
        session: addMessage(state.session, action.message),
      };
    case 'UPDATE_MESSAGE':
      if (!state.session) return state;
      return {
        ...state,
        session: updateMessageStatus(state.session, action.id, action.updates),
      };
    case 'SET_TYPING':
      return { ...state, isTyping: action.isTyping };
    case 'SET_UNREAD':
      return { ...state, hasUnread: action.hasUnread };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'SET_HANDOFF':
      if (!state.session) return state;
      return {
        ...state,
        session: { ...state.session, handoff_active: action.active },
      };
    default:
      return state;
  }
}

interface ChatContextValue {
  state: ChatState;
  send: (text: string) => Promise<void>;
  toggle: () => void;
  submitLead: (data: { first_name?: string; phone?: string; email?: string }) => Promise<void>;
  triggerHandoff: (reason?: string) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { userId, sessionClaims } = useAuth();
  const [state, dispatch] = useReducer(chatReducer, {
    isOpen: false,
    session: null,
    isTyping: false,
    hasUnread: false,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  // ─── Initialise session on mount ─────────────
  useEffect(() => {
    const role = sessionClaims?.role as string | undefined;
    let mode: 'prospect' | 'student' | 'parent' = 'prospect';
    if (userId && role === 'student') mode = 'student';
    else if (userId && role === 'parent') mode = 'parent';

    const session = getOrCreateSession(mode);

    // Add welcome message if this is a brand-new session
    if (session.messages.length === 0) {
      let welcomeText = WELCOME_MESSAGES[mode];
      // Replace placeholders for authenticated modes
      if (mode === 'student' && sessionClaims?.first_name) {
        welcomeText = welcomeText.replace('{first_name}', sessionClaims.first_name as string);
      }
      if (mode === 'parent' && sessionClaims?.first_name) {
        welcomeText = welcomeText
          .replace('{first_name}', sessionClaims.first_name as string)
          .replace('{student_name}', 'your learner'); // Will be enriched via API
      }

      const welcomeMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: welcomeText,
        timestamp: new Date(),
        status: 'sent',
        suggested_actions: INITIAL_SUGGESTIONS[mode] as string[],
      };
      session.messages.push(welcomeMsg);
    }

    dispatch({ type: 'SET_SESSION', session });
  }, [userId, sessionClaims]);

  // ─── Persist session changes ─────────────────
  useEffect(() => {
    if (state.session) {
      saveSession(state.session);
    }
  }, [state.session]);

  // ─── Send message ────────────────────────────
  const send = useCallback(async (text: string) => {
    if (!state.session || state.isTyping) return;
    if (text.trim().length < CHAT_CONFIG.min_message_length) return;

    // Cancel any in-flight request
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    // Add user message
    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: text.trim(),
      timestamp: new Date(),
      status: 'sending',
    };
    dispatch({ type: 'ADD_MESSAGE', message: userMsg });
    dispatch({ type: 'SET_TYPING', isTyping: true });
    dispatch({ type: 'SET_ERROR', error: null });

    // Add placeholder AI message for streaming
    const aiMsgId = uuidv4();
    const aiMsg: ChatMessage = {
      id: aiMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      status: 'streaming',
    };
    dispatch({ type: 'ADD_MESSAGE', message: aiMsg });

    let accumulatedContent = '';

    try {
      await sendMessage(
        {
          message: text.trim(),
          session_id: state.session.session_id,
          page_url: typeof window !== 'undefined' ? window.location.href : undefined,
        },
        {
          onToken: (token) => {
            accumulatedContent += token;
            dispatch({
              type: 'UPDATE_MESSAGE',
              id: aiMsgId,
              updates: { content: accumulatedContent },
            });
          },
          onMetadata: (metadata) => {
            // Update session_id if server assigned a new one
            if (metadata.session_id && metadata.session_id !== state.session!.session_id) {
              dispatch({
                type: 'SET_SESSION',
                session: { ...state.session!, session_id: metadata.session_id },
              });
            }

            dispatch({
              type: 'UPDATE_MESSAGE',
              id: aiMsgId,
              updates: {
                confidence: metadata.confidence,
                suggested_actions: metadata.suggested_actions,
                sources: metadata.sources,
                handoff_requested: metadata.handoff_requested,
              },
            });

            if (metadata.handoff_requested) {
              dispatch({ type: 'SET_HANDOFF', active: true });
            }
          },
          onError: (error) => {
            dispatch({ type: 'SET_ERROR', error: error.message });
            dispatch({
              type: 'UPDATE_MESSAGE',
              id: aiMsgId,
              updates: {
                content: "Sorry, something went wrong. Please try again or call us directly.",
                status: 'error',
                suggested_actions: ['call_us'],
              },
            });
          },
          onDone: () => {
            dispatch({
              type: 'UPDATE_MESSAGE',
              id: aiMsgId,
              updates: { status: 'sent' },
            });
            // Mark user message as sent too
            dispatch({
              type: 'UPDATE_MESSAGE',
              id: userMsg.id,
              updates: { status: 'sent' },
            });
          },
        },
        abortRef.current.signal
      );
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        dispatch({ type: 'SET_ERROR', error: 'Failed to send message' });
      }
    } finally {
      dispatch({ type: 'SET_TYPING', isTyping: false });

      // Show unread badge if chat is closed
      if (!state.isOpen) {
        dispatch({ type: 'SET_UNREAD', hasUnread: true });
      }
    }
  }, [state.session, state.isTyping, state.isOpen]);

  // ─── Toggle chat open/close ──────────────────
  const toggle = useCallback(() => {
    dispatch({ type: 'TOGGLE_OPEN' });
  }, []);

  // ─── Submit lead capture ─────────────────────
  const submitLead = useCallback(async (data: {
    first_name?: string;
    phone?: string;
    email?: string;
  }) => {
    if (!state.session) return;
    await captureLead({
      session_id: state.session.session_id,
      ...data,
    });
    dispatch({
      type: 'SET_SESSION',
      session: { ...state.session, contact_captured: true },
    });
  }, [state.session]);

  // ─── Trigger handoff ─────────────────────────
  const triggerHandoff = useCallback(async (reason?: string) => {
    if (!state.session) return;
    await requestHandoff({
      session_id: state.session.session_id,
      reason,
    });
    dispatch({ type: 'SET_HANDOFF', active: true });

    // Add system message
    const systemMsg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      content: getHandoffMessage(),
      timestamp: new Date(),
      status: 'sent',
    };
    dispatch({ type: 'ADD_MESSAGE', message: systemMsg });
  }, [state.session]);

  return (
    <ChatContext.Provider value={{ state, send, toggle, submitLead, triggerHandoff }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}

// ─── Handoff message helper ──────────────────────

function getHandoffMessage(): string {
  const { handoff_business_hours: bh, handoff_estimated_response_minutes: mins } = CHAT_CONFIG;
  const now = new Date();
  // Simple business hours check (AEST)
  const hour = now.getHours(); // Server-side this is UTC; client-side it's local
  const isBusinessHours = hour >= bh.start && hour < bh.end;

  if (isBusinessHours) {
    return `Rob has been notified and will follow up soon — typically within ${mins} minutes during business hours. You can also call directly if it's urgent.`;
  }
  return `Rob will follow up when he's next available (business hours: ${bh.start}am–${bh.end % 12}pm AEST). If it's urgent, please call directly.`;
}
```

### 10.2 ChatBubble — Floating Button

```typescript
// src/components/chat/ChatBubble.tsx

'use client';

import { MessageCircle, X } from 'lucide-react';
import { useChat } from './ChatProvider';
import { CHAT_CONFIG } from '@/lib/chat/constants';

export function ChatBubble() {
  const { state, toggle } = useChat();

  return (
    <button
      onClick={toggle}
      aria-label={state.isOpen ? 'Close chat' : 'Open chat'}
      aria-expanded={state.isOpen}
      aria-controls="nexdrive-chat-window"
      className={`
        fixed z-50
        flex items-center justify-center
        rounded-full shadow-lg
        transition-all duration-300 ease-in-out
        focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2
        hover:scale-105 active:scale-95
        bg-primary-600 text-white hover:bg-primary-700
      `}
      style={{
        width: CHAT_CONFIG.bubble_size,
        height: CHAT_CONFIG.bubble_size,
        right: CHAT_CONFIG.bubble_offset_right,
        bottom: CHAT_CONFIG.bubble_offset_bottom,
      }}
    >
      {state.isOpen ? (
        <X size={24} aria-hidden="true" />
      ) : (
        <>
          <MessageCircle size={24} aria-hidden="true" />
          {state.hasUnread && (
            <span
              className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-red-500 border-2 border-white"
              aria-label="New message"
            >
              <span className="sr-only">Unread message</span>
            </span>
          )}
        </>
      )}
    </button>
  );
}
```

### 10.3 ChatWindow — Main Container

```typescript
// src/components/chat/ChatWindow.tsx

'use client';

import { useEffect, useRef } from 'react';
import { useChat } from './ChatProvider';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { HandoffBanner } from './HandoffBanner';
import { CHAT_CONFIG } from '@/lib/chat/constants';

export function ChatWindow() {
  const { state } = useChat();
  const windowRef = useRef<HTMLDivElement>(null);

  // Trap focus inside chat window when open (accessibility)
  useEffect(() => {
    if (!state.isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Close chat on Escape — handled by ChatBubble toggle
        // We'll dispatch toggle from here
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [state.isOpen]);

  if (!state.isOpen || !state.session) return null;

  return (
    <div
      id="nexdrive-chat-window"
      ref={windowRef}
      role="dialog"
      aria-label="Chat with NexDrive Academy"
      aria-modal="false"
      className={`
        fixed z-50 flex flex-col
        bg-white dark:bg-gray-900
        border border-gray-200 dark:border-gray-700
        shadow-2xl
        transition-all duration-300 ease-in-out
        
        /* Mobile: full-screen overlay */
        inset-0 sm:inset-auto
        
        /* Desktop: positioned panel */
        sm:rounded-2xl sm:overflow-hidden
      `}
      style={{
        // Desktop dimensions
        ...(typeof window !== 'undefined' && window.innerWidth >= 640
          ? {
              width: CHAT_CONFIG.window_width_desktop,
              height: CHAT_CONFIG.window_height_desktop,
              maxHeight: CHAT_CONFIG.window_max_height_desktop,
              right: CHAT_CONFIG.bubble_offset_right,
              bottom: CHAT_CONFIG.bubble_offset_bottom + CHAT_CONFIG.bubble_size + 12,
            }
          : {}),
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-primary-600 text-white shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center text-sm font-semibold">
            N
          </div>
          <div>
            <h2 className="text-sm font-semibold">NexDrive Academy</h2>
            <p className="text-xs text-white/70">
              {state.session.mode === 'prospect'
                ? 'AI Assistant'
                : state.session.mode === 'student'
                  ? 'Your Driving Coach'
                  : 'Parent Support'}
            </p>
          </div>
        </div>

        {/* Mobile close button (separate from bubble on mobile) */}
        <button
          onClick={() => {
            // Use the toggle from context
          }}
          className="sm:hidden p-1 rounded hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white"
          aria-label="Close chat"
        >
          <span className="text-lg">✕</span>
        </button>
      </div>

      {/* Handoff banner (if active) */}
      {state.session.handoff_active && <HandoffBanner />}

      {/* Messages */}
      <MessageList />

      {/* Input */}
      <InputBar />
    </div>
  );
}
```

### 10.4 MessageList — Scrollable Message History

```typescript
// src/components/chat/MessageList.tsx

'use client';

import { useEffect, useRef } from 'react';
import { useChat } from './ChatProvider';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import { SuggestedActions } from './SuggestedActions';

export function MessageList() {
  const { state } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.session?.messages.length, state.isTyping]);

  if (!state.session) return null;

  const messages = state.session.messages;
  const lastMessage = messages[messages.length - 1];

  return (
    <div
      className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
      role="log"
      aria-label="Chat messages"
      aria-live="polite"
    >
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {state.isTyping && <TypingIndicator />}

      {/* Show suggested actions after the last AI message (not while typing) */}
      {!state.isTyping &&
        lastMessage?.role === 'assistant' &&
        lastMessage.suggested_actions &&
        lastMessage.suggested_actions.length > 0 && (
          <SuggestedActions actions={lastMessage.suggested_actions} />
        )}

      <div ref={bottomRef} />
    </div>
  );
}
```

### 10.5 MessageBubble — Individual Message

```typescript
// src/components/chat/MessageBubble.tsx

'use client';

import type { ChatMessage } from '@/lib/chat/types';

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="flex justify-center" role="status">
        <div className="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 text-xs px-3 py-1.5 rounded-full max-w-[85%] text-center">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`
          max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
          ${isUser
            ? 'bg-primary-600 text-white rounded-br-md'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-bl-md'
          }
          ${message.status === 'error' ? 'border border-red-300 bg-red-50' : ''}
          ${message.status === 'streaming' ? 'animate-pulse-subtle' : ''}
        `}
      >
        <p className="whitespace-pre-wrap break-words">{message.content}</p>

        {/* Streaming cursor */}
        {message.status === 'streaming' && (
          <span className="inline-block w-0.5 h-4 bg-current animate-blink ml-0.5 align-text-bottom" />
        )}

        {/* Confidence indicator (low confidence) */}
        {!isUser && message.confidence !== undefined && message.confidence < 0.6 && (
          <p className="text-xs mt-1 opacity-60 italic">
            I&apos;m not 100% sure about this — Rob can confirm.
          </p>
        )}

        {/* Timestamp */}
        <time
          className={`block text-[10px] mt-1 ${isUser ? 'text-white/60' : 'text-gray-400'}`}
          dateTime={new Date(message.timestamp).toISOString()}
        >
          {new Date(message.timestamp).toLocaleTimeString('en-AU', {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </time>
      </div>
    </div>
  );
}
```

### 10.6 TypingIndicator

```typescript
// src/components/chat/TypingIndicator.tsx

'use client';

export function TypingIndicator() {
  return (
    <div className="flex justify-start" aria-label="NexDrive is typing" role="status">
      <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3 flex gap-1.5">
        <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  );
}
```

### 10.7 SuggestedActions — Clickable Buttons

```typescript
// src/components/chat/SuggestedActions.tsx

'use client';

import { useRouter } from 'next/navigation';
import { useChat } from './ChatProvider';
import { SUGGESTED_ACTION_CONFIG } from '@/lib/chat/constants';
import * as LucideIcons from 'lucide-react';

interface Props {
  actions: string[];
}

export function SuggestedActions({ actions }: Props) {
  const router = useRouter();
  const { send, triggerHandoff } = useChat();

  const handleAction = (actionKey: string) => {
    const config = SUGGESTED_ACTION_CONFIG[actionKey];
    if (!config) return;

    switch (config.action) {
      case 'navigate':
        if (config.target?.startsWith('tel:')) {
          window.open(config.target, '_self');
        } else if (config.target) {
          router.push(config.target);
        }
        break;
      case 'message':
        if (config.target) {
          send(config.target);
        }
        break;
      case 'callback':
        if (actionKey === 'handoff_to_human') {
          triggerHandoff();
        }
        // provide_phone / provide_email → could trigger lead form
        break;
    }
  };

  return (
    <div className="flex flex-wrap gap-2 mt-1" role="group" aria-label="Suggested actions">
      {actions.map((actionKey) => {
        const config = SUGGESTED_ACTION_CONFIG[actionKey];
        if (!config) return null;

        const IconComponent = (LucideIcons as any)[config.icon];

        return (
          <button
            key={actionKey}
            onClick={() => handleAction(actionKey)}
            className="
              inline-flex items-center gap-1.5 px-3 py-1.5
              text-xs font-medium
              rounded-full border border-primary-200
              text-primary-700 bg-primary-50
              hover:bg-primary-100 hover:border-primary-300
              focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1
              transition-colors
            "
          >
            {IconComponent && <IconComponent size={14} aria-hidden="true" />}
            {config.label}
          </button>
        );
      })}
    </div>
  );
}
```

### 10.8 InputBar — Text Input & Send

```typescript
// src/components/chat/InputBar.tsx

'use client';

import { useState, useRef, useCallback } from 'react';
import { Send } from 'lucide-react';
import { useChat } from './ChatProvider';
import { CHAT_CONFIG } from '@/lib/chat/constants';

export function InputBar() {
  const { state, send } = useChat();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastSendRef = useRef<number>(0);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (state.isTyping) return;

    // Client-side rate limiting
    const now = Date.now();
    if (now - lastSendRef.current < CHAT_CONFIG.min_send_interval_ms) return;
    lastSendRef.current = now;

    send(trimmed);
    setText('');
    inputRef.current?.focus();
  }, [text, state.isTyping, send]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isDisabled = state.isTyping || !text.trim();

  return (
    <div className="flex items-end gap-2 px-3 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0 bg-white dark:bg-gray-900">
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, CHAT_CONFIG.max_message_length))}
        onKeyDown={handleKeyDown}
        placeholder={
          state.session?.handoff_active
            ? 'Rob will follow up shortly...'
            : 'Type your message...'
        }
        rows={1}
        className="
          flex-1 resize-none
          rounded-xl border border-gray-200 dark:border-gray-700
          bg-gray-50 dark:bg-gray-800
          px-3 py-2 text-sm
          placeholder:text-gray-400
          focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent
          max-h-24
        "
        aria-label="Chat message"
        aria-describedby="chat-input-hint"
        disabled={state.session?.handoff_active}
      />
      <span id="chat-input-hint" className="sr-only">
        Press Enter to send, Shift+Enter for new line
      </span>

      <button
        onClick={handleSend}
        disabled={isDisabled}
        aria-label="Send message"
        className="
          flex items-center justify-center
          w-10 h-10 rounded-xl
          bg-primary-600 text-white
          hover:bg-primary-700
          disabled:opacity-40 disabled:cursor-not-allowed
          focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1
          transition-colors shrink-0
        "
      >
        <Send size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
```

### 10.9 HandoffBanner

```typescript
// src/components/chat/HandoffBanner.tsx

'use client';

import { Clock } from 'lucide-react';
import { CHAT_CONFIG } from '@/lib/chat/constants';

export function HandoffBanner() {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 text-amber-800 dark:text-amber-200 text-xs shrink-0"
      role="status"
      aria-live="polite"
    >
      <Clock size={14} aria-hidden="true" className="shrink-0" />
      <p>
        Rob has been notified and will follow up — typically within{' '}
        {CHAT_CONFIG.handoff_estimated_response_minutes} minutes during business hours.
      </p>
    </div>
  );
}
```

---

## 11. Embedding Strategy

### 11.1 React Component (Recommended)

For Next.js pages within the NexDrive app — drop the provider and components into the root layout.

```typescript
// src/app/layout.tsx (add to existing layout)

import { ChatProvider } from '@/components/chat/ChatProvider';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { ChatWindow } from '@/components/chat/ChatWindow';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ClerkProvider>
          <ChatProvider>
            {children}
            {/* Chat widget — renders on all pages */}
            <ChatBubble />
            <ChatWindow />
          </ChatProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
```

### 11.2 Script Tag (External Sites)

For embedding on external sites or non-Next.js pages. Builds a standalone bundle that mounts the chat widget into a container.

```typescript
// scripts/build-chat-embed.ts
// Build with: npx tsup src/components/chat/embed.tsx --format iife --outDir public/embed

// src/components/chat/embed.tsx
import { createRoot } from 'react-dom/client';
import { ChatProvider } from './ChatProvider';
import { ChatBubble } from './ChatBubble';
import { ChatWindow } from './ChatWindow';

function NexDriveChat() {
  return (
    <ChatProvider>
      <ChatBubble />
      <ChatWindow />
    </ChatProvider>
  );
}

// Auto-mount on script load
const container = document.createElement('div');
container.id = 'nexdrive-chat-root';
document.body.appendChild(container);
createRoot(container).render(<NexDriveChat />);
```

Embedding HTML:

```html
<!-- Drop this on any page -->
<script src="https://nexdriveacademy.com.au/embed/chat.js" defer></script>
<link rel="stylesheet" href="https://nexdriveacademy.com.au/embed/chat.css" />
```

---

## 12. Accessibility (WCAG 2.1 AA)

| Requirement | Implementation |
|-------------|----------------|
| Keyboard navigation | All elements focusable via Tab. Enter sends messages. Escape closes chat window. Arrow keys scroll message list. |
| Focus management | Focus moves to input when chat opens. Focus returns to bubble when chat closes. |
| Screen reader | Chat window: `role="dialog"`, `aria-label="Chat with NexDrive Academy"`. Message list: `role="log"`, `aria-live="polite"`. Typing indicator: `role="status"`. |
| ARIA labels | Bubble: `aria-expanded`, `aria-controls`. Send button: `aria-label="Send message"`. Input: `aria-label="Chat message"`, `aria-describedby="chat-input-hint"`. |
| Colour contrast | Primary-600 on white exceeds 4.5:1. User bubble text (white on primary-600) verified. AI bubble text (gray-900 on gray-100) verified. |
| Touch targets | Bubble: 56×56px (exceeds 44px minimum). Send button: 40×40px (meets minimum). Suggested action buttons: min 44px height with padding. |
| Motion | All animations respect `prefers-reduced-motion`. Typing indicator falls back to static dots. |
| Focus indicators | All interactive elements: `focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2`. |

---

## 13. Mobile Responsiveness

| Breakpoint | Layout |
|------------|--------|
| `< 640px` (mobile) | Chat window is **full-screen overlay** (`inset-0`). Header includes close button. Input bar sticks to bottom. Messages take full width. Virtual keyboard pushes content up via `visualViewport` API. |
| `>= 640px` (desktop) | Chat window is a **positioned panel** (400×540px, bottom-right, above the bubble). Rounded corners. Drop shadow. Does not overlay page content. |

Virtual keyboard handling (mobile):

```typescript
// In ChatWindow, handle viewport resize for virtual keyboard
useEffect(() => {
  if (typeof window === 'undefined') return;
  const viewport = window.visualViewport;
  if (!viewport) return;

  const handleResize = () => {
    if (windowRef.current) {
      // Shrink chat window height to accommodate virtual keyboard
      const keyboardHeight = window.innerHeight - viewport.height;
      windowRef.current.style.height = `${viewport.height}px`;
      windowRef.current.style.bottom = `${keyboardHeight}px`;
    }
  };

  viewport.addEventListener('resize', handleResize);
  return () => viewport.removeEventListener('resize', handleResize);
}, []);
```

---

## 14. Analytics Events

All events tracked via PostHog (see SPEC-06 analytics setup).

| Event | Properties | Trigger |
|-------|-----------|---------|
| `chat_opened` | `mode`, `page_url` | User clicks bubble |
| `chat_closed` | `mode`, `message_count`, `duration_seconds` | User closes chat |
| `chat_message_sent` | `mode`, `intent`, `confidence`, `session_id` | Message sent to API |
| `chat_action_clicked` | `action_key`, `mode` | Suggested action clicked |
| `chat_lead_captured` | `has_phone`, `has_email`, `mode` | Lead form submitted |
| `chat_handoff_requested` | `mode`, `message_count`, `reason` | Handoff triggered |
| `chat_error` | `error_code`, `session_id` | API error occurred |

---

## 15. Error Handling

| Scenario | Client Behaviour | API Behaviour |
|----------|-----------------|---------------|
| Network offline | Show "You're offline. Messages will send when you reconnect." (no IndexedDB queue — just visual indicator). | N/A |
| API 429 (rate limited) | Show "You're sending messages too fast. Please wait a moment." | Return 429 with `retry-after` header. |
| API 5xx | Show "Something went wrong. Please try again or call us." with `call_us` action. | Log to Sentry. Return generic error. |
| RAG Engine timeout (> 5s) | Show "Taking a bit longer than usual..." after 3s. Fall back to JSON response if stream doesn't start within 8s. | Log slow query warning. |
| SSE stream interrupted | Treat accumulated tokens as complete response. Add metadata event `{ error: true }`. | N/A (client-side recovery). |
| localStorage unavailable | Operate without session persistence. New session each page load. | No impact. |

---

## 16. Testing Plan

### 16.1 Unit Tests

| Module | Tests |
|--------|-------|
| `session.ts` | New session creation, session resume, session expiry (30 min), mode detection, message trimming at limit |
| `api.ts` | SSE stream parsing, JSON fallback, error handling, abort controller cleanup |
| `types.ts` | Zod schema validation for all input/response types |

### 16.2 Component Tests (React Testing Library)

| Component | Tests |
|-----------|-------|
| `ChatBubble` | Renders, toggles `aria-expanded`, shows/hides notification badge |
| `MessageBubble` | Renders user/ai/system variants, shows streaming cursor, shows low-confidence caveat |
| `SuggestedActions` | Renders action buttons, fires correct callbacks |
| `InputBar` | Enables/disables send, Enter key sends, Shift+Enter creates newline, respects max length |
| `ChatWindow` | Opens/closes, shows mode-specific header, auto-scrolls on new message |

### 16.3 Integration Tests

| Test | Description |
|------|-------------|
| Full message flow | Send message → receive streamed response → suggested actions appear → click action |
| Lead capture flow | Send message → click "Talk to Rob" → fill lead form → CRM contact created |
| Session continuity | Send messages → navigate to different page → reopen chat → messages persisted |
| Session expiry | Set clock forward 31 min → reopen chat → fresh session with welcome message |
| Auth mode switch | Start as prospect → log in as student → mode changes → welcome message updates |
| Handoff flow | Trigger handoff → banner appears → handoff notification emitted → input disabled |
| Rate limiting | Send 16 messages in 60s → 429 error displayed → can resume after cooldown |

### 16.4 E2E Tests (Playwright)

| Scenario | Steps |
|----------|-------|
| Prospect happy path | Visit homepage → open chat → ask "How much are lessons?" → verify AI response with pricing action → click "Book a Lesson" → verify navigation to /book |
| Mobile full-screen | Set viewport to 375×667 → open chat → verify full-screen → type and send → verify keyboard handling → close via X button |
| Accessibility audit | Run axe-core on chat widget (open + closed states) → zero critical/serious violations |

---

## 17. Dependencies

```json
{
  "uuid": "^9.x",
  "lucide-react": "^0.263.x",
  "zod": "^3.22.x"
}
```

All other dependencies (Next.js, Clerk, Tailwind, Upstash) are part of the base project (Phase 0). The RAG Engine (SPEC-08) and CRM (SPEC-05) must be deployed before this component.

---

## 18. Implementation Sequence

| Day | Task | Depends On |
|-----|------|-----------|
| 1 | Types, constants, Zod schemas, file structure | SPEC-01 tables exist |
| 2 | Session management (`session.ts`) + unit tests | — |
| 3 | API client with SSE streaming (`api.ts`) + unit tests | — |
| 4 | API routes: `/chat/message`, `/chat/lead`, `/chat/handoff` | SPEC-08 deployed, SPEC-05 deployed |
| 5 | ChatProvider (state management, send/receive flow) | Days 2–3 |
| 6 | UI components: ChatBubble, ChatWindow, MessageList, MessageBubble, InputBar | Day 5 |
| 7 | SuggestedActions, HandoffBanner, TypingIndicator, LeadCaptureForm | Day 6 |
| 8 | Mobile responsiveness + virtual keyboard handling | Day 6 |
| 9 | Accessibility pass (axe-core audit, keyboard nav, screen reader testing) | Days 6–7 |
| 10 | Embedding: React layout integration + standalone embed build | Day 6 |
| 11 | Analytics events + integration tests | Days 4, 6 |
| 12 | E2E tests (Playwright) + polish | All above |

---

## 19. Future Enhancements (Not in This Phase)

| Enhancement | Phase | Notes |
|-------------|-------|-------|
| True Claude streaming (pipe-through from RAG) | Phase 2+ | Replace simulated word-by-word with direct stream from Claude API |
| File/image sharing in chat | Phase 4 | Student uploads photos for review, lesson evidence |
| Rich message types (carousel, cards) | Phase 4 | Booking slot picker inline in chat |
| WebSocket connection | Phase 4 | Replace SSE for bi-directional real-time (instructor live chat takeover) |
| Authenticated conversation persistence (database) | Phase 4 | Students see full chat history in portal |
| Chat-to-booking inline flow | Phase 4 | Complete booking without leaving chat |
| Multilingual support | Future | i18n for non-English speakers |
| Dark mode | Future | Honour `prefers-color-scheme` |
| Proactive engagement | Future | "Haven't booked yet? Need help?" after 30s on pricing page |

---

*SPEC-11 v1.0 — NexDrive Academy Web Chat Widget Implementation Brief*
*Covers C04 (Web Chat Widget)*
*Ready for implementation by frontend developer or AI coding agent*
