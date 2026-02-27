# SPEC-08: RAG Knowledge Engine (C07)
### NexDrive Academy — Phase 2 Never Miss a Lead
**Version:** 1.0  
**Date:** 21 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.9, §5.2 Pattern 4; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-03 (Booking Engine API)  
**Phase:** 2 (Never Miss a Lead — Weeks 7-12)  
**Estimated Effort:** 10-14 days  
**Consumers:** C04 (Web Chat), C05 (Voice Agent), C06 (SMS Chatbot)

---

## 1. Overview

The RAG Knowledge Engine is NexDrive Academy's shared intelligence layer. It ingests Rob's knowledge base (services, pricing, road rules, CBT&A competencies, FAQ), embeds it as vectors in pgvector, and provides a unified query pipeline that all AI communication channels — voice (C05), SMS (C06), and web chat (C04) — call to answer questions, classify intents, and execute booking actions.

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **Single source of truth.** All three AI channels (voice, SMS, web chat) query the same RAG engine. No channel has its own knowledge base.
2. **Never fabricate pricing.** All pricing claims MUST be grounded in live data from the `services` table via the Booking Engine API (SPEC-03 `GET /api/v1/booking/services`). If a price cannot be retrieved, say "Please check our website or call us for current pricing."
3. **Never fabricate availability.** Availability queries MUST hit the Booking Engine API. The RAG engine does not guess at open slots.
4. **Confidence-gated responses.** Every answer carries a confidence score (0.00–1.00). Below 0.60 → suggest human handoff. Below 0.40 → refuse to answer and escalate.
5. **Private notes are NEVER in context.** The RAG engine never reads `private_notes`. Student context injection is limited to: name, upcoming bookings, competency progress summary, and package status.
6. **Australian English, warm & professional.** Rob's brand voice. "G'day" is fine; corporate jargon is not. Think friendly neighbourhood driving instructor.
7. **Off-topic guardrails.** Only answer about: NexDrive services, driving/road rules, ACT CBT&A, general learner driver questions. Politely redirect everything else.
8. **Performance target: < 3 seconds end-to-end** from query receipt to response return (per arch doc §11).
9. **Source attribution.** Every factual claim in a generated response includes a reference to the source document/chunk.
10. **Handoff is always available.** Any user can say "talk to Rob" / "speak to a person" / "I want a human" and the system immediately triggers handoff — no resistance.

### 1.2 Architecture Position

```
                  ┌──────────┐  ┌──────────┐  ┌──────────┐
                  │ C04: Web │  │ C05:Voice│  │ C06: SMS │
                  │   Chat   │  │  Agent   │  │  Agent   │
                  └────┬─────┘  └────┬─────┘  └────┬─────┘
                       │             │              │
                       └─────────────┼──────────────┘
                                     │
                                     ▼
                       ┌─────────────────────────┐
                       │   C07: RAG ENGINE        │
                       │                          │
                       │  ┌────────────────────┐  │
                       │  │ Intent Classifier  │  │
                       │  └─────────┬──────────┘  │
                       │            │              │
                       │     ┌──────┴──────┐      │
                       │     │             │      │
                       │     ▼             ▼      │
                       │  ┌──────┐   ┌─────────┐  │
                       │  │Vector│   │ Booking │  │
                       │  │Search│   │ Router  │  │
                       │  └──┬───┘   └────┬────┘  │
                       │     │            │        │
                       │     ▼            ▼        │
                       │  ┌──────┐   ┌─────────┐  │
                       │  │Claude│   │ C08 API │  │
                       │  │ LLM  │   │ (slots) │  │
                       │  └──┬───┘   └────┬────┘  │
                       │     │            │        │
                       │     └──────┬─────┘        │
                       │            ▼              │
                       │  ┌────────────────────┐  │
                       │  │ Response + Sources  │  │
                       │  │ + Confidence Score  │  │
                       │  └────────────────────┘  │
                       └─────────────────────────┘
                                     │
                  ┌──────────────────┼──────────────────┐
                  │                  │                   │
                  ▼                  ▼                   ▼
          ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
          │   pgvector   │  │   Services   │  │ Conversations│
          │ (rag_chunks) │  │   (live $)   │  │  (messages)  │
          └──────────────┘  └──────────────┘  └──────────────┘
```

---

## 2. File Structure

```
src/
├── lib/
│   ├── rag/
│   │   ├── index.ts                         # Barrel export
│   │   ├── types.ts                         # All RAG types + Zod schemas
│   │   ├── errors.ts                        # RAG-specific error classes
│   │   ├── constants.ts                     # Confidence thresholds, model config, token limits
│   │   ├── query.service.ts                 # Main RAG query pipeline (orchestrator)
│   │   ├── intent.classifier.ts             # Intent classification (booking/question/complaint/callback/general)
│   │   ├── entity.extractor.ts              # Extract booking entities (service, date, time, name, phone)
│   │   ├── vector.search.ts                 # pgvector similarity search + metadata filtering
│   │   ├── context.builder.ts               # Build LLM context from retrieved chunks + student data
│   │   ├── student.context.ts               # Fetch authenticated student context (progress, bookings)
│   │   ├── llm.service.ts                   # Claude API wrapper (adapter pattern)
│   │   ├── confidence.scorer.ts             # Compute confidence from retrieval scores + LLM signals
│   │   ├── guardrails.ts                    # Topic filtering, safety checks, off-topic detection
│   │   ├── handoff.service.ts               # Human handoff logic and triggers
│   │   ├── conversation.service.ts          # Conversation history (sliding window)
│   │   ├── prompts/
│   │   │   ├── system.prompt.ts             # Base NexDrive persona system prompt
│   │   │   ├── intent.prompt.ts             # Intent classification prompt
│   │   │   ├── answer.prompt.ts             # RAG answer generation prompt
│   │   │   ├── entity.prompt.ts             # Entity extraction prompt
│   │   │   └── guardrail.prompt.ts          # Off-topic detection prompt
│   │   ├── ingestion/
│   │   │   ├── index.ts                     # Barrel export
│   │   │   ├── ingest.service.ts            # Document ingestion orchestrator
│   │   │   ├── chunker.ts                   # Text chunking (500 tokens, 100 overlap)
│   │   │   ├── embedder.ts                  # OpenAI embedding wrapper (adapter pattern)
│   │   │   ├── extractors/
│   │   │   │   ├── text.extractor.ts        # Plain text / Markdown
│   │   │   │   ├── pdf.extractor.ts         # PDF text extraction
│   │   │   │   └── html.extractor.ts        # HTML → clean text
│   │   │   └── metadata.tagger.ts           # Auto-tag chunks with category, task_number, etc.
│   │   └── adapters/
│   │       ├── llm.adapter.ts               # LLM adapter interface (Claude impl)
│   │       └── embedding.adapter.ts         # Embedding adapter interface (OpenAI impl)
├── app/
│   ├── api/
│   │   ├── internal/
│   │   │   └── rag/
│   │   │       ├── query/route.ts           # POST /api/internal/rag/query
│   │   │       ├── index/route.ts           # POST /api/internal/rag/index
│   │   │       ├── reindex/route.ts         # POST /api/internal/rag/reindex
│   │   │       └── documents/
│   │   │           ├── route.ts             # GET /api/internal/rag/documents
│   │   │           └── [id]/route.ts        # DELETE /api/internal/rag/documents/:id
```

---

## 3. Types & Schemas

```typescript
// src/lib/rag/types.ts

import { z } from 'zod';

// ─── Intent Classification ───────────────────────────────────

export const IntentType = z.enum([
  'booking',       // Wants to book, check availability, reschedule
  'question',      // Informational question about services, road rules, CBT&A
  'complaint',     // Unhappy about something
  'callback',      // Wants Rob to call them back
  'general',       // Greeting, small talk, unclear intent
  'handoff',       // Explicitly requesting human
]);
export type IntentType = z.infer<typeof IntentType>;

export const IntentClassification = z.object({
  intent: IntentType,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),  // Brief internal justification (not shown to user)
});
export type IntentClassification = z.infer<typeof IntentClassification>;

// ─── Booking Entity Extraction ───────────────────────────────

export const BookingEntities = z.object({
  service_slug: z.string().optional(),         // 'learner-60', 'pre-test-prep'
  service_name: z.string().optional(),         // Free-text service reference
  preferred_date: z.string().optional(),       // ISO date or relative ('next Monday')
  preferred_time: z.string().optional(),       // 'morning', 'afternoon', '2pm', '14:00'
  preferred_day_of_week: z.string().optional(),// 'Monday', 'weekday', 'Saturday'
  contact_name: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_email: z.string().optional(),
  transmission: z.enum(['manual', 'auto']).optional(),
});
export type BookingEntities = z.infer<typeof BookingEntities>;

// ─── RAG Query ───────────────────────────────────────────────

export const RAGQueryInput = z.object({
  query: z.string().min(1).max(2000),
  context: z.object({
    user_id: z.string().optional(),            // Clerk user ID (if authenticated)
    student_id: z.string().optional(),
    channel: z.enum(['web_chat', 'sms', 'voice']),
    session_id: z.string().optional(),         // Conversation session
    page_url: z.string().optional(),           // Current page (web chat context)
  }).optional(),
  filters: z.object({
    source_types: z.array(z.enum([
      'regulation', 'business', 'educational', 'faq', 'blog', 'template'
    ])).optional(),
    task_number: z.number().int().min(1).max(23).optional(),
  }).optional(),
  max_results: z.number().int().min(1).max(10).default(5),
  conversation_history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
});
export type RAGQueryInput = z.infer<typeof RAGQueryInput>;

export const RAGQueryResponse = z.object({
  answer: z.string(),
  sources: z.array(z.object({
    document_id: z.string().uuid(),
    title: z.string(),
    chunk_content: z.string(),
    score: z.number(),
  })),
  confidence: z.number().min(0).max(1),
  intent: IntentType,
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
  handoff_requested: z.boolean().default(false),
  booking_entities: BookingEntities.optional(), // Populated if intent=booking
  session_id: z.string(),
});
export type RAGQueryResponse = z.infer<typeof RAGQueryResponse>;

// ─── Vector Search ───────────────────────────────────────────

export interface VectorSearchResult {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
  similarity_score: number;  // 0.0–1.0, cosine similarity
}

// ─── Document Ingestion ──────────────────────────────────────

export const DocumentIngestionInput = z.object({
  title: z.string().min(1).max(500),
  source_type: z.enum(['regulation', 'business', 'educational', 'faq', 'blog', 'template']),
  content: z.string().optional(),         // Raw text content
  file_url: z.string().url().optional(),  // R2 storage URL (for PDF/HTML upload)
  metadata: z.record(z.unknown()).optional(),
});
export type DocumentIngestionInput = z.infer<typeof DocumentIngestionInput>;

// ─── Student Context (injected for authenticated users) ──────

export interface StudentContext {
  name: string;
  preferred_name: string | null;
  transmission: 'manual' | 'auto';
  instructor_name: string;
  upcoming_bookings: Array<{
    date: string;       // 'Monday 3 March'
    time: string;       // '2:00 PM'
    service: string;    // 'Learner Lesson (60 min)'
  }>;
  competency_summary: {
    total_tasks: number;       // 23
    competent: number;
    in_progress: number;
    not_started: number;
    total_hours: number;       // Decimal hours
  };
  package_status: {
    has_active_package: boolean;
    credits_remaining: number | null;
    package_name: string | null;
  } | null;
}

// ─── Conversation History ────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  intent?: IntentType;
  confidence?: number;
}

export interface ConversationState {
  session_id: string;
  channel: 'web_chat' | 'sms' | 'voice';
  contact_id?: string;
  user_id?: string;
  messages: ConversationMessage[];
  created_at: Date;
  last_activity: Date;
}
```

---

## 4. Constants & Configuration

```typescript
// src/lib/rag/constants.ts

// ─── Model Configuration ─────────────────────────────────────

export const LLM_CONFIG = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,            // Response generation
  temperature: 0.3,            // Low temp for factual grounding
  intent_max_tokens: 256,      // Intent classification (fast)
  entity_max_tokens: 512,      // Entity extraction
} as const;

export const EMBEDDING_CONFIG = {
  model: 'text-embedding-3-large',
  dimensions: 3072,            // Full dimension for max quality
  batch_size: 50,              // Chunks per embedding API call
} as const;

// ─── Chunking Configuration ─────────────────────────────────

export const CHUNKING_CONFIG = {
  target_tokens: 500,          // Target chunk size
  overlap_tokens: 100,         // Overlap between chunks
  min_chunk_tokens: 50,        // Discard chunks smaller than this
  max_chunk_tokens: 750,       // Hard ceiling (prefer splitting)
  // Average 1 token ≈ 4 characters for English text
  chars_per_token: 4,
} as const;

// ─── Vector Search Configuration ─────────────────────────────

export const SEARCH_CONFIG = {
  default_top_k: 5,
  max_top_k: 10,
  similarity_threshold: 0.65,  // Discard results below this score
  rerank_candidates: 10,       // Fetch more, then rerank to top_k
} as const;

// ─── Confidence Thresholds ───────────────────────────────────

export const CONFIDENCE = {
  high: 0.80,                  // Confident answer, no caveats
  medium: 0.60,                // Answer with softer language
  low: 0.40,                   // Suggest handoff, try to answer
  refuse: 0.40,                // Below this: don't answer, escalate
  handoff_auto: 0.40,          // Auto-suggest handoff
  handoff_suggest: 0.60,       // Offer handoff as option
} as const;

// ─── Conversation Configuration ──────────────────────────────

export const CONVERSATION_CONFIG = {
  max_history_messages: 10,    // Sliding window: last 10 messages
  session_ttl_seconds: 1800,   // 30 minutes inactivity timeout
  max_tokens_history: 3000,    // Token budget for conversation history
} as const;

// ─── Rate Limiting (internal) ────────────────────────────────

export const RATE_LIMITS = {
  queries_per_minute_per_session: 15,
  queries_per_minute_global: 60,
  ingestion_per_hour: 50,
} as const;

// ─── Guardrail Keywords ──────────────────────────────────────

export const HANDOFF_TRIGGERS = [
  'talk to rob',
  'speak to a person',
  'speak to someone',
  'talk to a human',
  'speak to a human',
  'real person',
  'talk to someone real',
  'i want a person',
  'human please',
  'get me rob',
  'transfer me',
  'let me speak to',
  'i need to talk to',
  'can i talk to',
  'connect me',
] as const;
```

---

## 5. Document Ingestion Pipeline

### 5.1 Ingestion Flow

```
Document Upload
       │
       ▼
┌──────────────────┐
│ 1. Validate Input │  (title, source_type, content or file_url)
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ 2. Extract Text   │  Text/Markdown → passthrough
│                    │  PDF → pdf-parse
│                    │  HTML → cheerio → clean text
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ 3. Chunk Text     │  500 tokens, 100 overlap
│                    │  Preserve paragraph boundaries
│                    │  Content-type-aware splitting
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ 4. Tag Metadata   │  Auto-detect: category, task_number, 
│                    │  service references, topic classification
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ 5. Embed Chunks   │  OpenAI text-embedding-3-large
│                    │  Batch API calls (50 per batch)
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ 6. Store Vectors  │  INSERT into rag_chunks (pgvector)
│                    │  UPDATE rag_documents (status=indexed)
└──────────────────┘
```

### 5.2 Chunking Strategy

The chunker is content-type-aware. Different document types require different splitting strategies to preserve semantic coherence.

```typescript
// src/lib/rag/ingestion/chunker.ts

import { CHUNKING_CONFIG } from '../constants';

interface ChunkResult {
  content: string;
  chunk_index: number;
  metadata: Record<string, unknown>;  // Inherited from document + section
}

/**
 * Chunk a document into overlapping segments.
 * 
 * Strategy:
 * 1. Split into paragraphs (double newline boundaries)
 * 2. Accumulate paragraphs into chunks up to target_tokens
 * 3. When a chunk reaches target size, start new chunk with overlap
 * 4. Never break mid-paragraph if possible
 * 5. Respect heading boundaries — a heading always starts a new chunk
 * 
 * Content-type adjustments:
 * - FAQ: Each Q&A pair is its own chunk (never split a Q&A)
 * - Services: Each service description is its own chunk
 * - Road rules: Split by rule/section, keep rule numbers intact
 * - CBT&A: Each competency task description is its own chunk
 */
export function chunkDocument(
  text: string,
  sourceType: string,
  metadata?: Record<string, unknown>
): ChunkResult[] {
  // Route to content-type-specific chunker
  switch (sourceType) {
    case 'faq':
      return chunkFAQ(text, metadata);
    case 'regulation':
      return chunkRegulation(text, metadata);
    default:
      return chunkGeneral(text, metadata);
  }
}

/**
 * General-purpose paragraph-aware chunker.
 */
function chunkGeneral(
  text: string,
  metadata?: Record<string, unknown>
): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  const paragraphs = splitIntoParagraphs(text);
  
  let currentChunk = '';
  let overlapBuffer = '';
  let chunkIndex = 0;
  
  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTokens(paragraph);
    const currentTokens = estimateTokens(currentChunk);
    
    // If a single paragraph exceeds max, force-split it
    if (paragraphTokens > CHUNKING_CONFIG.max_chunk_tokens) {
      // Flush current chunk first
      if (currentChunk.trim()) {
        chunks.push({
          content: currentChunk.trim(),
          chunk_index: chunkIndex++,
          metadata: { ...metadata },
        });
      }
      // Split the oversized paragraph by sentences
      const subChunks = splitBySentences(paragraph, CHUNKING_CONFIG.target_tokens);
      for (const sub of subChunks) {
        chunks.push({
          content: sub.trim(),
          chunk_index: chunkIndex++,
          metadata: { ...metadata },
        });
      }
      currentChunk = '';
      overlapBuffer = '';
      continue;
    }
    
    // Does this paragraph start with a heading? (# or ## etc.)
    const isHeading = /^#{1,6}\s/.test(paragraph.trim());
    
    // If adding this paragraph exceeds target AND we have content, flush
    if (
      currentTokens + paragraphTokens > CHUNKING_CONFIG.target_tokens &&
      currentChunk.trim()
    ) {
      chunks.push({
        content: currentChunk.trim(),
        chunk_index: chunkIndex++,
        metadata: { ...metadata },
      });
      
      // Start new chunk with overlap from end of previous chunk
      currentChunk = overlapBuffer + '\n\n' + paragraph;
      overlapBuffer = paragraph;
    } else if (isHeading && currentChunk.trim()) {
      // Headings always start a new chunk (unless chunk is empty)
      chunks.push({
        content: currentChunk.trim(),
        chunk_index: chunkIndex++,
        metadata: { ...metadata },
      });
      currentChunk = paragraph;
      overlapBuffer = '';
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      // Keep last N tokens as overlap buffer
      overlapBuffer = getLastNTokens(currentChunk, CHUNKING_CONFIG.overlap_tokens);
    }
  }
  
  // Flush remaining
  if (currentChunk.trim() && estimateTokens(currentChunk) >= CHUNKING_CONFIG.min_chunk_tokens) {
    chunks.push({
      content: currentChunk.trim(),
      chunk_index: chunkIndex++,
      metadata: { ...metadata },
    });
  }
  
  return chunks;
}

/**
 * FAQ chunker — keep each Q&A pair together.
 * Expects format:
 *   Q: How many lessons do I need?
 *   A: Most learners need between 30-60 hours...
 *   
 *   Q: What car do you use?
 *   A: ...
 */
function chunkFAQ(
  text: string,
  metadata?: Record<string, unknown>
): ChunkResult[] {
  const qaPairs = text.split(/\n(?=Q:|Question:|###\s)/i).filter(Boolean);
  return qaPairs.map((qa, index) => ({
    content: qa.trim(),
    chunk_index: index,
    metadata: { ...metadata, content_type: 'faq_pair' },
  }));
}

/**
 * Regulation chunker — split by section/rule numbers.
 * Preserves: "Section 5.2: ..." and "Rule 123: ..." boundaries.
 * CBT&A task descriptions each get their own chunk.
 */
function chunkRegulation(
  text: string,
  metadata?: Record<string, unknown>
): ChunkResult[] {
  // Try to split by task/section headers
  const sections = text.split(
    /\n(?=(?:Task\s+\d|Section\s+\d|Rule\s+\d|#{1,3}\s+\d))/i
  ).filter(Boolean);
  
  if (sections.length <= 1) {
    // Fallback to general chunking
    return chunkGeneral(text, metadata);
  }
  
  const chunks: ChunkResult[] = [];
  let chunkIndex = 0;
  
  for (const section of sections) {
    const tokens = estimateTokens(section);
    if (tokens > CHUNKING_CONFIG.max_chunk_tokens) {
      // Section too large — sub-chunk it
      const subChunks = chunkGeneral(section, metadata);
      for (const sub of subChunks) {
        sub.chunk_index = chunkIndex++;
        chunks.push(sub);
      }
    } else if (tokens >= CHUNKING_CONFIG.min_chunk_tokens) {
      // Extract task number if present
      const taskMatch = section.match(/Task\s+(\d+)/i);
      chunks.push({
        content: section.trim(),
        chunk_index: chunkIndex++,
        metadata: {
          ...metadata,
          ...(taskMatch ? { task_number: parseInt(taskMatch[1], 10) } : {}),
        },
      });
    }
  }
  
  return chunks;
}

// ─── Utility Functions ───────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHUNKING_CONFIG.chars_per_token);
}

function splitIntoParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
}

function splitBySentences(text: string, maxTokens: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks: string[] = [];
  let current = '';
  
  for (const sentence of sentences) {
    if (estimateTokens(current + sentence) > maxTokens && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function getLastNTokens(text: string, n: number): string {
  const targetChars = n * CHUNKING_CONFIG.chars_per_token;
  return text.slice(-targetChars);
}
```

### 5.3 Embedding Pipeline

```typescript
// src/lib/rag/ingestion/embedder.ts

import { EMBEDDING_CONFIG } from '../constants';

// Adapter interface — swap providers without changing calling code
export interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
}

/**
 * OpenAI text-embedding-3-large implementation.
 * Produces 3072-dimension vectors stored in pgvector.
 */
export class OpenAIEmbedder implements EmbeddingAdapter {
  private client: OpenAI;
  
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  
  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    
    // Batch in groups of BATCH_SIZE to respect API limits
    for (let i = 0; i < texts.length; i += EMBEDDING_CONFIG.batch_size) {
      const batch = texts.slice(i, i + EMBEDDING_CONFIG.batch_size);
      
      const response = await this.client.embeddings.create({
        model: EMBEDDING_CONFIG.model,
        input: batch,
        dimensions: EMBEDDING_CONFIG.dimensions,
      });
      
      // Preserve order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      results.push(...sorted.map(d => d.embedding));
    }
    
    return results;
  }
  
  async embedSingle(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    return embedding;
  }
}
```

### 5.4 Ingestion Service (Orchestrator)

```typescript
// src/lib/rag/ingestion/ingest.service.ts

import { db } from '@/lib/db';
import { ragDocuments, ragChunks } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { chunkDocument } from './chunker';
import { OpenAIEmbedder } from './embedder';
import { tagMetadata } from './metadata.tagger';
import type { DocumentIngestionInput } from '../types';

const embedder = new OpenAIEmbedder();

export async function ingestDocument(input: DocumentIngestionInput): Promise<{
  document_id: string;
  chunk_count: number;
}> {
  // 1. Create document record (status: processing)
  const [doc] = await db.insert(ragDocuments).values({
    title: input.title,
    source_type: input.source_type,
    file_url: input.file_url || null,
    status: 'processing',
    metadata: input.metadata || {},
  }).returning();
  
  try {
    // 2. Extract text content
    let text: string;
    if (input.content) {
      text = input.content;
    } else if (input.file_url) {
      text = await extractTextFromFile(input.file_url);
    } else {
      throw new Error('Either content or file_url is required');
    }
    
    // 3. Chunk the text
    const chunks = chunkDocument(text, input.source_type, input.metadata);
    
    if (chunks.length === 0) {
      throw new Error('Document produced zero chunks after processing');
    }
    
    // 4. Auto-tag metadata on each chunk
    const taggedChunks = chunks.map(chunk => ({
      ...chunk,
      metadata: {
        ...chunk.metadata,
        ...tagMetadata(chunk.content, input.source_type),
        source_type: input.source_type,
        document_title: input.title,
      },
    }));
    
    // 5. Generate embeddings (batched)
    const texts = taggedChunks.map(c => c.content);
    const embeddings = await embedder.embed(texts);
    
    // 6. Store chunks with embeddings
    const chunkValues = taggedChunks.map((chunk, i) => ({
      document_id: doc.id,
      content: chunk.content,
      chunk_index: chunk.chunk_index,
      embedding: embeddings[i],  // vector(3072)
      metadata: chunk.metadata,
    }));
    
    await db.insert(ragChunks).values(chunkValues);
    
    // 7. Update document status
    await db.update(ragDocuments)
      .set({
        status: 'indexed',
        chunk_count: chunks.length,
        last_indexed_at: new Date(),
      })
      .where(eq(ragDocuments.id, doc.id));
    
    return { document_id: doc.id, chunk_count: chunks.length };
    
  } catch (error) {
    // Mark document as failed
    await db.update(ragDocuments)
      .set({ status: 'failed' })
      .where(eq(ragDocuments.id, doc.id));
    throw error;
  }
}

/**
 * Re-index an existing document (e.g., after content update).
 * Deletes old chunks and re-processes.
 */
export async function reindexDocument(documentId: string): Promise<void> {
  // rag_chunks has ON DELETE CASCADE from rag_documents
  // But we're keeping the document — just deleting its chunks
  await db.delete(ragChunks)
    .where(eq(ragChunks.document_id, documentId));
  
  const [doc] = await db.select()
    .from(ragDocuments)
    .where(eq(ragDocuments.id, documentId));
  
  if (!doc) throw new Error(`Document ${documentId} not found`);
  
  // Re-ingest with same parameters
  // Implementation: fetch content from file_url or stored content
  // and run through the same pipeline
}

/**
 * Remove a document and all its chunks from the index.
 */
export async function removeDocument(documentId: string): Promise<void> {
  await db.update(ragDocuments)
    .set({ status: 'archived' })
    .where(eq(ragDocuments.id, documentId));
  
  await db.delete(ragChunks)
    .where(eq(ragChunks.document_id, documentId));
}
```

### 5.5 Metadata Tagger

```typescript
// src/lib/rag/ingestion/metadata.tagger.ts

/**
 * Auto-tag a chunk with searchable metadata.
 * These metadata fields are stored in the rag_chunks.metadata JSONB
 * column and used for pre-filtering during vector search.
 */
export function tagMetadata(
  content: string, 
  sourceType: string
): Record<string, unknown> {
  const tags: Record<string, unknown> = {};
  
  // Detect CBT&A task references (Task 1 through Task 23)
  const taskMatches = content.match(/Task\s+(\d{1,2})/gi);
  if (taskMatches) {
    const taskNumbers = [...new Set(
      taskMatches.map(m => parseInt(m.replace(/Task\s+/i, ''), 10))
    )].filter(n => n >= 1 && n <= 23);
    if (taskNumbers.length > 0) {
      tags.task_numbers = taskNumbers;
    }
  }
  
  // Detect pricing/service references
  if (/\$\d+|\bpric(e|ing)\b|\bcost\b|\bfee\b/i.test(content)) {
    tags.has_pricing = true;
  }
  
  // Detect booking-related content
  if (/\b(book|schedul|availab|appointment|lesson time)\b/i.test(content)) {
    tags.topic = (tags.topic as string[] || []).concat('booking');
  }
  
  // Detect road rules content
  if (/\b(road rule|speed limit|give way|roundabout|intersection|traffic)\b/i.test(content)) {
    tags.topic = (tags.topic as string[] || []).concat('road_rules');
  }
  
  // Detect CBT&A / competency content
  if (/\b(competenc|CBT&?A|assessment|sign.?off|Form 10)\b/i.test(content)) {
    tags.topic = (tags.topic as string[] || []).concat('cbta');
  }
  
  // Detect transmission type
  if (/\bmanual\b/i.test(content)) tags.transmission_manual = true;
  if (/\bauto(matic)?\b/i.test(content)) tags.transmission_auto = true;
  
  return tags;
}
```

---

## 6. Vector Search

```typescript
// src/lib/rag/vector.search.ts

import { db } from '@/lib/db';
import { ragChunks, ragDocuments } from '@/lib/db/schema';
import { sql, eq, and, inArray } from 'drizzle-orm';
import { SEARCH_CONFIG } from './constants';
import type { VectorSearchResult } from './types';

/**
 * Perform cosine similarity search against pgvector.
 * 
 * Query flow:
 * 1. Embed the query text
 * 2. Build metadata filter (optional)
 * 3. Execute cosine similarity search with pgvector <=> operator
 * 4. Filter by similarity threshold
 * 5. Return top-K results with document metadata
 * 
 * Performance note:
 * The ivfflat index on rag_chunks.embedding handles the ANN search.
 * With < 10K chunks (expected for NexDrive), exact search is also fast
 * enough. The ivfflat index is future-proofing.
 */
export async function vectorSearch(
  queryEmbedding: number[],
  options: {
    topK?: number;
    sourceTypes?: string[];
    taskNumber?: number;
    similarityThreshold?: number;
  } = {}
): Promise<VectorSearchResult[]> {
  const {
    topK = SEARCH_CONFIG.default_top_k,
    sourceTypes,
    taskNumber,
    similarityThreshold = SEARCH_CONFIG.similarity_threshold,
  } = options;
  
  // Fetch more candidates than needed for reranking potential
  const fetchCount = Math.min(
    SEARCH_CONFIG.rerank_candidates,
    topK * 2
  );
  
  // Build the query with pgvector cosine distance
  // cosine_distance = 1 - cosine_similarity
  // So similarity = 1 - distance
  // pgvector <=> operator returns cosine distance
  
  const embeddingStr = `[${queryEmbedding.join(',')}]`;
  
  let query = db
    .select({
      chunk_id: ragChunks.id,
      document_id: ragChunks.document_id,
      content: ragChunks.content,
      chunk_index: ragChunks.chunk_index,
      metadata: ragChunks.metadata,
      document_title: ragDocuments.title,
      // Cosine similarity = 1 - cosine distance
      similarity_score: sql<number>`1 - (${ragChunks.embedding} <=> ${embeddingStr}::vector)`,
    })
    .from(ragChunks)
    .innerJoin(ragDocuments, eq(ragChunks.document_id, ragDocuments.id))
    .where(
      and(
        eq(ragDocuments.status, 'indexed'),
        // Similarity threshold filter
        sql`1 - (${ragChunks.embedding} <=> ${embeddingStr}::vector) >= ${similarityThreshold}`,
        // Optional: filter by source type
        sourceTypes && sourceTypes.length > 0
          ? inArray(
              sql`${ragDocuments.source_type}`,
              sourceTypes
            )
          : undefined,
        // Optional: filter by task number in chunk metadata
        taskNumber
          ? sql`${ragChunks.metadata} @> ${JSON.stringify({ task_numbers: [taskNumber] })}::jsonb`
          : undefined,
      )
    )
    .orderBy(sql`${ragChunks.embedding} <=> ${embeddingStr}::vector`)
    .limit(fetchCount);
  
  const results = await query;
  
  // Map to VectorSearchResult and take top-K
  return results.slice(0, topK).map(row => ({
    chunk_id: row.chunk_id,
    document_id: row.document_id,
    document_title: row.document_title,
    content: row.content,
    chunk_index: row.chunk_index,
    metadata: row.metadata as Record<string, unknown>,
    similarity_score: row.similarity_score,
  }));
}
```

---

## 7. RAG Query Pipeline

This is the core orchestrator. Every query from every channel flows through this function.

### 7.1 Pipeline Flow

```
User Message
     │
     ▼
┌─────────────────────┐
│ 1. Rate Limit Check  │  (Upstash Redis, per-session + global)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 2. Handoff Detection │  Keyword match → immediate handoff
└──────────┬──────────┘  (no LLM call needed)
           │
           ▼
┌─────────────────────┐
│ 3. Guardrail Check   │  Off-topic / harmful content → redirect
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 4. Load Conversation │  Fetch last 10 messages from DB
│    History           │  (sliding window)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 5. Classify Intent   │  Claude fast call → booking/question/
│                      │  complaint/callback/general/handoff
└──────────┬──────────┘
           │
     ┌─────┴──────┐
     │            │
     ▼            ▼
  BOOKING      QUESTION / GENERAL
     │            │
     ▼            ▼
┌──────────┐  ┌──────────────┐
│ 6a. Extract│ │ 6b. Embed    │
│ Entities   │ │ Query        │
└─────┬──────┘ └──────┬───────┘
      │               │
      ▼               ▼
┌──────────┐  ┌──────────────┐
│ 6a. Route│  │ 6b. Vector   │
│ to C08   │  │ Search       │
│ Booking  │  │ (top 5)      │
│ Engine   │  └──────┬───────┘
└─────┬────┘         │
      │               ▼
      │         ┌──────────────┐
      │         │ 6b. Build    │
      │         │ Context      │
      │         │ (+ student)  │
      │         └──────┬───────┘
      │                │
      │                ▼
      │         ┌──────────────┐
      │         │ 6b. Claude   │
      │         │ Generate     │
      │         │ Answer       │
      │         └──────┬───────┘
      │                │
      └────────┬───────┘
               │
               ▼
┌─────────────────────┐
│ 7. Score Confidence  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 8. Save Message +    │  Store in conversations + messages tables
│    Return Response   │
└─────────────────────┘
```

### 7.2 Query Service (Orchestrator)

```typescript
// src/lib/rag/query.service.ts

import { classifyIntent } from './intent.classifier';
import { extractBookingEntities } from './entity.extractor';
import { vectorSearch } from './vector.search';
import { buildContext } from './context.builder';
import { fetchStudentContext } from './student.context';
import { generateAnswer } from './llm.service';
import { scoreConfidence } from './confidence.scorer';
import { checkGuardrails, isOffTopic } from './guardrails';
import { detectHandoff } from './handoff.service';
import {
  loadConversationHistory,
  saveMessage,
  getOrCreateSession,
} from './conversation.service';
import { OpenAIEmbedder } from './ingestion/embedder';
import { CONFIDENCE, SEARCH_CONFIG } from './constants';
import type {
  RAGQueryInput,
  RAGQueryResponse,
  StudentContext,
} from './types';

const embedder = new OpenAIEmbedder();

/**
 * Main RAG query pipeline.
 * Called by: C04 (web chat), C05 (voice agent), C06 (SMS agent).
 * 
 * Performance target: < 3 seconds end-to-end.
 * 
 * Critical path timings (budget):
 * - Intent classification: ~300ms (fast Claude call)
 * - Embedding query: ~200ms (OpenAI API)
 * - Vector search: ~100ms (pgvector)
 * - Student context: ~100ms (DB query, parallel with vector search)
 * - Answer generation: ~1500ms (Claude generation)
 * - Overhead: ~300ms
 * - Total budget: ~2500ms
 */
export async function queryRAG(input: RAGQueryInput): Promise<RAGQueryResponse> {
  const startTime = Date.now();
  const parsed = RAGQueryInput.parse(input);  // Zod validation
  
  // ─── Step 1: Get or create conversation session ────────────
  const session = await getOrCreateSession(
    parsed.context?.session_id,
    parsed.context?.channel || 'web_chat',
    parsed.context?.user_id,
  );
  
  // ─── Step 2: Explicit handoff detection (fast, no LLM) ────
  const handoffResult = detectHandoff(parsed.query);
  if (handoffResult.triggered) {
    const response = buildHandoffResponse(session.session_id, handoffResult.reason);
    await saveMessage(session.session_id, 'user', parsed.query, { intent: 'handoff' });
    await saveMessage(session.session_id, 'assistant', response.answer, {
      intent: 'handoff',
      confidence: 1.0,
    });
    return response;
  }
  
  // ─── Step 3: Guardrail check ───────────────────────────────
  const guardrailResult = checkGuardrails(parsed.query);
  if (guardrailResult.blocked) {
    const response = buildGuardrailResponse(session.session_id, guardrailResult.reason);
    await saveMessage(session.session_id, 'user', parsed.query, { intent: 'general' });
    await saveMessage(session.session_id, 'assistant', response.answer, {
      intent: 'general',
      confidence: 1.0,
    });
    return response;
  }
  
  // ─── Step 4: Load conversation history ─────────────────────
  const history = await loadConversationHistory(session.session_id);
  
  // ─── Step 5: Classify intent (parallel-safe) ───────────────
  const intentResult = await classifyIntent(parsed.query, history);
  
  // Handle explicit handoff intent from classifier
  if (intentResult.intent === 'handoff') {
    const response = buildHandoffResponse(session.session_id);
    await saveMessage(session.session_id, 'user', parsed.query, { intent: 'handoff' });
    await saveMessage(session.session_id, 'assistant', response.answer, {
      intent: 'handoff',
      confidence: 1.0,
    });
    return response;
  }
  
  // ─── Step 6: Route by intent ───────────────────────────────
  let answer: string;
  let sources: RAGQueryResponse['sources'] = [];
  let bookingEntities: RAGQueryResponse['booking_entities'];
  let suggestedActions: RAGQueryResponse['suggested_actions'] = [];
  let retrievalScores: number[] = [];
  
  // Fetch student context in parallel (if authenticated)
  const studentContextPromise = parsed.context?.student_id
    ? fetchStudentContext(parsed.context.student_id)
    : Promise.resolve(null);
  
  if (intentResult.intent === 'booking') {
    // ─── BOOKING PATH ──────────────────────────────────────
    // Extract entities (service, date, time preferences)
    bookingEntities = await extractBookingEntities(parsed.query, history);
    
    // Build a natural language response guiding toward booking
    const studentContext = await studentContextPromise;
    const bookingGuidance = await generateBookingGuidance(
      parsed.query,
      bookingEntities,
      studentContext,
      history,
    );
    
    answer = bookingGuidance;
    suggestedActions = ['book_lesson', 'view_availability'];
    
  } else if (intentResult.intent === 'complaint') {
    // ─── COMPLAINT PATH ────────────────────────────────────
    const studentContext = await studentContextPromise;
    answer = await generateComplaintResponse(parsed.query, studentContext, history);
    suggestedActions = ['handoff_to_human', 'call_us'];
    
  } else if (intentResult.intent === 'callback') {
    // ─── CALLBACK PATH ─────────────────────────────────────
    answer = generateCallbackResponse();
    suggestedActions = ['provide_phone', 'call_us'];
    
  } else {
    // ─── QUESTION / GENERAL PATH ───────────────────────────
    // Embed the query
    const queryEmbedding = await embedder.embedSingle(parsed.query);
    
    // Vector search (parallel with student context)
    const [searchResults, studentContext] = await Promise.all([
      vectorSearch(queryEmbedding, {
        topK: parsed.max_results,
        sourceTypes: parsed.filters?.source_types,
        taskNumber: parsed.filters?.task_number,
      }),
      studentContextPromise,
    ]);
    
    retrievalScores = searchResults.map(r => r.similarity_score);
    
    // Build context for LLM
    const llmContext = buildContext(searchResults, studentContext, history);
    
    // Generate answer with Claude
    const llmResult = await generateAnswer(parsed.query, llmContext, parsed.context?.channel);
    answer = llmResult.answer;
    
    // Map sources for response
    sources = searchResults.map(r => ({
      document_id: r.document_id,
      title: r.document_title,
      chunk_content: r.content.slice(0, 200),  // Preview
      score: r.similarity_score,
    }));
    
    // Suggest actions based on content
    suggestedActions = inferSuggestedActions(searchResults, intentResult.intent);
  }
  
  // ─── Step 7: Score confidence ──────────────────────────────
  const confidence = scoreConfidence({
    intentConfidence: intentResult.confidence,
    retrievalScores,
    hasRelevantSources: sources.length > 0,
    answerLength: answer.length,
  });
  
  // If confidence is below threshold, append handoff suggestion
  if (confidence < CONFIDENCE.handoff_suggest) {
    if (!suggestedActions?.includes('handoff_to_human')) {
      suggestedActions = [...(suggestedActions || []), 'handoff_to_human'];
    }
  }
  if (confidence < CONFIDENCE.refuse) {
    answer = "I'm not confident I can answer that accurately. " +
      "Would you like me to have Rob get back to you? " +
      "You can also call us directly or send a message and we'll sort it out.";
    suggestedActions = ['handoff_to_human', 'call_us'];
  }
  
  // ─── Step 8: Save and return ───────────────────────────────
  await saveMessage(session.session_id, 'user', parsed.query, {
    intent: intentResult.intent,
  });
  await saveMessage(session.session_id, 'assistant', answer, {
    intent: intentResult.intent,
    confidence,
    sources: sources.length > 0 ? sources : undefined,
  });
  
  const elapsed = Date.now() - startTime;
  if (elapsed > 3000) {
    console.warn(`RAG query exceeded 3s target: ${elapsed}ms`, {
      intent: intentResult.intent,
      session_id: session.session_id,
    });
  }
  
  return {
    answer,
    sources,
    confidence,
    intent: intentResult.intent,
    suggested_actions: suggestedActions,
    handoff_requested: false,
    booking_entities: bookingEntities,
    session_id: session.session_id,
  };
}

// ─── Helper: Build handoff response ──────────────────────────

function buildHandoffResponse(
  sessionId: string,
  reason?: string
): RAGQueryResponse {
  return {
    answer: reason
      ? `No worries — I'll get Rob to follow up with you. ${reason}`
      : "Absolutely, I'll get Rob to follow up with you. " +
        "If it's urgent, you can reach him directly on 0XXX XXX XXX. " +
        "Otherwise, he'll get back to you as soon as he can.",
    sources: [],
    confidence: 1.0,
    intent: 'handoff',
    suggested_actions: ['call_us'],
    handoff_requested: true,
    session_id: sessionId,
  };
}

// ─── Helper: Build guardrail redirect ────────────────────────

function buildGuardrailResponse(
  sessionId: string,
  reason?: string
): RAGQueryResponse {
  return {
    answer: "I'm NexDrive Academy's assistant — I'm best at helping with " +
      "driving lessons, booking questions, road rules, and learner driver info. " +
      "Is there something along those lines I can help you with?",
    sources: [],
    confidence: 1.0,
    intent: 'general',
    suggested_actions: ['view_pricing', 'book_lesson'],
    handoff_requested: false,
    session_id: sessionId,
  };
}

// ─── Helper: Callback response ───────────────────────────────

function generateCallbackResponse(): string {
  return "No problem — I'll make sure Rob gives you a call back. " +
    "Can you let me know your name and the best number to reach you on? " +
    "And if there's a time that suits you best, I'll pass that along too.";
}

// ─── Helper: Infer suggested actions from results ────────────

function inferSuggestedActions(
  results: Array<{ metadata: Record<string, unknown> }>,
  intent: string,
): RAGQueryResponse['suggested_actions'] {
  const actions: RAGQueryResponse['suggested_actions'] = [];
  
  const hasPricing = results.some(r => r.metadata?.has_pricing);
  const hasBooking = results.some(r => {
    const topics = r.metadata?.topic as string[] | undefined;
    return topics?.includes('booking');
  });
  const hasCBTA = results.some(r => {
    const topics = r.metadata?.topic as string[] | undefined;
    return topics?.includes('cbta');
  });
  
  if (hasPricing) actions.push('view_pricing');
  if (hasBooking) actions.push('book_lesson', 'view_availability');
  if (hasCBTA) actions.push('view_competency_hub');
  
  return actions.length > 0 ? actions : undefined;
}
```

---

## 8. Intent Classification

```typescript
// src/lib/rag/intent.classifier.ts

import { callClaude } from './llm.service';
import { LLM_CONFIG } from './constants';
import type { IntentClassification, ConversationMessage } from './types';

/**
 * Classify the user's intent using a fast Claude call.
 * 
 * This runs early in the pipeline to determine routing.
 * Uses low max_tokens (256) for speed.
 * 
 * Intents:
 * - booking:   Wants to book, reschedule, check availability, ask about scheduling
 * - question:  Asking about services, pricing, road rules, CBT&A, process
 * - complaint: Unhappy, reporting a problem, expressing dissatisfaction
 * - callback:  Wants Rob to call them, leave a message
 * - general:   Greeting, thanks, unclear, chitchat
 * - handoff:   Explicitly asking for a human
 */
export async function classifyIntent(
  query: string,
  history: ConversationMessage[]
): Promise<IntentClassification> {
  const recentHistory = history.slice(-4).map(m =>
    `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
  ).join('\n');
  
  const prompt = `Classify the user's intent for a driving school assistant.

Recent conversation:
${recentHistory || '(new conversation)'}

Current user message: "${query}"

Respond ONLY with valid JSON:
{
  "intent": "booking" | "question" | "complaint" | "callback" | "general" | "handoff",
  "confidence": 0.0 to 1.0
}

Rules:
- "booking" = wants to book, reschedule, check availability, or asks about scheduling
- "question" = asking about services, pricing, road rules, competencies, process, hours, location
- "complaint" = unhappy, reporting a problem, expressing frustration
- "callback" = wants someone to call them back, leave a message for Rob
- "general" = greeting, thanks, unclear, off-topic, chitchat
- "handoff" = explicitly asks for a real person, human, Rob, or to be transferred

JSON only, no explanation:`;

  const response = await callClaude(prompt, {
    maxTokens: LLM_CONFIG.intent_max_tokens,
    temperature: 0.1,  // Very low for classification consistency
  });
  
  try {
    const parsed = JSON.parse(response.trim());
    return {
      intent: parsed.intent,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
    };
  } catch {
    // Fallback: if parsing fails, default to 'general' with low confidence
    return { intent: 'general', confidence: 0.5 };
  }
}
```

---

## 9. Entity Extraction (Booking Path)

```typescript
// src/lib/rag/entity.extractor.ts

import { callClaude } from './llm.service';
import { LLM_CONFIG } from './constants';
import type { BookingEntities, ConversationMessage } from './types';

/**
 * Extract booking-relevant entities from user message.
 * Called when intent = 'booking'.
 * 
 * These entities are passed to the booking guidance generator
 * and can be forwarded to the Booking Engine API to check availability
 * or pre-fill a booking form.
 */
export async function extractBookingEntities(
  query: string,
  history: ConversationMessage[]
): Promise<BookingEntities> {
  const recentHistory = history.slice(-4).map(m =>
    `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
  ).join('\n');
  
  const prompt = `Extract booking-related details from this driving school inquiry.

Conversation context:
${recentHistory || '(new conversation)'}

Current message: "${query}"

Extract any mentioned details. Use null for anything not mentioned.
Respond ONLY with valid JSON:
{
  "service_name": string or null,
  "preferred_date": "ISO date or relative description" or null,
  "preferred_time": "time or period like 'morning', 'afternoon'" or null,
  "preferred_day_of_week": "day name" or null,
  "contact_name": string or null,
  "contact_phone": string or null,
  "contact_email": string or null,
  "transmission": "manual" or "auto" or null
}

Notes:
- Today is ${new Date().toISOString().split('T')[0]}
- Service types include: Learner Lesson, Extended Lesson, Pre-Test Preparation, Review Assessment, Confidence Coaching
- Time periods: "morning" = before noon, "afternoon" = 12-5pm, "evening" = after 5pm

JSON only:`;

  const response = await callClaude(prompt, {
    maxTokens: LLM_CONFIG.entity_max_tokens,
    temperature: 0.1,
  });
  
  try {
    const parsed = JSON.parse(response.trim());
    // Strip null values
    return Object.fromEntries(
      Object.entries(parsed).filter(([_, v]) => v != null)
    ) as BookingEntities;
  } catch {
    return {};
  }
}
```

---

## 10. Context Builder

```typescript
// src/lib/rag/context.builder.ts

import type { VectorSearchResult, StudentContext, ConversationMessage } from './types';
import { CONVERSATION_CONFIG } from './constants';

/**
 * Build the context payload for the LLM answer generation call.
 * 
 * Context is assembled from three sources:
 * 1. Retrieved knowledge chunks (from vector search)
 * 2. Student context (if authenticated — name, progress, bookings)
 * 3. Conversation history (sliding window, last 10 messages)
 * 
 * Token budget management:
 * - Knowledge chunks: ~2000 tokens (5 chunks × ~400 tokens average)
 * - Student context: ~300 tokens
 * - Conversation history: ~3000 tokens (CONVERSATION_CONFIG.max_tokens_history)
 * - System prompt: ~500 tokens
 * - Total context: ~5800 tokens → well within Claude's context window
 */
export function buildContext(
  searchResults: VectorSearchResult[],
  studentContext: StudentContext | null,
  conversationHistory: ConversationMessage[]
): string {
  const sections: string[] = [];
  
  // ─── Knowledge Context ─────────────────────────────────────
  if (searchResults.length > 0) {
    const knowledgeSection = searchResults.map((result, i) => {
      const source = `[Source ${i + 1}: ${result.document_title}]`;
      return `${source}\n${result.content}`;
    }).join('\n\n---\n\n');
    
    sections.push(`## Retrieved Knowledge\n\n${knowledgeSection}`);
  } else {
    sections.push('## Retrieved Knowledge\n\n(No relevant knowledge base results found for this query.)');
  }
  
  // ─── Student Context (authenticated only) ──────────────────
  if (studentContext) {
    const studentSection = formatStudentContext(studentContext);
    sections.push(`## Student Context\n\n${studentSection}`);
  }
  
  // ─── Conversation History ──────────────────────────────────
  if (conversationHistory.length > 0) {
    const trimmedHistory = trimHistoryToTokenBudget(
      conversationHistory,
      CONVERSATION_CONFIG.max_tokens_history
    );
    
    const historySection = trimmedHistory.map(m =>
      `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
    ).join('\n\n');
    
    sections.push(`## Conversation History\n\n${historySection}`);
  }
  
  return sections.join('\n\n---\n\n');
}

function formatStudentContext(ctx: StudentContext): string {
  const lines: string[] = [];
  
  lines.push(`Student: ${ctx.preferred_name || ctx.name}`);
  lines.push(`Transmission: ${ctx.transmission}`);
  lines.push(`Instructor: ${ctx.instructor_name}`);
  
  if (ctx.upcoming_bookings.length > 0) {
    lines.push(`\nUpcoming bookings:`);
    for (const b of ctx.upcoming_bookings.slice(0, 3)) {
      lines.push(`- ${b.date} at ${b.time} — ${b.service}`);
    }
  } else {
    lines.push(`\nNo upcoming bookings.`);
  }
  
  const s = ctx.competency_summary;
  lines.push(`\nCBT&A Progress: ${s.competent}/${s.total_tasks} competencies achieved, ` +
    `${s.in_progress} in progress, ${s.not_started} not started. ` +
    `Total lesson hours: ${s.total_hours.toFixed(1)}`);
  
  if (ctx.package_status?.has_active_package) {
    lines.push(`\nPackage: ${ctx.package_status.package_name} — ` +
      `${ctx.package_status.credits_remaining} credits remaining`);
  }
  
  return lines.join('\n');
}

function trimHistoryToTokenBudget(
  messages: ConversationMessage[],
  maxTokens: number
): ConversationMessage[] {
  // Take from most recent, working backwards
  const result: ConversationMessage[] = [];
  let tokenCount = 0;
  
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = Math.ceil(messages[i].content.length / 4);
    if (tokenCount + msgTokens > maxTokens) break;
    result.unshift(messages[i]);
    tokenCount += msgTokens;
  }
  
  return result;
}
```

---

## 11. Student Context Injection

```typescript
// src/lib/rag/student.context.ts

import { db } from '@/lib/db';
import {
  students, profiles, instructors,
  bookings, services,
  studentCompetencies, competencyTasks,
  studentPackages, packages,
} from '@/lib/db/schema';
import { eq, and, gte, asc, desc } from 'drizzle-orm';
import type { StudentContext } from './types';

/**
 * Fetch student context for RAG personalisation.
 * 
 * CRITICAL: This function NEVER reads private_notes.
 * Only data the student themselves would see is included.
 * 
 * Data fetched:
 * - Student name & preferences
 * - Instructor name
 * - Next 3 upcoming bookings
 * - Competency progress summary (counts only, not detailed notes)
 * - Active package balance
 */
export async function fetchStudentContext(
  studentId: string
): Promise<StudentContext | null> {
  try {
    // Fetch student + profile + instructor in one query
    const [student] = await db
      .select({
        name: profiles.full_name,
        preferred_name: profiles.preferred_name,
        transmission: students.transmission,
        instructor_name: profiles.full_name,
      })
      .from(students)
      .innerJoin(profiles, eq(students.clerk_user_id, profiles.clerk_user_id))
      .innerJoin(instructors, eq(students.instructor_id, instructors.id))
      .innerJoin(
        // Self-join: instructor's profile for their name
        // Using a subquery or alias
        db.select({ full_name: profiles.full_name, id: instructors.id })
          .from(instructors)
          .innerJoin(profiles, eq(instructors.clerk_user_id, profiles.clerk_user_id))
          .as('inst_profile'),
        eq(students.instructor_id, sql`inst_profile.id`)
      )
      .where(eq(students.id, studentId))
      .limit(1);
    
    if (!student) return null;
    
    // Fetch upcoming bookings (next 3, confirmed only)
    const now = new Date();
    const upcomingBookings = await db
      .select({
        date: bookings.booking_date,
        start_time: bookings.start_time,
        service_name: services.name,
      })
      .from(bookings)
      .innerJoin(services, eq(bookings.service_id, services.id))
      .where(and(
        eq(bookings.student_id, studentId),
        eq(bookings.status, 'confirmed'),
        gte(bookings.booking_date, now)
      ))
      .orderBy(asc(bookings.booking_date), asc(bookings.start_time))
      .limit(3);
    
    // Fetch competency summary (aggregated counts)
    // Get the LATEST status per task per student
    const competencies = await db.execute(sql`
      SELECT DISTINCT ON (task_id)
        sc.task_id,
        sc.status
      FROM student_competencies sc
      WHERE sc.student_id = ${studentId}
      ORDER BY sc.task_id, sc.created_at DESC
    `);
    
    const totalTasks = 23;
    let competent = 0;
    let inProgress = 0;
    
    for (const c of competencies.rows) {
      if (c.status === 'competent') competent++;
      else if (['taught', 'assessed', 'not_yet_competent'].includes(c.status as string)) {
        inProgress++;
      }
    }
    
    // Fetch total lesson hours
    const hoursResult = await db.execute(sql`
      SELECT COALESCE(SUM(
        EXTRACT(EPOCH FROM (end_time - start_time)) / 3600
      ), 0) as total_hours
      FROM lessons
      WHERE student_id = ${studentId}
        AND correction_of IS NULL
    `);
    const totalHours = parseFloat(hoursResult.rows[0]?.total_hours as string) || 0;
    
    // Fetch active package
    const [activePackage] = await db
      .select({
        package_name: packages.name,
        credits_remaining: studentPackages.credits_remaining,
      })
      .from(studentPackages)
      .innerJoin(packages, eq(studentPackages.package_id, packages.id))
      .where(and(
        eq(studentPackages.student_id, studentId),
        eq(studentPackages.status, 'active')
      ))
      .limit(1);
    
    return {
      name: student.name,
      preferred_name: student.preferred_name,
      transmission: student.transmission as 'manual' | 'auto',
      instructor_name: student.instructor_name,
      upcoming_bookings: upcomingBookings.map(b => ({
        date: formatDateAustralian(b.date),
        time: formatTimeAustralian(b.start_time),
        service: b.service_name,
      })),
      competency_summary: {
        total_tasks: totalTasks,
        competent,
        in_progress: inProgress,
        not_started: totalTasks - competent - inProgress,
        total_hours: totalHours,
      },
      package_status: activePackage ? {
        has_active_package: true,
        credits_remaining: activePackage.credits_remaining,
        package_name: activePackage.package_name,
      } : null,
    };
  } catch (error) {
    console.error('Failed to fetch student context:', error);
    return null;  // Graceful degradation: RAG works without student context
  }
}

function formatDateAustralian(date: Date | string): string {
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Australia/Canberra',
  }).format(new Date(date));
}

function formatTimeAustralian(time: string): string {
  // Input: "14:00" → Output: "2:00 PM"
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${minutes.toString().padStart(2, '0')} ${period}`;
}
```

---

## 12. LLM Service (Claude Adapter)

```typescript
// src/lib/rag/llm.service.ts

import Anthropic from '@anthropic-ai/sdk';
import { LLM_CONFIG } from './constants';
import { SYSTEM_PROMPT } from './prompts/system.prompt';

// ─── Adapter Interface ───────────────────────────────────────

export interface LLMAdapter {
  generate(params: {
    systemPrompt: string;
    userMessage: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
}

// ─── Claude Implementation ───────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export class ClaudeLLM implements LLMAdapter {
  async generate(params: {
    systemPrompt: string;
    userMessage: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    const response = await anthropic.messages.create({
      model: LLM_CONFIG.model,
      max_tokens: params.maxTokens || LLM_CONFIG.max_tokens,
      temperature: params.temperature ?? LLM_CONFIG.temperature,
      system: params.systemPrompt,
      messages: [
        { role: 'user', content: params.userMessage },
      ],
    });
    
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock?.text || '';
  }
}

const llm = new ClaudeLLM();

// ─── Convenience wrapper ─────────────────────────────────────

export async function callClaude(
  prompt: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  return llm.generate({
    systemPrompt: 'You are a helpful assistant. Respond concisely.',
    userMessage: prompt,
    maxTokens: options?.maxTokens,
    temperature: options?.temperature,
  });
}

// ─── RAG Answer Generation ───────────────────────────────────

export async function generateAnswer(
  query: string,
  context: string,
  channel?: 'web_chat' | 'sms' | 'voice'
): Promise<{ answer: string }> {
  const channelNote = channel === 'sms'
    ? '\n\nIMPORTANT: This is an SMS response. Keep it under 320 characters (2 SMS segments). Be concise.'
    : channel === 'voice'
    ? '\n\nIMPORTANT: This is a voice response (text-to-speech). Use short, clear sentences. Avoid lists. Conversational tone.'
    : '';
  
  const answer = await llm.generate({
    systemPrompt: SYSTEM_PROMPT + channelNote,
    userMessage: `${context}\n\n---\n\nUser question: ${query}`,
    maxTokens: channel === 'sms' ? 200 : LLM_CONFIG.max_tokens,
    temperature: LLM_CONFIG.temperature,
  });
  
  return { answer };
}

// ─── Booking Guidance Generation ─────────────────────────────

export async function generateBookingGuidance(
  query: string,
  entities: Record<string, unknown>,
  studentContext: import('./types').StudentContext | null,
  history: import('./types').ConversationMessage[]
): Promise<string> {
  const entitySummary = Object.entries(entities)
    .filter(([_, v]) => v != null)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  
  const studentNote = studentContext
    ? `The student is ${studentContext.preferred_name || studentContext.name} (${studentContext.transmission} transmission).`
    : 'This is a new/anonymous enquiry.';
  
  const prompt = `The user wants to book a driving lesson.

${studentNote}

Extracted booking details: ${entitySummary || 'none yet'}

User message: "${query}"

Help them toward booking. If you have enough details (service, date/time preference), suggest they use the booking form or offer to check availability. If details are missing, ask for them naturally. Be warm and helpful. Don't make up availability — suggest they check online or you can look it up.`;

  return llm.generate({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: prompt,
    maxTokens: LLM_CONFIG.max_tokens,
    temperature: 0.4,
  });
}

// ─── Complaint Response ──────────────────────────────────────

async function generateComplaintResponse(
  query: string,
  studentContext: import('./types').StudentContext | null,
  history: import('./types').ConversationMessage[]
): Promise<string> {
  const studentNote = studentContext
    ? `The student is ${studentContext.preferred_name || studentContext.name}.`
    : 'This is an unidentified enquiry.';

  const prompt = `A customer is expressing a complaint or dissatisfaction.

${studentNote}

Their message: "${query}"

Acknowledge their concern sincerely. Apologise for any inconvenience. Offer to have Rob follow up with them personally. Do NOT try to resolve complex complaints — this needs a human.`;

  return llm.generate({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: prompt,
    maxTokens: LLM_CONFIG.max_tokens,
    temperature: 0.3,
  });
}
```

---

## 13. System Prompt (NexDrive Persona)

```typescript
// src/lib/rag/prompts/system.prompt.ts

export const SYSTEM_PROMPT = `You are the AI assistant for NexDrive Academy, a driving school in Canberra, ACT, Australia, run by Rob Harrison.

## Your Role
You help prospective and current students with questions about driving lessons, booking, pricing, road rules, CBT&A competencies, and general learner driver advice. You're the friendly front desk — warm, knowledgeable, and genuinely helpful.

## Personality & Tone
- Warm, friendly Australian English. You can say "G'day" but don't overdo the slang.
- Professional but approachable — like a knowledgeable mate, not a corporate chatbot.
- Encouraging and supportive — learning to drive can be stressful.
- Honest — if you don't know, say so. Never guess at pricing or availability.
- Concise — get to the point without being curt.

## What You Know
- NexDrive Academy services, pricing, and policies (from your knowledge base)
- ACT CBT&A (Competency Based Training & Assessment) system and its 23 competency tasks
- ACT road rules and driving regulations
- General learner driver advice and encouragement
- If authenticated: the student's name, upcoming bookings, competency progress, and package status

## Rules (Non-Negotiable)
1. NEVER make up pricing. Only quote prices that appear in your retrieved knowledge. If unsure, say "Pricing starts from around [range] — check our website or I can have Rob confirm the exact cost."
2. NEVER make up availability. Say "I can help you find a time — let me know your preferences and I'll check what's available" or direct them to the booking page.
3. NEVER share private instructor notes or internal business data.
4. NEVER provide medical, legal, or financial advice.
5. If someone asks about something outside driving/NexDrive/road rules, gently redirect: "I'm best at helping with driving-related questions — is there something about lessons or road rules I can help with?"
6. If you're not confident in your answer, acknowledge it: "I'm not 100% sure about that — let me have Rob get back to you with the details."
7. If someone is upset or has a complaint, acknowledge their feelings, apologise, and offer to have Rob follow up personally.
8. If someone explicitly asks for a human / Rob / real person, ALWAYS respect that immediately.
9. When referencing the CBT&A system, explain it simply: "In the ACT, learner drivers work through 23 competency tasks — things like steering, reversing, merging — and each one gets signed off as you master it."

## Source Attribution
When your answer draws from your knowledge base, naturally reference where the information comes from. For example: "According to our FAQ..." or "Based on the ACT road rules..." Don't use numbered citations — keep it conversational.

## Student Context
If you have context about the student (authenticated session), use their name and reference their progress naturally. For example: "Hey Sarah, looks like you've got a lesson coming up on Tuesday — great progress with your competencies so far!"

## Formatting
- Use natural paragraphs, not bullet lists (unless listing specific options).
- Keep responses focused — 2-4 sentences for simple questions, longer for complex ones.
- For SMS: ultra-concise, under 320 characters.
- For voice: short sentences, conversational flow, no visual formatting.`;
```

---

## 14. Guardrails

```typescript
// src/lib/rag/guardrails.ts

import { HANDOFF_TRIGGERS } from './constants';

interface GuardrailResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Check if a message should be blocked or redirected.
 * 
 * Three layers:
 * 1. Safety: Block harmful/abusive content
 * 2. Off-topic: Redirect non-driving topics
 * 3. Scope: Don't answer medical/legal/financial questions
 */
export function checkGuardrails(query: string): GuardrailResult {
  const lower = query.toLowerCase().trim();
  
  // Layer 1: Safety — block obvious abuse
  // (In production, this would also use a content moderation API)
  if (containsAbusiveContent(lower)) {
    return {
      blocked: true,
      reason: 'I\'m here to help with driving-related questions. Let me know if there\'s something I can assist with.',
    };
  }
  
  // Layer 2: Scope — redirect medical/legal/financial
  if (isMedicalLegalFinancial(lower)) {
    return {
      blocked: true,
      reason: 'That\'s outside my area of expertise — I\'d recommend speaking with an appropriate professional. ' +
        'Is there anything about driving lessons I can help with?',
    };
  }
  
  // Layer 3: Off-topic detection (basic keyword check)
  // Note: The LLM itself also has guardrails in the system prompt.
  // This is a fast pre-filter for obvious off-topic queries.
  // Borderline cases pass through to the LLM which handles them more nuancedly.
  
  return { blocked: false };
}

/**
 * Detect explicit handoff requests.
 * Fast keyword match — no LLM call needed.
 */
export function detectHandoff(query: string): {
  triggered: boolean;
  reason?: string;
} {
  const lower = query.toLowerCase().trim();
  
  for (const trigger of HANDOFF_TRIGGERS) {
    if (lower.includes(trigger)) {
      return { triggered: true };
    }
  }
  
  return { triggered: false };
}

// ─── Helper Functions ────────────────────────────────────────

function containsAbusiveContent(text: string): boolean {
  // Basic check — production would use a moderation API
  const patterns = [
    /\b(fuck\s*you|kill\s*(your|my)self|kys)\b/i,
  ];
  return patterns.some(p => p.test(text));
}

function isMedicalLegalFinancial(text: string): boolean {
  const patterns = [
    /\b(diagnos|prescription|medic(al|ation)|symptom|treatment|dosage)\b/i,
    /\b(lawsuit|legal\s*advice|sue|attorney|lawyer)\b/i,
    /\b(invest(ment)?|stock|crypto|tax\s*(advice|return)|financial\s*advi)/i,
  ];
  return patterns.some(p => p.test(text));
}

/**
 * Check if a topic is within NexDrive's domain.
 * Used as a soft check — doesn't block, but flags for the LLM.
 */
export function isOffTopic(query: string): boolean {
  const lower = query.toLowerCase();
  const drivingKeywords = [
    'driv', 'lesson', 'book', 'learn', 'road', 'car', 'licence', 'license',
    'test', 'instructor', 'park', 'steer', 'brake', 'revers', 'merg',
    'competen', 'cbt', 'nexdrive', 'rob', 'price', 'cost', 'avail',
    'cancel', 'reschedul', 'hour', 'manual', 'auto', 'transmission',
    'roundabout', 'intersection', 'speed', 'signal', 'mirror', 'blind spot',
    'parallel', 'three point', 'hill start', 'hazard', 'pedestrian',
    'school zone', 'sign', 'give way', 'right of way', 'overtake',
    'freeway', 'highway', 'act', 'canberra',
  ];
  
  return !drivingKeywords.some(kw => lower.includes(kw));
}
```

---

## 15. Confidence Scoring

```typescript
// src/lib/rag/confidence.scorer.ts

import { CONFIDENCE } from './constants';

interface ConfidenceInputs {
  intentConfidence: number;    // From intent classifier
  retrievalScores: number[];   // Similarity scores of retrieved chunks
  hasRelevantSources: boolean; // Did vector search return anything?
  answerLength: number;        // Rough proxy for answer quality
}

/**
 * Compute overall confidence score for a RAG response.
 * 
 * Score components:
 * - Intent confidence (30%): How sure are we about what they're asking?
 * - Retrieval quality (50%): How relevant were the knowledge chunks?
 * - Answer grounding (20%): Is the answer well-supported?
 * 
 * The resulting score determines response behaviour:
 * - >= 0.80: Confident answer, no caveats
 * - 0.60–0.79: Answer with softer language ("I believe...", "Based on what I know...")
 * - 0.40–0.59: Answer but suggest human follow-up
 * - < 0.40: Don't answer, escalate to human
 */
export function scoreConfidence(inputs: ConfidenceInputs): number {
  const { intentConfidence, retrievalScores, hasRelevantSources, answerLength } = inputs;
  
  // ─── Component 1: Intent Confidence (30%) ──────────────────
  const intentScore = intentConfidence;
  
  // ─── Component 2: Retrieval Quality (50%) ──────────────────
  let retrievalScore: number;
  
  if (retrievalScores.length === 0) {
    // No retrieval (booking intent, greeting, etc.) — neutral
    retrievalScore = 0.7;
  } else {
    // Weighted average: top result matters most
    const topScore = retrievalScores[0] || 0;
    const avgScore = retrievalScores.reduce((a, b) => a + b, 0) / retrievalScores.length;
    retrievalScore = topScore * 0.6 + avgScore * 0.4;
  }
  
  // ─── Component 3: Answer Grounding (20%) ───────────────────
  let groundingScore: number;
  
  if (!hasRelevantSources && retrievalScores.length > 0) {
    // Searched but found nothing relevant
    groundingScore = 0.3;
  } else if (answerLength < 20) {
    // Very short answer might be low quality
    groundingScore = 0.5;
  } else {
    groundingScore = 0.8;
  }
  
  // ─── Weighted combination ──────────────────────────────────
  const combined = (intentScore * 0.3) + (retrievalScore * 0.5) + (groundingScore * 0.2);
  
  // Clamp to [0, 1]
  return Math.min(1, Math.max(0, Number(combined.toFixed(2))));
}
```

---

## 16. Conversation History

```typescript
// src/lib/rag/conversation.service.ts

import { db } from '@/lib/db';
import { conversations, messages } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { CONVERSATION_CONFIG } from './constants';
import type { ConversationMessage, ConversationState } from './types';

/**
 * Get or create a conversation session.
 * 
 * Sessions map to the `conversations` table.
 * A session expires after 30 minutes of inactivity (CONVERSATION_CONFIG.session_ttl_seconds).
 */
export async function getOrCreateSession(
  sessionId: string | undefined,
  channel: 'web_chat' | 'sms' | 'voice',
  userId?: string
): Promise<{ session_id: string; is_new: boolean }> {
  if (sessionId) {
    // Check if session exists and is active
    const [existing] = await db.select()
      .from(conversations)
      .where(eq(conversations.id, sessionId))
      .limit(1);
    
    if (existing && existing.status === 'active') {
      const lastActivity = new Date(existing.last_message_at);
      const ttl = CONVERSATION_CONFIG.session_ttl_seconds * 1000;
      
      if (Date.now() - lastActivity.getTime() < ttl) {
        return { session_id: sessionId, is_new: false };
      }
      // Session expired — close it and create new
      await db.update(conversations)
        .set({ status: 'closed' })
        .where(eq(conversations.id, sessionId));
    }
  }
  
  // Create new session
  const newId = uuidv4();
  await db.insert(conversations).values({
    id: newId,
    channel,
    channel_identifier: sessionId || newId,
    user_id: userId || null,
    mode: userId ? 'student' : 'prospect',
    status: 'active',
    started_at: new Date(),
    last_message_at: new Date(),
    message_count: 0,
  });
  
  return { session_id: newId, is_new: true };
}

/**
 * Load conversation history (sliding window: last N messages).
 */
export async function loadConversationHistory(
  sessionId: string
): Promise<ConversationMessage[]> {
  const rows = await db.select({
    direction: messages.direction,
    sender_type: messages.sender_type,
    content: messages.content,
    created_at: messages.created_at,
    intent_detected: messages.intent_detected,
    confidence: messages.confidence,
  })
  .from(messages)
  .where(eq(messages.conversation_id, sessionId))
  .orderBy(desc(messages.created_at))
  .limit(CONVERSATION_CONFIG.max_history_messages);
  
  // Reverse to chronological order
  return rows.reverse().map(row => ({
    role: row.sender_type === 'user' ? 'user' as const : 'assistant' as const,
    content: row.content,
    timestamp: new Date(row.created_at),
    intent: row.intent_detected as any,
    confidence: row.confidence ? Number(row.confidence) : undefined,
  }));
}

/**
 * Save a message to the conversation.
 */
export async function saveMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  metadata?: {
    intent?: string;
    confidence?: number;
    sources?: Array<{ document_id: string; title: string; score: number }>;
  }
): Promise<void> {
  await db.insert(messages).values({
    conversation_id: sessionId,
    direction: role === 'user' ? 'inbound' : 'outbound',
    sender_type: role === 'user' ? 'user' : 'ai',
    content,
    intent_detected: metadata?.intent || null,
    confidence: metadata?.confidence?.toString() || null,
    rag_sources: metadata?.sources ? JSON.stringify(metadata.sources) : null,
  });
  
  // Update conversation metadata
  await db.update(conversations)
    .set({
      last_message_at: new Date(),
      message_count: sql`message_count + 1`,
    })
    .where(eq(conversations.id, sessionId));
}
```

---

## 17. Handoff Service

```typescript
// src/lib/rag/handoff.service.ts

import { db } from '@/lib/db';
import { conversations } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { HANDOFF_TRIGGERS } from './constants';

/**
 * Detect explicit handoff request from keywords.
 * This is a fast, deterministic check — no LLM call.
 */
export function detectHandoff(query: string): {
  triggered: boolean;
  reason?: string;
} {
  const lower = query.toLowerCase().trim();
  
  for (const trigger of HANDOFF_TRIGGERS) {
    if (lower.includes(trigger)) {
      return { triggered: true };
    }
  }
  
  return { triggered: false };
}

/**
 * Execute handoff — mark conversation for human follow-up.
 * 
 * This:
 * 1. Updates conversation status to 'handoff_requested'
 * 2. Triggers notification to Rob (via C18 Notification Engine)
 * 3. Logs in audit trail
 */
export async function executeHandoff(
  sessionId: string,
  reason: string
): Promise<void> {
  // Mark conversation
  await db.update(conversations)
    .set({
      status: 'handoff_requested',
      handoff_reason: reason,
    })
    .where(eq(conversations.id, sessionId));
  
  // Emit event for notification engine
  // (In-process event bus per arch doc ADR-005)
  const { eventBus } = await import('@/lib/events');
  eventBus.emit('CALLBACK_REQUESTED', {
    session_id: sessionId,
    reason,
    timestamp: new Date(),
  });
}

/**
 * Check if confidence warrants suggesting handoff.
 * Called after answer generation.
 */
export function shouldSuggestHandoff(confidence: number): boolean {
  return confidence < 0.60;
}

export function shouldAutoHandoff(confidence: number): boolean {
  return confidence < 0.40;
}
```

---

## 18. API Routes

### 18.1 Query Endpoint

```typescript
// src/app/api/internal/rag/query/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { queryRAG } from '@/lib/rag/query.service';
import { RAGQueryInput } from '@/lib/rag/types';
import { verifyInternalRequest } from '@/lib/auth/internal';
import { rateLimit } from '@/lib/rate-limit';

/**
 * POST /api/internal/rag/query
 * 
 * Internal-only endpoint. Called by C04, C05, C06.
 * NOT exposed to the public internet.
 * 
 * Authentication: Internal service token (shared secret).
 * Rate limited: 15 req/min per session, 60 req/min global.
 */
export async function POST(req: NextRequest) {
  try {
    // Verify internal caller
    verifyInternalRequest(req);
    
    // Rate limit
    const sessionId = req.headers.get('x-session-id') || 'anonymous';
    const { success } = await rateLimit(`rag:${sessionId}`, 15, 60);
    if (!success) {
      return NextResponse.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
        { status: 429 }
      );
    }
    
    const body = await req.json();
    const input = RAGQueryInput.parse(body);
    
    const result = await queryRAG(input);
    
    return NextResponse.json(result);
    
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('RAG query error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to process query' } },
      { status: 500 }
    );
  }
}
```

### 18.2 Document Index Endpoint

```typescript
// src/app/api/internal/rag/index/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { ingestDocument } from '@/lib/rag/ingestion/ingest.service';
import { DocumentIngestionInput } from '@/lib/rag/types';
import { verifyInternalRequest } from '@/lib/auth/internal';

/**
 * POST /api/internal/rag/index
 * 
 * Index a new document into the knowledge base.
 * Internal-only — called by admin panel or seed scripts.
 */
export async function POST(req: NextRequest) {
  try {
    verifyInternalRequest(req);
    
    const body = await req.json();
    const input = DocumentIngestionInput.parse(body);
    
    const result = await ingestDocument(input);
    
    return NextResponse.json(result, { status: 201 });
    
  } catch (error) {
    console.error('Document ingestion error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to index document' } },
      { status: 500 }
    );
  }
}
```

### 18.3 Document Management Endpoints

```typescript
// src/app/api/internal/rag/documents/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ragDocuments } from '@/lib/db/schema';
import { ne } from 'drizzle-orm';
import { verifyInternalRequest } from '@/lib/auth/internal';

/**
 * GET /api/internal/rag/documents
 * List all indexed documents.
 */
export async function GET(req: NextRequest) {
  verifyInternalRequest(req);
  
  const docs = await db.select()
    .from(ragDocuments)
    .where(ne(ragDocuments.status, 'archived'))
    .orderBy(ragDocuments.created_at);
  
  return NextResponse.json({ documents: docs });
}
```

```typescript
// src/app/api/internal/rag/documents/[id]/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { removeDocument } from '@/lib/rag/ingestion/ingest.service';
import { verifyInternalRequest } from '@/lib/auth/internal';

/**
 * DELETE /api/internal/rag/documents/:id
 * Remove a document from the index (archives it, deletes chunks).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  verifyInternalRequest(req);
  
  await removeDocument(params.id);
  
  return NextResponse.json({ deleted: true });
}
```

### 18.4 Reindex Endpoint

```typescript
// src/app/api/internal/rag/reindex/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ragDocuments } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { reindexDocument } from '@/lib/rag/ingestion/ingest.service';
import { verifyInternalRequest } from '@/lib/auth/internal';

/**
 * POST /api/internal/rag/reindex
 * Re-index all documents (or a specific document).
 * Body: { "document_id"?: string }  (omit for all)
 */
export async function POST(req: NextRequest) {
  verifyInternalRequest(req);
  
  const body = await req.json().catch(() => ({}));
  
  if (body.document_id) {
    await reindexDocument(body.document_id);
    return NextResponse.json({ reindexed: [body.document_id] });
  }
  
  // Reindex all indexed documents
  const docs = await db.select({ id: ragDocuments.id })
    .from(ragDocuments)
    .where(eq(ragDocuments.status, 'indexed'));
  
  const results = await Promise.allSettled(
    docs.map(d => reindexDocument(d.id))
  );
  
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  
  return NextResponse.json({
    total: docs.length,
    succeeded,
    failed,
  });
}
```

---

## 19. Internal Request Verification

```typescript
// src/lib/auth/internal.ts

import { NextRequest } from 'next/server';

/**
 * Verify that a request to an internal API route is from an authorised
 * internal service (C04, C05, C06, admin scripts).
 * 
 * Uses a shared secret in the x-internal-token header.
 * In production, this could be replaced with mTLS or a service mesh.
 */
export function verifyInternalRequest(req: NextRequest): void {
  const token = req.headers.get('x-internal-token');
  
  if (!token || token !== process.env.INTERNAL_API_TOKEN) {
    throw new Error('Unauthorised internal request');
  }
}
```

---

## 20. Knowledge Base Seed Content Plan

### 20.1 Initial Corpus Inventory

| Category | Documents | Est. Chunks | Source | Priority |
|----------|-----------|-------------|--------|----------|
| **FAQ** | 1 (30-40 Q&A pairs) | 35 | Rob writes / AI assists | P0 — Week 7 |
| **Services & Pricing** | 1 (all services + packages) | 10 | From `services` table descriptions + Rob's notes | P0 — Week 7 |
| **Booking Policies** | 1 (cancellation, rescheduling, payment) | 8 | Rob writes | P0 — Week 7 |
| **Business Info** | 1 (hours, location, contact, about) | 5 | Website content | P0 — Week 7 |
| **CBT&A Competencies** | 1 (all 23 tasks — descriptions, what's involved) | 25 | ACT Government docs + Rob's teaching context | P1 — Week 8 |
| **ACT Road Rules** | 3-5 (key rules for learners: speed, give way, roundabouts, school zones, parking) | 40 | ACT road rules handbook (summarised, not copied) | P1 — Week 8-9 |
| **Teaching Methodology** | 1 (IPSGA, GDE Matrix, NexDrive approach) | 12 | Rob writes | P2 — Week 9 |
| **Parent/Supervisor Guide** | 1 (how to supervise practice, what to expect) | 10 | Rob writes | P2 — Week 10 |
| **Blog Stubs** | 5 (initial blog posts for SEO + knowledge) | 20 | AI-assisted with Rob's review | P3 — Week 11 |

**Total estimated: ~165 chunks at launch.**

At 3072 dimensions per chunk, storage requirement: ~165 × 3072 × 4 bytes ≈ 2 MB of vector data. Well within Neon's free tier.

### 20.2 Content Refresh Strategy

| Trigger | Action | Frequency |
|---------|--------|-----------|
| Service/pricing change | Admin updates service → reindex `services` doc | As needed |
| New FAQ question | Admin adds Q&A → reindex FAQ doc | Weekly review |
| Policy change | Admin updates policy doc → reindex | As needed |
| New blog post | Auto-index on publish | On publish |
| Regulatory change | Admin uploads updated regulation → reindex | Annual / as needed |
| Competency descriptions | Admin edits → reindex | Rare |

### 20.3 Content Format Guidelines

All knowledge base documents should follow these conventions:

**FAQ documents:**
```
Q: How many lessons do I need to get my licence?
A: Every learner is different, but most people need between 30-60 hours of professional instruction alongside their supervised practice hours. In the ACT, you need a minimum of... [grounded answer]
```

**Service descriptions:**
```
## Learner Lesson (60 minutes) — $105.00
A standard one-hour driving lesson covering CBT&A competencies. Suitable for all stages of learning from complete beginners to test preparation. Includes pick-up and drop-off within the Canberra metro area.
```

**Regulation summaries:**
```
## Task 3: Steering and Wheel Control
Category: Vehicle Control
Prerequisites: Task 1, Task 2
Description: The learner demonstrates smooth, controlled steering technique including hand-over-hand, pull-push method, and appropriate grip...
```

---

## 21. Performance Optimisation

### 21.1 Critical Path Timing Budget

| Step | Target | Technique |
|------|--------|-----------|
| Rate limit check | < 10ms | Upstash Redis in Sydney |
| Handoff/guardrail check | < 5ms | In-memory keyword match |
| Intent classification | < 400ms | Claude with 256 max_tokens, temp 0.1 |
| Query embedding | < 250ms | OpenAI API |
| Vector search | < 150ms | pgvector ivfflat index, Neon Sydney |
| Student context fetch | < 150ms | Parallel with vector search |
| Answer generation | < 1800ms | Claude with 1024 max_tokens, temp 0.3 |
| Save to DB | < 100ms | Async (non-blocking) |
| **Total** | **< 2860ms** | **Under 3s target** |

### 21.2 Optimisation Techniques

1. **Parallel execution:** Vector search and student context fetch run concurrently via `Promise.all`.
2. **Fast-path for simple intents:** Handoff and greeting don't need vector search or LLM generation.
3. **Token limits:** Intent classification uses 256 max_tokens; SMS responses use 200. Only full answers use 1024.
4. **Low temperature:** Classification uses 0.1 (deterministic). Answers use 0.3 (grounded but natural).
5. **Connection pooling:** Neon serverless driver handles connection pooling automatically.
6. **Embedding cache (future):** Cache frequent query embeddings in Upstash Redis (hash of query → embedding vector). TTL: 1 hour.
7. **Chunk pre-filtering:** Metadata filters (source_type, task_number) reduce the search space before ANN runs.

### 21.3 Monitoring

| Metric | Tool | Alert Threshold |
|--------|------|-----------------|
| End-to-end latency (p95) | Sentry performance | > 3s |
| Intent classification accuracy | PostHog (manual sample) | < 85% monthly |
| Retrieval relevance | PostHog (manual sample) | Top result < 0.7 avg |
| Handoff rate | PostHog | > 30% of conversations |
| Confidence distribution | PostHog | Avg < 0.65 |
| LLM error rate | Sentry | > 1% |
| Embedding API errors | Sentry | Any |
| Vector search latency (p95) | Custom timing | > 500ms |

---

## 22. Environment Variables

```env
# LLM
ANTHROPIC_API_KEY=sk-ant-...

# Embeddings
OPENAI_API_KEY=sk-...

# Internal API
INTERNAL_API_TOKEN=nexdrive-internal-...  # Shared secret for internal routes

# Database (inherited from SPEC-01)
DATABASE_URL=postgresql://...@ep-xxx.ap-southeast-2.aws.neon.tech/nexdrive

# Rate limiting (inherited from Phase 0)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

---

## 23. Testing Strategy

### 23.1 Unit Tests

| Module | Test Focus |
|--------|-----------|
| `chunker.ts` | Paragraph splitting, FAQ pair detection, chunk sizes within bounds, overlap verification |
| `metadata.tagger.ts` | Task number extraction, pricing detection, topic classification |
| `confidence.scorer.ts` | Score computation for various input combinations, threshold behaviour |
| `guardrails.ts` | Handoff trigger matching, off-topic detection, safety blocks |
| `intent.classifier.ts` | Mock LLM responses → correct intent parsing, fallback on parse failure |
| `entity.extractor.ts` | Mock LLM responses → correct entity extraction, null handling |
| `context.builder.ts` | Context assembly with/without student data, token budget trimming |
| `conversation.service.ts` | Session creation, history loading, sliding window, TTL expiry |

### 23.2 Integration Tests

| Test | What It Verifies |
|------|-----------------|
| Full query pipeline (question) | Query → embed → search → generate → response with sources |
| Full query pipeline (booking) | Query → classify → extract entities → booking guidance |
| Full query pipeline (handoff) | "Talk to Rob" → immediate handoff, no LLM call |
| Document ingestion | Upload → chunk → embed → store → verify retrievable |
| Conversation continuity | Multi-turn conversation → history maintained, context flows |
| Student context injection | Authenticated query → student data in LLM context |
| Rate limiting | Exceed limit → 429 response |

### 23.3 Evaluation Dataset

Build a test set of 50 representative queries across categories:

| Category | Count | Example |
|----------|-------|---------|
| Booking questions | 10 | "Can I book a lesson for Saturday morning?" |
| Pricing questions | 5 | "How much does a lesson cost?" |
| CBT&A questions | 8 | "What's Task 7 about?" |
| Road rules | 7 | "What's the speed limit in a school zone?" |
| General enquiry | 5 | "Where are you located?" |
| Off-topic | 5 | "What's the weather like?" |
| Handoff requests | 5 | "Can I speak to Rob?" |
| Complaints | 3 | "I'm not happy with my last lesson" |
| Callback requests | 2 | "Can Rob call me back?" |

Evaluate on: intent accuracy, answer relevance, confidence calibration, response time.

---

## 24. Dependencies

```json
{
  "@anthropic-ai/sdk": "^0.30.x",
  "openai": "^4.x",
  "uuid": "^9.x",
  "zod": "^3.x",
  "pdf-parse": "^1.x",
  "cheerio": "^1.x"
}
```

These are in addition to the base project dependencies (Next.js, Drizzle, etc.) established in Phase 0.

---

## 25. Implementation Sequence

| Day | Task | Depends On |
|-----|------|-----------|
| 1 | Types, constants, error classes, file structure | SPEC-01 tables exist |
| 2 | Chunker (all strategies) + unit tests | — |
| 3 | Embedder (OpenAI adapter) + metadata tagger | OpenAI API key |
| 4 | Ingestion service (orchestrator) + integration test | Days 2-3 |
| 5 | Vector search implementation + pgvector index verification | SPEC-01 rag_chunks table |
| 6 | Intent classifier + entity extractor + prompts | Anthropic API key |
| 7 | LLM service (Claude adapter) + system prompt + answer generation | Day 6 |
| 8 | Context builder + student context injection | SPEC-01 student tables |
| 9 | Conversation service (session management, history) | SPEC-01 conversations/messages tables |
| 10 | Query orchestrator (full pipeline) + confidence scorer | Days 6-9 |
| 11 | Guardrails + handoff service | Day 10 |
| 12 | API routes (query, index, documents, reindex) | Day 10 |
| 13 | Seed knowledge base (FAQ, services, policies) | Day 12 + Rob's content |
| 14 | End-to-end testing, performance tuning, monitoring setup | All above |

---

*End of SPEC-08: RAG Knowledge Engine*

*Consumers: SPEC-09 (Voice Agent C05), SPEC-10 (SMS Agent C06), SPEC-11 (Web Chat C04) will each call this engine's query API and format responses for their channel.*
