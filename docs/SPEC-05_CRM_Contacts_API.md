# SPEC-05: CRM & Contacts API (C09)
### NexDrive Academy — Phase 1 Revenue Engine
**Version:** 1.1  
**Date:** 20 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.6, §5.2; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-03 (Booking Engine — upsertContact pattern)  
**Phase:** 1 (Revenue Engine — Weeks 3-6)  
**Estimated Effort:** 8-10 days  

---

## 1. Overview

The CRM & Contacts module is NexDrive Academy's contact management backbone. Every person who interacts with the business — from an anonymous website visitor who fills in an enquiry form, to an active student with 15 completed lessons — is represented as a `contacts` record. The CRM tracks their lifecycle from prospect through to alumni, scores their engagement, aggregates all interactions into a unified timeline, and provides the conversion flow that turns a prospect into an enrolled student.

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **Every person is a contact first.** Before a student record, before a Clerk account — there is a contact. Bookings, voice calls, SMS messages, web chats, and manual entries all create or update contacts.
2. **Phone is the primary identifier.** In Australia's driving school market, phone numbers are the most reliable de-duplication key. Email is secondary. Contacts matched by phone OR email are treated as the same person.
3. **Multi-instructor from day one.** Every contact has an `instructor_id`. Instructor role users only see their own contacts.
4. **Soft delete only.** Contacts use `deleted_at` (nullable timestamp). No hard deletes — historical interaction data must be preserved.
5. **Lead scoring is computed, not stored permanently.** The `lead_score` column is updated by a scoring function triggered on interactions. It is always re-derivable.
6. **Lifecycle transitions are validated.** Not every stage can move to every other stage. The state machine enforces valid transitions.
7. **Contact creation emits `CONTACT_CREATED`.** Downstream listeners (Notification Engine, auto-assign instructor) subscribe to this event.
8. **Admin sees all contacts. Instructor sees own contacts. Students and parents see nothing.** Per SPEC-02 access matrix.
9. **UTM parameters are captured at first contact and never overwritten.** Attribution belongs to the original source.
10. **All times are AEST/AEDT (`Australia/Canberra`).** Database stores `TIMESTAMPTZ` (UTC internally).

### 1.2 Lifecycle Stage State Machine

```
                                ┌────────────┐
                                │            │
    ┌──────────┐  ┌──────────┐ │ ┌────────┐ │  ┌───────────┐  ┌───────────┐
    │ prospect │─►│   lead   │─┼►│enrolled│─┼─►│  active   │─►│ completed │
    └────┬─────┘  └────┬─────┘ │ └────────┘ │  └───────────┘  └─────┬─────┘
         │              │       │            │                       │
         │              │       └────────────┘                       │
         │              │                                            ▼
         │              ▼                                      ┌───────────┐
         │         ┌─────────┐                                 │  alumni   │
         │         │qualified│                                 └───────────┘
         │         └────┬────┘
         │              │
         ▼              ▼
    ┌──────────────────────┐
    │        lost          │
    └──────────────────────┘
```

**Valid Transitions:**

| From | To | Trigger | Conditions |
|------|----|---------|------------|
| `prospect` | `lead` | System auto-promote | Interaction count ≥ 2, or explicit intent signal (asked about pricing/booking) |
| `prospect` | `lost` | Manual (instructor/admin) | Unresponsive, invalid contact |
| `lead` | `qualified` | Manual (instructor/admin) | Confirmed interest, knows requirements, ready to book |
| `lead` | `lost` | Manual or 90-day inactivity | No engagement after follow-up attempts |
| `qualified` | `enrolled` | Convert action (`POST /convert`) | Creates student record, links Clerk account if exists |
| `qualified` | `lost` | Manual (instructor/admin) | Chose competitor, not proceeding |
| `enrolled` | `active` | System: first lesson completed | Lesson record created for this student |
| `active` | `completed` | System: all 23 CBT&A tasks achieved | Certificate of Competency issued |
| `completed` | `alumni` | System: 30 days post-completion | Auto-transition via cron job |
| `lost` | `prospect` | Manual (instructor/admin) | Re-engaged contact — reset lead score, log re-activation |

**Terminal-ish states:** `alumni` and `lost` are soft-terminal. `lost` can be re-activated to `prospect`. `alumni` is permanent.

**Reverse transitions are not allowed** except `lost` → `prospect` (re-activation). You cannot move backwards (e.g., `active` → `enrolled` or `enrolled` → `lead`).

---

## 2. File Structure

```
src/
├── lib/
│   ├── crm/
│   │   ├── index.ts                          # Barrel export
│   │   ├── types.ts                          # All CRM types + Zod schemas
│   │   ├── errors.ts                         # CRM-specific error classes
│   │   ├── constants.ts                      # Lifecycle stages, scoring weights, config
│   │   ├── contacts.service.ts               # Contact CRUD + search + list
│   │   ├── lifecycle.service.ts              # Stage transitions + validation
│   │   ├── lead-scoring.service.ts           # Lead scoring computation
│   │   ├── deduplication.service.ts          # Contact matching + merge logic
│   │   ├── interactions.service.ts           # Timeline aggregation
│   │   ├── convert.service.ts               # Prospect → enrolled student flow (+ parent-as-contact)
│   │   ├── auto-create.service.ts           # Auto-create from channels (SMS, voice, chat, booking)
│   │   ├── referral.service.ts              # Referral code generation + tracking + attribution
│   │   ├── export.service.ts                # CSV export with configurable columns
│   │   └── events.ts                         # Event emission for CRM lifecycle
│   └── events/
│       ├── index.ts                          # EventBus singleton (shared with SPEC-03)
│       └── types.ts                          # AppEvent union type (shared)
├── app/
│   └── api/
│       └── v1/
│           └── contacts/
│               ├── route.ts                  # GET, POST /api/v1/contacts
│               ├── export/
│               │   └── route.ts             # GET /api/v1/contacts/export (CSV download)
│               └── [id]/
│                   ├── route.ts              # GET, PATCH /api/v1/contacts/:id
│                   ├── interactions/
│                   │   └── route.ts          # GET /api/v1/contacts/:id/interactions
│                   ├── convert/
│                   │   └── route.ts          # POST /api/v1/contacts/:id/convert
│                   └── referral/
│                       └── route.ts          # GET /api/v1/contacts/:id/referral
│       └── cron/
│           ├── recalculate-scores/
│           │   └── route.ts                  # Nightly lead score recalc (3am AEST)
│           ├── inactivity-reminders/
│           │   └── route.ts                  # 30/60/80 day nudges (4am AEST)
│           ├── lead-inactivity/
│           │   └── route.ts                  # Auto-lost at 90 days (5am AEST)
│           └── alumni-transition/
│               └── route.ts                  # Completed→alumni at 30 days (6am AEST)
└── __tests__/
    └── lib/
        └── crm/
            ├── contacts.service.test.ts
            ├── lifecycle.service.test.ts
            ├── lead-scoring.service.test.ts
            ├── deduplication.service.test.ts
            ├── interactions.service.test.ts
            ├── convert.service.test.ts       # Includes parent-as-contact tests
            ├── referral.service.test.ts
            ├── export.service.test.ts
            └── integration/
                ├── contact-lifecycle.test.ts  # Full prospect→alumni flow
                ├── deduplication.test.ts      # Merge scenarios
                ├── channel-auto-create.test.ts
                └── referral-flow.test.ts      # Referral code → new contact → attribution
```

---

## 3. Dependencies

```json
// No new dependencies beyond what's in SPEC-01/02/03.
// CRM uses the same stack:
{
  "drizzle-orm": "^0.34.x",       // ORM
  "@neondatabase/serverless": "*", // Neon driver
  "zod": "^3.22.x",               // Input validation
  "@clerk/nextjs": "^5.x",        // Auth context
  "libphonenumber-js": "^1.10.x"  // Phone number parsing/normalisation (new — install)
}
```

`libphonenumber-js` is needed for phone normalisation in deduplication. It's a lightweight subset of Google's libphonenumber, handles Australian numbers correctly, and runs in Edge/Node.

---

## 4. Types & Zod Schemas (`types.ts`)

```typescript
import { z } from 'zod';

// ─── Lifecycle Stages ────────────────────────────

export const LIFECYCLE_STAGES = [
  'prospect', 'lead', 'qualified', 'enrolled',
  'active', 'completed', 'alumni', 'lost',
] as const;

export type LifecycleStage = typeof LIFECYCLE_STAGES[number];

// ─── Source Channels ─────────────────────────────

export const CONTACT_SOURCES = [
  'website', 'phone', 'sms', 'referral',
  'google', 'facebook', 'instagram', 'walk_in',
  'voice_agent', 'web_chat', 'admin_manual',
] as const;

export type ContactSource = typeof CONTACT_SOURCES[number];

// ─── Input Schemas ───────────────────────────────

export const CreateContactSchema = z.object({
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().min(8).max(20).optional(), // Normalised in service layer
  instructor_id: z.string().uuid().optional(),
  lifecycle_stage: z.enum(LIFECYCLE_STAGES).optional().default('prospect'),
  source: z.enum(CONTACT_SOURCES).optional(),
  source_detail: z.string().max(500).optional(),
  utm_source: z.string().max(255).optional(),
  utm_medium: z.string().max(255).optional(),
  utm_campaign: z.string().max(255).optional(),
  notes: z.string().max(5000).optional(),
}).refine(
  (data) => data.phone || data.email,
  { message: 'At least one of phone or email is required' }
);

export type CreateContactInput = z.infer<typeof CreateContactSchema>;

export const UpdateContactSchema = z.object({
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().min(8).max(20).optional(),
  instructor_id: z.string().uuid().optional().nullable(),
  lifecycle_stage: z.enum(LIFECYCLE_STAGES).optional(),
  source: z.enum(CONTACT_SOURCES).optional(),
  source_detail: z.string().max(500).optional(),
  notes: z.string().max(5000).optional().nullable(),
});

export type UpdateContactInput = z.infer<typeof UpdateContactSchema>;

export const ListContactsSchema = z.object({
  lifecycle_stage: z.enum(LIFECYCLE_STAGES).optional(),
  source: z.enum(CONTACT_SOURCES).optional(),
  search: z.string().max(255).optional(),
  instructor_id: z.string().uuid().optional(),
  sort_by: z.enum(['created_at', 'updated_at', 'last_contact_at', 'lead_score', 'first_name'])
    .optional()
    .default('last_contact_at'),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export type ListContactsInput = z.infer<typeof ListContactsSchema>;

export const ConvertContactSchema = z.object({
  instructor_id: z.string().uuid(),
  transmission: z.enum(['auto', 'manual', 'both']).optional().default('auto'),
  referral_source: z.string().max(255).optional(),

  // Parent-as-contact flow: the enquiring contact is actually the parent,
  // not the student. Common scenario: parent fills in form on behalf of learner.
  contact_is_parent: z.boolean().optional().default(false),
  student_details: z.object({
    first_name: z.string().min(1).max(100),
    last_name: z.string().min(1).max(100),
    email: z.string().email().max(255).optional(),
    phone: z.string().min(8).max(20).optional(),
    date_of_birth: z.string().optional(),       // ISO date
    relationship: z.enum(['parent', 'guardian', 'supervisor', 'other']).optional().default('parent'),
  }).optional(),
}).refine(
  (data) => !data.contact_is_parent || data.student_details,
  { message: 'student_details required when contact_is_parent is true' }
);

export type ConvertContactInput = z.infer<typeof ConvertContactSchema>;

export const InteractionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(50),
  type: z.enum(['all', 'bookings', 'payments', 'messages', 'calls']).optional().default('all'),
});

export type InteractionsQueryInput = z.infer<typeof InteractionsQuerySchema>;

// ─── Response Types ──────────────────────────────

export interface ContactResponse {
  id: string;
  user_id: string | null;
  instructor_id: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string;              // Computed: first + last, or phone, or email
  email: string | null;
  phone: string | null;
  lifecycle_stage: LifecycleStage;
  lead_score: number;
  source: string | null;
  source_detail: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  first_contact_at: string;       // ISO 8601
  last_contact_at: string;        // ISO 8601
  total_interactions: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactListResponse {
  contacts: ContactResponse[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

export interface InteractionItem {
  id: string;
  type: 'booking' | 'payment' | 'message' | 'call';
  timestamp: string;              // ISO 8601
  summary: string;                // Human-readable one-liner
  details: Record<string, unknown>; // Type-specific data
}

export interface InteractionsResponse {
  contact_id: string;
  interactions: InteractionItem[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

export interface ConvertResponse {
  contact_id: string;              // Student's contact ID (new contact if parent flow)
  student_id: string;
  profile_id: string | null;       // NULL if no Clerk account yet
  previous_stage: LifecycleStage;
  new_stage: 'enrolled';
  // Present only when contact_is_parent = true:
  parent_contact_id?: string;      // Original enquiring contact (now the parent)
  parent_id?: string;              // Parent record ID
}
```

---

## 5. Constants (`constants.ts`)

```typescript
// ─── Lifecycle Transition Rules ──────────────────

export const VALID_TRANSITIONS: Record<string, string[]> = {
  prospect:  ['lead', 'lost'],
  lead:      ['qualified', 'lost'],
  qualified: ['enrolled', 'lost'],
  enrolled:  ['active'],
  active:    ['completed'],
  completed: ['alumni'],
  alumni:    [],                // Terminal
  lost:      ['prospect'],     // Re-activation only
};

/**
 * Transitions that require manual action (instructor or admin).
 * All others can be triggered by system events.
 */
export const MANUAL_TRANSITIONS = new Set([
  'prospect→lost',
  'lead→qualified',
  'lead→lost',
  'qualified→enrolled',  // Via convert endpoint
  'qualified→lost',
  'lost→prospect',
]);

/**
 * Transitions triggered automatically by system events.
 */
export const AUTO_TRANSITIONS = new Set([
  'prospect→lead',       // Interaction threshold met
  'enrolled→active',     // First lesson completed
  'active→completed',    // All 23 CBT&A tasks achieved
  'completed→alumni',    // 30 days post-completion (cron)
]);

// ─── Lead Scoring Weights ────────────────────────

export const SCORING_WEIGHTS = {
  // Channel interactions
  website_visit: 5,
  web_chat_started: 10,
  sms_inbound: 15,
  voice_call_inbound: 20,
  booking_started_not_completed: 25,
  booking_completed: 50,
  payment_made: 40,

  // Intent signals
  asked_about_pricing: 20,
  asked_about_availability: 15,
  asked_about_cbta: 10,
  referral_given: 30,
  contact_form_submitted: 30,

  // Recency decay
  decay_per_day: -1,             // Lose 1 point per day since last contact
  min_score: 0,
  max_score: 200,
} as const;

// ─── Auto-promote threshold ──────────────────────

export const PROSPECT_TO_LEAD_THRESHOLD = 2; // Interaction count to auto-promote
export const LEAD_INACTIVITY_DAYS = 90;      // Days before lead→lost auto-transition

// ─── Inactivity Reminder Schedule ────────────────
// Notifications sent to instructor before auto-transition to lost.
// Gives Rob a chance to follow up before the contact goes cold.
export const INACTIVITY_REMINDER_DAYS = [30, 60, 80] as const;
export const INACTIVITY_REMINDER_TEMPLATES = {
  30: 'LEAD_INACTIVE_30_DAYS',   // Gentle nudge: "Haven't heard from {name} in 30 days"
  60: 'LEAD_INACTIVE_60_DAYS',   // Stronger: "Contact {name} going cold — 60 days inactive"
  80: 'LEAD_INACTIVE_80_DAYS',   // Final warning: "{name} will move to Lost in 10 days"
} as const;

// ─── Phone normalisation ─────────────────────────

export const DEFAULT_COUNTRY_CODE = 'AU';
```

---

## 6. Error Classes (`errors.ts`)

```typescript
export class CRMError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number = 400,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CRMError';
  }
}

export class ContactNotFoundError extends CRMError {
  constructor(id: string) {
    super(`Contact not found: ${id}`, 'CONTACT_NOT_FOUND', 404);
  }
}

export class InvalidTransitionError extends CRMError {
  constructor(from: string, to: string) {
    super(
      `Invalid lifecycle transition: ${from} → ${to}`,
      'INVALID_LIFECYCLE_TRANSITION',
      422,
      { from, to }
    );
  }
}

export class DuplicateContactError extends CRMError {
  constructor(existingId: string, matchField: string) {
    super(
      `Duplicate contact found (matched by ${matchField})`,
      'DUPLICATE_CONTACT',
      409,
      { existing_contact_id: existingId, matched_by: matchField }
    );
  }
}

export class ConvertError extends CRMError {
  constructor(message: string) {
    super(message, 'CONVERT_ERROR', 422);
  }
}

export class ContactValidationError extends CRMError {
  constructor(details: Record<string, unknown>) {
    super('Validation failed', 'VALIDATION_ERROR', 400, details);
  }
}
```

---

## 7. Contact CRUD Service (`contacts.service.ts`)

```typescript
import { eq, and, or, ilike, isNull, sql, desc, asc } from 'drizzle-orm';
import { db } from '@/db';
import { contacts } from '@/db/schema';
import type { AuthContext } from '@/lib/auth/types';
import {
  CreateContactSchema, UpdateContactSchema, ListContactsSchema,
  type CreateContactInput, type UpdateContactInput, type ListContactsInput,
  type ContactResponse, type ContactListResponse,
} from './types';
import { ContactNotFoundError, ContactValidationError } from './errors';
import { normalisePhone } from './deduplication.service';
import { findDuplicate } from './deduplication.service';
import { computeLeadScore } from './lead-scoring.service';
import { eventBus } from '@/lib/events';

// ─── List Contacts ───────────────────────────────

export async function listContacts(
  params: ListContactsInput,
  auth: AuthContext
): Promise<ContactListResponse> {
  const validated = ListContactsSchema.parse(params);
  const { lifecycle_stage, source, search, instructor_id, sort_by, sort_order, page, per_page } = validated;

  // Build WHERE conditions
  const conditions = [isNull(contacts.deletedAt)];

  // RBAC: instructors see only their contacts
  if (auth.role === 'instructor') {
    conditions.push(eq(contacts.instructorId, auth.instructorId!));
  } else if (instructor_id) {
    conditions.push(eq(contacts.instructorId, instructor_id));
  }

  if (lifecycle_stage) {
    conditions.push(eq(contacts.lifecycleStage, lifecycle_stage));
  }

  if (source) {
    conditions.push(eq(contacts.source, source));
  }

  // Search: partial match across name, email, phone
  if (search) {
    const searchPattern = `%${search}%`;
    conditions.push(
      or(
        ilike(contacts.firstName, searchPattern),
        ilike(contacts.lastName, searchPattern),
        ilike(contacts.email, searchPattern),
        ilike(contacts.phone, searchPattern),
        // Full name search: concat first + last
        ilike(sql`CONCAT(${contacts.firstName}, ' ', ${contacts.lastName})`, searchPattern)
      )!
    );
  }

  const where = and(...conditions);

  // Count total
  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(contacts)
    .where(where);

  // Sort
  const sortColumn = {
    created_at: contacts.createdAt,
    updated_at: contacts.updatedAt,
    last_contact_at: contacts.lastContactAt,
    lead_score: contacts.leadScore,
    first_name: contacts.firstName,
  }[sort_by];

  const sortFn = sort_order === 'asc' ? asc : desc;

  // Query
  const offset = (page - 1) * per_page;
  const rows = await db
    .select()
    .from(contacts)
    .where(where)
    .orderBy(sortFn(sortColumn))
    .limit(per_page)
    .offset(offset);

  return {
    contacts: rows.map(mapToResponse),
    pagination: {
      page,
      per_page,
      total: count,
      total_pages: Math.ceil(count / per_page),
    },
  };
}

// ─── Get Contact ─────────────────────────────────

export async function getContact(
  contactId: string,
  auth: AuthContext
): Promise<ContactResponse> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(
      eq(contacts.id, contactId),
      isNull(contacts.deletedAt)
    ))
    .limit(1);

  if (!row) throw new ContactNotFoundError(contactId);

  enforceContactAccess(row, auth);

  return mapToResponse(row);
}

// ─── Create Contact ──────────────────────────────

export async function createContact(
  input: CreateContactInput,
  auth: AuthContext,
  options?: {
    skipDuplicateCheck?: boolean;
    autoCreated?: boolean;
    source?: string;
  }
): Promise<ContactResponse> {
  const validated = CreateContactSchema.parse(input);

  // Normalise phone
  const normalisedPhone = validated.phone
    ? normalisePhone(validated.phone)
    : undefined;

  // Check for duplicates (unless explicitly skipped, e.g. during merge)
  if (!options?.skipDuplicateCheck) {
    const duplicate = await findDuplicate(normalisedPhone, validated.email);
    if (duplicate) {
      // Return the existing contact after updating last_contact_at
      await touchContact(duplicate.id);
      const existing = await getContact(duplicate.id, auth);
      return existing;
    }
  }

  // Default instructor for solo operator
  const instructorId = validated.instructor_id ?? auth.instructorId ?? null;

  const [created] = await db
    .insert(contacts)
    .values({
      firstName: validated.first_name ?? null,
      lastName: validated.last_name ?? null,
      email: validated.email ?? null,
      phone: normalisedPhone ?? null,
      instructorId: instructorId,
      lifecycleStage: validated.lifecycle_stage ?? 'prospect',
      source: validated.source ?? options?.source ?? null,
      sourceDetail: validated.source_detail ?? null,
      utmSource: validated.utm_source ?? null,
      utmMedium: validated.utm_medium ?? null,
      utmCampaign: validated.utm_campaign ?? null,
      notes: validated.notes ?? null,
      leadScore: 0,
    })
    .returning();

  const response = mapToResponse(created);

  // Emit event
  eventBus.emit({
    type: 'CONTACT_CREATED',
    data: {
      id: created.id,
      phone: created.phone,
      email: created.email,
      source: created.source,
      lifecycle_stage: created.lifecycleStage,
    },
  });

  return response;
}

// ─── Update Contact ──────────────────────────────

export async function updateContact(
  contactId: string,
  input: UpdateContactInput,
  auth: AuthContext
): Promise<ContactResponse> {
  const validated = UpdateContactSchema.parse(input);

  // Verify exists + access
  const existing = await getContact(contactId, auth);

  // If lifecycle_stage is being changed, validate transition
  if (validated.lifecycle_stage && validated.lifecycle_stage !== existing.lifecycle_stage) {
    // Lifecycle transition is handled by lifecycle.service — reject here
    throw new ContactValidationError({
      lifecycle_stage: 'Use lifecycle transition endpoint or service method to change stages. Direct PATCH of lifecycle_stage is not allowed.',
    });
  }

  // Normalise phone if provided
  const normalisedPhone = validated.phone
    ? normalisePhone(validated.phone)
    : undefined;

  // Check for duplicate on new phone/email
  if (normalisedPhone || validated.email) {
    const duplicate = await findDuplicate(
      normalisedPhone ?? existing.phone ?? undefined,
      validated.email ?? existing.email ?? undefined,
      contactId // Exclude self
    );
    if (duplicate) {
      throw new CRMError(
        `Another contact already exists with this ${duplicate.matchedBy}`,
        'DUPLICATE_ON_UPDATE',
        409,
        { existing_contact_id: duplicate.id, matched_by: duplicate.matchedBy }
      );
    }
  }

  // Build update set (only provided fields)
  const updateSet: Record<string, unknown> = { updatedAt: new Date() };
  if (validated.first_name !== undefined) updateSet.firstName = validated.first_name;
  if (validated.last_name !== undefined) updateSet.lastName = validated.last_name;
  if (validated.email !== undefined) updateSet.email = validated.email;
  if (normalisedPhone !== undefined) updateSet.phone = normalisedPhone;
  if (validated.instructor_id !== undefined) updateSet.instructorId = validated.instructor_id;
  if (validated.source !== undefined) updateSet.source = validated.source;
  if (validated.source_detail !== undefined) updateSet.sourceDetail = validated.source_detail;
  if (validated.notes !== undefined) updateSet.notes = validated.notes;

  const [updated] = await db
    .update(contacts)
    .set(updateSet)
    .where(eq(contacts.id, contactId))
    .returning();

  return mapToResponse(updated);
}

// ─── Soft Delete ─────────────────────────────────

export async function deleteContact(
  contactId: string,
  auth: AuthContext
): Promise<void> {
  // Admin only
  if (auth.role !== 'admin') {
    throw new CRMError('Only admin can delete contacts', 'FORBIDDEN', 403);
  }

  const [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
    .limit(1);

  if (!row) throw new ContactNotFoundError(contactId);

  await db
    .update(contacts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

// ─── Touch (update last contact + increment interactions) ──

export async function touchContact(contactId: string): Promise<void> {
  await db
    .update(contacts)
    .set({
      lastContactAt: new Date(),
      totalInteractions: sql`${contacts.totalInteractions} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

// ─── Helper: Map DB Row to Response ──────────────

function mapToResponse(row: typeof contacts.$inferSelect): ContactResponse {
  const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ')
    || row.phone
    || row.email
    || 'Unknown';

  return {
    id: row.id,
    user_id: row.userId,
    instructor_id: row.instructorId,
    first_name: row.firstName,
    last_name: row.lastName,
    full_name: fullName,
    email: row.email,
    phone: row.phone,
    lifecycle_stage: row.lifecycleStage as LifecycleStage,
    lead_score: row.leadScore ?? 0,
    source: row.source,
    source_detail: row.sourceDetail,
    utm_source: row.utmSource,
    utm_medium: row.utmMedium,
    utm_campaign: row.utmCampaign,
    first_contact_at: row.firstContactAt.toISOString(),
    last_contact_at: row.lastContactAt.toISOString(),
    total_interactions: row.totalInteractions,
    notes: row.notes,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ─── Helper: RBAC ────────────────────────────────

function enforceContactAccess(
  contact: { instructorId: string | null },
  auth: AuthContext
): void {
  if (auth.role === 'admin') return;

  if (auth.role === 'instructor') {
    if (contact.instructorId !== auth.instructorId) {
      throw new CRMError('You can only access your own contacts', 'FORBIDDEN', 403);
    }
    return;
  }

  // Students and parents should never reach CRM endpoints (middleware blocks them),
  // but defence in depth:
  throw new CRMError('Access denied', 'FORBIDDEN', 403);
}
```

---

## 8. Lifecycle Service (`lifecycle.service.ts`)

```typescript
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { contacts } from '@/db/schema';
import type { AuthContext } from '@/lib/auth/types';
import type { LifecycleStage, ContactResponse } from './types';
import { VALID_TRANSITIONS, MANUAL_TRANSITIONS, AUTO_TRANSITIONS } from './constants';
import { InvalidTransitionError, ContactNotFoundError, CRMError } from './errors';
import { touchContact } from './contacts.service';
import { eventBus } from '@/lib/events';

/**
 * Transition a contact to a new lifecycle stage.
 *
 * @param contactId - The contact to transition
 * @param newStage - Target lifecycle stage
 * @param auth - Auth context (determines if manual transition is allowed)
 * @param options - Additional context for the transition
 */
export async function transitionLifecycle(
  contactId: string,
  newStage: LifecycleStage,
  auth: AuthContext,
  options?: {
    reason?: string;
    triggeredBy?: 'system' | 'manual';
  }
): Promise<{ previous_stage: LifecycleStage; new_stage: LifecycleStage }> {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) throw new ContactNotFoundError(contactId);

  const currentStage = contact.lifecycleStage as LifecycleStage;

  // Validate transition
  const validTargets = VALID_TRANSITIONS[currentStage];
  if (!validTargets || !validTargets.includes(newStage)) {
    throw new InvalidTransitionError(currentStage, newStage);
  }

  // Check if this is a manual-only transition and caller is system
  const transitionKey = `${currentStage}→${newStage}`;
  const isManual = MANUAL_TRANSITIONS.has(transitionKey);
  const triggeredBy = options?.triggeredBy ?? 'manual';

  if (isManual && triggeredBy === 'system') {
    throw new CRMError(
      `Transition ${transitionKey} requires manual action by instructor or admin`,
      'MANUAL_TRANSITION_REQUIRED',
      422
    );
  }

  // For manual transitions, verify role
  if (isManual && auth.role !== 'admin' && auth.role !== 'instructor') {
    throw new CRMError('Only instructors or admins can perform manual lifecycle transitions', 'FORBIDDEN', 403);
  }

  // Perform transition
  await db
    .update(contacts)
    .set({
      lifecycleStage: newStage,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));

  // Log lifecycle change to audit
  eventBus.emit({
    type: 'CONTACT_LIFECYCLE_CHANGED' as any, // Add to AppEvent union
    data: {
      contact_id: contactId,
      previous_stage: currentStage,
      new_stage: newStage,
      reason: options?.reason,
      triggered_by: triggeredBy,
      actor_id: auth.userId,
    },
  });

  return {
    previous_stage: currentStage,
    new_stage: newStage,
  };
}

/**
 * Auto-promote prospect → lead if interaction threshold met.
 * Called after each touchContact().
 */
export async function checkAutoPromotion(contactId: string, auth: AuthContext): Promise<void> {
  const [contact] = await db
    .select({
      lifecycleStage: contacts.lifecycleStage,
      totalInteractions: contacts.totalInteractions,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) return;

  if (
    contact.lifecycleStage === 'prospect' &&
    contact.totalInteractions >= 2 // PROSPECT_TO_LEAD_THRESHOLD
  ) {
    await transitionLifecycle(contactId, 'lead', auth, {
      triggeredBy: 'system',
      reason: `Auto-promoted: ${contact.totalInteractions} interactions`,
    });
  }
}

/**
 * Auto-transition enrolled → active when first lesson is completed.
 * Called by LESSON_COMPLETED event handler.
 */
export async function onFirstLessonCompleted(
  studentId: string,
  auth: AuthContext
): Promise<void> {
  // Find the contact linked to this student
  const [contact] = await db
    .select({ id: contacts.id, lifecycleStage: contacts.lifecycleStage })
    .from(contacts)
    .innerJoin(students, eq(students.userId, contacts.userId))
    .where(eq(students.id, studentId))
    .limit(1);

  if (!contact || contact.lifecycleStage !== 'enrolled') return;

  await transitionLifecycle(contact.id, 'active', auth, {
    triggeredBy: 'system',
    reason: 'First lesson completed',
  });
}
```

---

## 9. Lead Scoring Service (`lead-scoring.service.ts`)

```typescript
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { contacts, bookings, payments, conversations, callLogs } from '@/db/schema';
import { SCORING_WEIGHTS } from './constants';

/**
 * Recompute lead score for a contact based on all interactions.
 *
 * Score = sum(interaction weights) + intent_signals - recency_decay
 * Clamped to [0, 200].
 *
 * Called:
 * - After each new interaction (booking, call, message, payment)
 * - On a nightly cron for recency decay recalculation
 */
export async function computeLeadScore(contactId: string): Promise<number> {
  let score = 0;

  // 1. Count bookings
  const [bookingStats] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      completed: sql<number>`COUNT(*) FILTER (WHERE status = 'completed')::int`,
      cancelled: sql<number>`COUNT(*) FILTER (WHERE status = 'cancelled')::int`,
    })
    .from(bookings)
    .where(eq(bookings.contactId, contactId));

  score += (bookingStats.completed ?? 0) * SCORING_WEIGHTS.booking_completed;
  // Incomplete bookings (pending/confirmed) still show intent
  const incompleteBookings = (bookingStats.total ?? 0) - (bookingStats.completed ?? 0) - (bookingStats.cancelled ?? 0);
  score += incompleteBookings * SCORING_WEIGHTS.booking_started_not_completed;

  // 2. Count payments
  const [paymentStats] = await db
    .select({
      total: sql<number>`COUNT(*) FILTER (WHERE status = 'completed')::int`,
    })
    .from(payments)
    .where(eq(payments.contactId, contactId));

  score += (paymentStats.total ?? 0) * SCORING_WEIGHTS.payment_made;

  // 3. Count conversations
  const [convStats] = await db
    .select({
      sms: sql<number>`COUNT(*) FILTER (WHERE channel = 'sms')::int`,
      web_chat: sql<number>`COUNT(*) FILTER (WHERE channel = 'web_chat')::int`,
    })
    .from(conversations)
    .where(eq(conversations.contactId, contactId));

  score += (convStats.sms ?? 0) * SCORING_WEIGHTS.sms_inbound;
  score += (convStats.web_chat ?? 0) * SCORING_WEIGHTS.web_chat_started;

  // 4. Count calls
  const [callStats] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
    })
    .from(callLogs)
    .where(eq(callLogs.contactId, contactId));

  score += (callStats.total ?? 0) * SCORING_WEIGHTS.voice_call_inbound;

  // 5. Recency decay
  const [contact] = await db
    .select({ lastContactAt: contacts.lastContactAt })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (contact) {
    const daysSinceLastContact = Math.floor(
      (Date.now() - contact.lastContactAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    score += daysSinceLastContact * SCORING_WEIGHTS.decay_per_day;
  }

  // 6. Clamp
  score = Math.max(SCORING_WEIGHTS.min_score, Math.min(SCORING_WEIGHTS.max_score, score));

  // 7. Persist
  await db
    .update(contacts)
    .set({ leadScore: score, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));

  return score;
}

/**
 * Bulk recalculate lead scores for all active (non-terminal) contacts.
 * Called by nightly cron job.
 */
export async function recalculateAllScores(): Promise<{ updated: number }> {
  const activeContacts = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      sql`${contacts.lifecycleStage} NOT IN ('alumni', 'completed')
          AND ${contacts.deletedAt} IS NULL`
    );

  let updated = 0;
  for (const contact of activeContacts) {
    await computeLeadScore(contact.id);
    updated++;
  }

  return { updated };
}
```

---

## 10. Deduplication Service (`deduplication.service.ts`)

```typescript
import { eq, or, and, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { contacts } from '@/db/schema';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { DEFAULT_COUNTRY_CODE } from './constants';

/**
 * Normalise an Australian phone number to E.164 format.
 * Examples:
 *   '0412 345 678' → '+61412345678'
 *   '+61412345678' → '+61412345678'
 *   '0412345678'   → '+61412345678'
 *   '02 6123 4567' → '+61261234567'
 */
export function normalisePhone(phone: string): string {
  const parsed = parsePhoneNumberFromString(phone, DEFAULT_COUNTRY_CODE);

  if (!parsed || !parsed.isValid()) {
    // If it doesn't parse, store as-is but stripped of non-digits (except leading +)
    return phone.replace(/[^\d+]/g, '');
  }

  return parsed.format('E.164'); // e.g., '+61412345678'
}

/**
 * Find an existing contact by phone OR email.
 *
 * Match priority:
 * 1. Exact phone match (normalised E.164)
 * 2. Exact email match (case-insensitive)
 *
 * @param phone - Normalised phone number (E.164)
 * @param email - Email address
 * @param excludeId - Contact ID to exclude (for update duplicate check)
 * @returns The matching contact or null
 */
export async function findDuplicate(
  phone?: string,
  email?: string,
  excludeId?: string
): Promise<{ id: string; matchedBy: 'phone' | 'email' } | null> {
  if (!phone && !email) return null;

  const conditions = [];

  if (phone) {
    conditions.push(eq(contacts.phone, phone));
  }

  if (email) {
    // Case-insensitive email match
    conditions.push(eq(contacts.email, email.toLowerCase()));
  }

  const matchCondition = conditions.length === 1 ? conditions[0] : or(...conditions);

  const whereConditions = [matchCondition!, isNull(contacts.deletedAt)];
  if (excludeId) {
    whereConditions.push(sql`${contacts.id} != ${excludeId}`);
  }

  const [existing] = await db
    .select({ id: contacts.id, phone: contacts.phone, email: contacts.email })
    .from(contacts)
    .where(and(...whereConditions))
    .limit(1);

  if (!existing) return null;

  // Determine which field matched
  const matchedBy = phone && existing.phone === phone ? 'phone' : 'email';

  return { id: existing.id, matchedBy };
}

/**
 * Merge two contact records. Keeps the "primary" and soft-deletes the "secondary".
 *
 * Merge strategy:
 * - Primary keeps its values for all non-null fields
 * - Secondary's non-null fields fill in primary's null fields
 * - Interaction counts are summed
 * - First contact date is the earlier of the two
 * - Last contact date is the later of the two
 * - UTM data from primary takes precedence (first-touch attribution)
 * - Secondary is soft-deleted
 * - Related records (bookings, conversations, calls) are re-linked to primary
 *
 * This is an admin-only operation.
 */
export async function mergeContacts(
  primaryId: string,
  secondaryId: string
): Promise<void> {
  const [primary] = await db.select().from(contacts).where(eq(contacts.id, primaryId)).limit(1);
  const [secondary] = await db.select().from(contacts).where(eq(contacts.id, secondaryId)).limit(1);

  if (!primary || !secondary) {
    throw new Error('Both contacts must exist to merge');
  }

  // Build merged values: primary wins for non-null, secondary fills gaps
  const merged: Record<string, unknown> = {
    firstName: primary.firstName ?? secondary.firstName,
    lastName: primary.lastName ?? secondary.lastName,
    email: primary.email ?? secondary.email,
    phone: primary.phone ?? secondary.phone,
    userId: primary.userId ?? secondary.userId,
    instructorId: primary.instructorId ?? secondary.instructorId,
    source: primary.source ?? secondary.source,
    sourceDetail: primary.sourceDetail ?? secondary.sourceDetail,
    utmSource: primary.utmSource ?? secondary.utmSource,       // First-touch wins
    utmMedium: primary.utmMedium ?? secondary.utmMedium,
    utmCampaign: primary.utmCampaign ?? secondary.utmCampaign,
    notes: [primary.notes, secondary.notes].filter(Boolean).join('\n---\n') || null,
    totalInteractions: primary.totalInteractions + secondary.totalInteractions,
    firstContactAt: primary.firstContactAt < secondary.firstContactAt
      ? primary.firstContactAt
      : secondary.firstContactAt,
    lastContactAt: primary.lastContactAt > secondary.lastContactAt
      ? primary.lastContactAt
      : secondary.lastContactAt,
    // Keep the more advanced lifecycle stage
    lifecycleStage: compareStages(primary.lifecycleStage, secondary.lifecycleStage),
    updatedAt: new Date(),
  };

  await db.transaction(async (tx) => {
    // 1. Update primary
    await tx.update(contacts).set(merged).where(eq(contacts.id, primaryId));

    // 2. Re-link secondary's related records to primary
    await tx.execute(sql`UPDATE bookings SET contact_id = ${primaryId} WHERE contact_id = ${secondaryId}`);
    await tx.execute(sql`UPDATE conversations SET contact_id = ${primaryId} WHERE contact_id = ${secondaryId}`);
    await tx.execute(sql`UPDATE call_logs SET contact_id = ${primaryId} WHERE contact_id = ${secondaryId}`);
    await tx.execute(sql`UPDATE payments SET contact_id = ${primaryId} WHERE contact_id = ${secondaryId}`);
    await tx.execute(sql`UPDATE waitlist SET contact_id = ${primaryId} WHERE contact_id = ${secondaryId}`);

    // 3. Soft-delete secondary
    await tx.update(contacts).set({
      deletedAt: new Date(),
      updatedAt: new Date(),
      notes: `[MERGED into ${primaryId}] ${secondary.notes ?? ''}`,
    }).where(eq(contacts.id, secondaryId));
  });
}

/**
 * Compare two lifecycle stages, return the more advanced one.
 */
function compareStages(a: string, b: string): string {
  const order = ['prospect', 'lead', 'qualified', 'enrolled', 'active', 'completed', 'alumni', 'lost'];
  // "lost" is special — always prefer the non-lost stage
  if (a === 'lost' && b !== 'lost') return b;
  if (b === 'lost' && a !== 'lost') return a;
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}
```

---

## 11. Interactions Service (`interactions.service.ts`)

```typescript
import { eq, sql, desc } from 'drizzle-orm';
import { db } from '@/db';
import { bookings, payments, messages, conversations, callLogs, contacts, services } from '@/db/schema';
import type { AuthContext } from '@/lib/auth/types';
import type { InteractionsQueryInput, InteractionsResponse, InteractionItem } from './types';
import { InteractionsQuerySchema } from './types';
import { ContactNotFoundError } from './errors';

/**
 * Aggregate all interactions for a contact into a unified chronological timeline.
 *
 * Sources:
 * 1. Bookings (contact_id)
 * 2. Payments (contact_id)
 * 3. Messages (via conversations.contact_id)
 * 4. Call logs (contact_id)
 *
 * Returns a merged, paginated timeline sorted by timestamp descending.
 */
export async function getInteractions(
  contactId: string,
  params: InteractionsQueryInput,
  auth: AuthContext
): Promise<InteractionsResponse> {
  const validated = InteractionsQuerySchema.parse(params);
  const { page, per_page, type } = validated;

  // Verify contact exists and caller has access
  const [contact] = await db
    .select({ id: contacts.id, instructorId: contacts.instructorId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) throw new ContactNotFoundError(contactId);

  // RBAC check
  if (auth.role === 'instructor' && contact.instructorId !== auth.instructorId) {
    throw new Error('Access denied');
  }

  // Gather interactions from each source
  const allInteractions: InteractionItem[] = [];

  if (type === 'all' || type === 'bookings') {
    const bookingRows = await db
      .select({
        id: bookings.id,
        startTime: bookings.startTime,
        status: bookings.status,
        serviceName: services.name,
        durationMinutes: bookings.durationMinutes,
        amountCents: bookings.amountCents,
        bookedVia: bookings.bookedVia,
      })
      .from(bookings)
      .leftJoin(services, eq(bookings.serviceId, services.id))
      .where(eq(bookings.contactId, contactId))
      .orderBy(desc(bookings.startTime));

    for (const b of bookingRows) {
      allInteractions.push({
        id: b.id,
        type: 'booking',
        timestamp: b.startTime.toISOString(),
        summary: `${b.serviceName ?? 'Lesson'} — ${b.status} (${b.durationMinutes}min, via ${b.bookedVia})`,
        details: {
          status: b.status,
          service: b.serviceName,
          duration_minutes: b.durationMinutes,
          amount_cents: b.amountCents,
          booked_via: b.bookedVia,
        },
      });
    }
  }

  if (type === 'all' || type === 'payments') {
    const paymentRows = await db
      .select({
        id: payments.id,
        createdAt: payments.createdAt,
        amountCents: payments.amountCents,
        status: payments.status,
        paymentMethod: payments.paymentMethod,
        description: payments.description,
      })
      .from(payments)
      .where(eq(payments.contactId, contactId))
      .orderBy(desc(payments.createdAt));

    for (const p of paymentRows) {
      const dollars = (p.amountCents / 100).toFixed(2);
      allInteractions.push({
        id: p.id,
        type: 'payment',
        timestamp: p.createdAt.toISOString(),
        summary: `$${dollars} AUD — ${p.status} (${p.paymentMethod})`,
        details: {
          amount_cents: p.amountCents,
          status: p.status,
          payment_method: p.paymentMethod,
          description: p.description,
        },
      });
    }
  }

  if (type === 'all' || type === 'messages') {
    // Get messages via conversations linked to this contact
    const messageRows = await db
      .select({
        id: messages.id,
        createdAt: messages.createdAt,
        direction: messages.direction,
        senderType: messages.senderType,
        content: messages.content,
        channel: conversations.channel,
        intentDetected: messages.intentDetected,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(eq(conversations.contactId, contactId))
      .orderBy(desc(messages.createdAt));

    for (const m of messageRows) {
      const preview = m.content.length > 100
        ? m.content.substring(0, 100) + '…'
        : m.content;
      allInteractions.push({
        id: m.id,
        type: 'message',
        timestamp: m.createdAt.toISOString(),
        summary: `${m.channel.toUpperCase()} ${m.direction} (${m.senderType}): ${preview}`,
        details: {
          channel: m.channel,
          direction: m.direction,
          sender_type: m.senderType,
          content: m.content,
          intent_detected: m.intentDetected,
        },
      });
    }
  }

  if (type === 'all' || type === 'calls') {
    const callRows = await db
      .select({
        id: callLogs.id,
        startedAt: callLogs.startedAt,
        durationSeconds: callLogs.durationSeconds,
        outcome: callLogs.outcome,
        resolution: callLogs.resolution,
        summary: callLogs.summary,
        callDirection: callLogs.callDirection,
      })
      .from(callLogs)
      .where(eq(callLogs.contactId, contactId))
      .orderBy(desc(callLogs.startedAt));

    for (const c of callRows) {
      const mins = c.durationSeconds ? Math.ceil(c.durationSeconds / 60) : 0;
      allInteractions.push({
        id: c.id,
        type: 'call',
        timestamp: c.startedAt.toISOString(),
        summary: `${c.callDirection} call — ${c.outcome} (${mins}min)${c.resolution ? `, ${c.resolution}` : ''}`,
        details: {
          direction: c.callDirection,
          duration_seconds: c.durationSeconds,
          outcome: c.outcome,
          resolution: c.resolution,
          ai_summary: c.summary,
        },
      });
    }
  }

  // Sort all interactions by timestamp descending
  allInteractions.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // Paginate
  const total = allInteractions.length;
  const offset = (page - 1) * per_page;
  const paginated = allInteractions.slice(offset, offset + per_page);

  return {
    contact_id: contactId,
    interactions: paginated,
    pagination: {
      page,
      per_page,
      total,
      total_pages: Math.ceil(total / per_page),
    },
  };
}
```

---

## 12. Convert Service (`convert.service.ts`)

```typescript
import { eq, and, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { contacts, students, parents, parentStudentLinks, profiles } from '@/db/schema';
import type { AuthContext } from '@/lib/auth/types';
import type { ConvertContactInput, ConvertResponse } from './types';
import { ConvertContactSchema } from './types';
import { ContactNotFoundError, ConvertError } from './errors';
import { transitionLifecycle } from './lifecycle.service';
import { normalisePhone } from './deduplication.service';
import { eventBus } from '@/lib/events';

/**
 * Convert a prospect/lead/qualified contact into an enrolled student.
 *
 * This is the key transition that turns a CRM contact into a student
 * who can book lessons and be tracked in the CBT&A system.
 *
 * Two modes:
 *
 * A) Standard: contact IS the student (contact_is_parent = false)
 *    → Creates student record from contact details
 *
 * B) Parent-as-contact: the enquiring contact is the parent (contact_is_parent = true)
 *    → Reclassifies existing contact as the parent
 *    → Creates a NEW contact + student record for the actual learner
 *    → Links parent → student via parent_student_links
 *
 *    Common scenario: Mum fills in enquiry form with her own name/phone.
 *    Rob arrives at the lesson and realises the student is the 17-year-old kid.
 *
 * Steps:
 * 1. Validate contact exists and is in a convertible stage
 * 2. Check if student record already exists (idempotent)
 * 3. Standard: create student from contact
 *    OR Parent flow: create student contact + student record + parent record + link
 * 4. Link to Clerk user if exists
 * 5. Transition lifecycle to 'enrolled'
 * 6. Emit events
 */
export async function convertToStudent(
  contactId: string,
  input: ConvertContactInput,
  auth: AuthContext
): Promise<ConvertResponse> {
  const validated = ConvertContactSchema.parse(input);

  // 1. Get contact
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(
      eq(contacts.id, contactId),
      isNull(contacts.deletedAt)
    ))
    .limit(1);

  if (!contact) throw new ContactNotFoundError(contactId);

  // 2. Validate stage — must be 'qualified' for conversion
  //    (Admins can convert from lead or prospect as an override)
  const convertibleStages = auth.role === 'admin'
    ? ['prospect', 'lead', 'qualified']
    : ['qualified'];

  if (!convertibleStages.includes(contact.lifecycleStage)) {
    throw new ConvertError(
      `Contact must be in ${convertibleStages.join('/')} stage to convert. ` +
      `Current stage: ${contact.lifecycleStage}`
    );
  }

  // 3. Check if student already exists for this contact
  const existingStudent = contact.userId
    ? await db
        .select({ id: students.id })
        .from(students)
        .where(eq(students.userId, contact.userId))
        .limit(1)
    : [];

  if (existingStudent.length > 0) {
    throw new ConvertError(
      `Student record already exists (ID: ${existingStudent[0].id}). ` +
      `This contact may have been converted previously.`
    );
  }

  const previousStage = contact.lifecycleStage as any;

  // ─── Branch: Parent-as-contact flow ───────────────
  if (validated.contact_is_parent && validated.student_details) {
    return await convertWithParent(contactId, contact, validated, auth, previousStage);
  }

  // ─── Branch: Standard flow (contact IS the student) ───
  return await convertStandard(contactId, contact, validated, auth, previousStage);
}

/**
 * Standard conversion: the contact is the student.
 */
async function convertStandard(
  contactId: string,
  contact: any,
  validated: any,
  auth: AuthContext,
  previousStage: string
): Promise<ConvertResponse> {
  // Create student record
  const [newStudent] = await db
    .insert(students)
    .values({
      userId: contact.userId,           // May be NULL if no Clerk account yet
      instructorId: validated.instructor_id,
      firstName: contact.firstName ?? '',
      lastName: contact.lastName ?? '',
      email: contact.email,
      phone: contact.phone,
      transmission: validated.transmission,
      referralSource: validated.referral_source,
      status: 'active',
    })
    .returning();

  // If Clerk account exists, update profile role to 'student'
  let profileId: string | null = null;
  if (contact.userId) {
    profileId = await maybeUpdateProfileRole(contact.userId, 'student');
  }

  // Update contact's instructor_id if not already set
  if (!contact.instructorId) {
    await db
      .update(contacts)
      .set({ instructorId: validated.instructor_id, updatedAt: new Date() })
      .where(eq(contacts.id, contactId));
  }

  // Transition lifecycle: current → enrolled
  await db
    .update(contacts)
    .set({ lifecycleStage: 'enrolled', updatedAt: new Date() })
    .where(eq(contacts.id, contactId));

  // Emit events
  emitConvertEvents(contactId, newStudent.id, validated.instructor_id, previousStage, auth);

  return {
    contact_id: contactId,
    student_id: newStudent.id,
    profile_id: profileId,
    previous_stage: previousStage,
    new_stage: 'enrolled',
  };
}

/**
 * Parent-as-contact conversion:
 * 
 * Scenario: Parent enquired on behalf of learner. Contact record has the
 * parent's details. We need to:
 * 
 * 1. Create a NEW contact for the actual student (with student_details)
 * 2. Create a student record linked to the new student contact
 * 3. Create a parent record linked to the original contact
 * 4. Link parent → student via parent_student_links
 * 5. Original contact gets lifecycle stage 'enrolled' (they're the enquirer)
 * 6. New student contact also gets 'enrolled'
 */
async function convertWithParent(
  parentContactId: string,
  parentContact: any,
  validated: any,
  auth: AuthContext,
  previousStage: string
): Promise<ConvertResponse> {
  const sd = validated.student_details!;

  // 1. Create a new contact for the actual student
  const normalisedPhone = sd.phone ? normalisePhone(sd.phone) : null;
  
  const [studentContact] = await db
    .insert(contacts)
    .values({
      firstName: sd.first_name,
      lastName: sd.last_name,
      email: sd.email ?? null,
      phone: normalisedPhone,
      source: parentContact.source,           // Inherit from parent enquiry
      sourceDetail: `Via parent: ${parentContact.firstName ?? ''} ${parentContact.lastName ?? ''}`.trim(),
      instructorId: validated.instructor_id,
      lifecycleStage: 'enrolled',
      interactionCount: 0,
      leadScore: 0,
    })
    .returning();

  // 2. Create student record from the student contact
  const [newStudent] = await db
    .insert(students)
    .values({
      userId: null,                            // Student likely has no Clerk account yet
      instructorId: validated.instructor_id,
      firstName: sd.first_name,
      lastName: sd.last_name,
      email: sd.email ?? null,
      phone: normalisedPhone,
      transmission: validated.transmission,
      referralSource: validated.referral_source,
      status: 'active',
    })
    .returning();

  // 3. Create parent record linked to the original contact
  const [newParent] = await db
    .insert(parents)
    .values({
      userId: parentContact.userId,            // May have Clerk account
      firstName: parentContact.firstName ?? '',
      lastName: parentContact.lastName ?? '',
      email: parentContact.email,
      phone: parentContact.phone,
    })
    .returning();

  // 4. Link parent → student
  await db
    .insert(parentStudentLinks)
    .values({
      parentId: newParent.id,
      studentId: newStudent.id,
      relationship: sd.relationship ?? 'parent',
    });

  // 5. Update parent profile role if Clerk account exists
  let profileId: string | null = null;
  if (parentContact.userId) {
    profileId = await maybeUpdateProfileRole(parentContact.userId, 'parent');
  }

  // 6. Update original contact: set instructor, transition to enrolled
  await db
    .update(contacts)
    .set({
      instructorId: validated.instructor_id,
      lifecycleStage: 'enrolled',
      updatedAt: new Date(),
      notes: sql`COALESCE(${contacts.notes}, '') || ${
        `\n[System] Converted as parent. Student: ${sd.first_name} ${sd.last_name} (contact: ${studentContact.id})`
      }`,
    })
    .where(eq(contacts.id, parentContactId));

  // Emit events
  emitConvertEvents(studentContact.id, newStudent.id, validated.instructor_id, previousStage, auth);

  eventBus.emit({
    type: 'PARENT_LINKED' as any,
    data: {
      parent_id: newParent.id,
      student_id: newStudent.id,
      parent_contact_id: parentContactId,
      student_contact_id: studentContact.id,
      relationship: sd.relationship ?? 'parent',
    },
  });

  return {
    contact_id: studentContact.id,                // The student's new contact ID
    student_id: newStudent.id,
    profile_id: profileId,
    previous_stage: previousStage,
    new_stage: 'enrolled',
    parent_contact_id: parentContactId,            // Original contact — now the parent
    parent_id: newParent.id,
  };
}

// ─── Helpers ──────────────────────────────────────

async function maybeUpdateProfileRole(
  clerkUserId: string,
  role: 'student' | 'parent'
): Promise<string | null> {
  const [existingProfile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.clerkUserId, clerkUserId))
    .limit(1);

  if (!existingProfile) return null;

  // Don't downgrade instructor or admin roles
  await db
    .update(profiles)
    .set({ role, updatedAt: new Date() })
    .where(and(
      eq(profiles.id, existingProfile.id),
      sql`${profiles.role} NOT IN ('instructor', 'admin')`
    ));

  return existingProfile.id;
}

function emitConvertEvents(
  contactId: string,
  studentId: string,
  instructorId: string,
  previousStage: string,
  auth: AuthContext
) {
  eventBus.emit({
    type: 'CONTACT_LIFECYCLE_CHANGED' as any,
    data: {
      contact_id: contactId,
      previous_stage: previousStage,
      new_stage: 'enrolled',
      reason: 'Converted to student',
      triggered_by: 'manual',
      actor_id: auth.userId,
    },
  });

  eventBus.emit({
    type: 'STUDENT_ENROLLED' as any,
    data: {
      student_id: studentId,
      contact_id: contactId,
      instructor_id: instructorId,
    },
  });
}
```

---

## 13. Auto-Create Service (`auto-create.service.ts`)

```typescript
import type { AuthContext } from '@/lib/auth/types';
import { createContact, touchContact } from './contacts.service';
import { findDuplicate, normalisePhone } from './deduplication.service';
import { computeLeadScore } from './lead-scoring.service';
import { checkAutoPromotion } from './lifecycle.service';
import type { ContactSource } from './types';

/**
 * Auto-create or update a contact from an inbound channel.
 *
 * Called by:
 * - Booking Engine (SPEC-03 upsertContact)
 * - Twilio webhook (SMS inbound)
 * - Vapi webhook (voice call inbound)
 * - Web chat widget (session start)
 *
 * Logic:
 * 1. Normalise phone if provided
 * 2. Check for existing contact by phone or email
 * 3. If exists: touch (update last_contact_at, increment interactions), recompute score
 * 4. If new: create contact with source tracking
 * 5. Check auto-promotion (prospect → lead)
 */
export async function upsertFromChannel(
  data: {
    phone?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    source: ContactSource;
    source_detail?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    instructor_id?: string;
  },
  auth: AuthContext
): Promise<{ contact_id: string; is_new: boolean }> {
  const normalisedPhone = data.phone ? normalisePhone(data.phone) : undefined;

  // Check for existing
  const existing = await findDuplicate(normalisedPhone, data.email);

  if (existing) {
    // Touch existing contact
    await touchContact(existing.id);
    await computeLeadScore(existing.id);
    await checkAutoPromotion(existing.id, auth);

    return { contact_id: existing.id, is_new: false };
  }

  // Create new
  const contact = await createContact(
    {
      phone: normalisedPhone,
      email: data.email,
      first_name: data.first_name,
      last_name: data.last_name,
      source: data.source,
      source_detail: data.source_detail,
      utm_source: data.utm_source,
      utm_medium: data.utm_medium,
      utm_campaign: data.utm_campaign,
      instructor_id: data.instructor_id,
    },
    auth,
    { skipDuplicateCheck: true, autoCreated: true }
  );

  return { contact_id: contact.id, is_new: true };
}

/**
 * Capture UTM parameters from a booking widget referrer.
 *
 * Called during the booking flow (SPEC-03) when booking originates from website.
 * UTM params are stored only on first contact — never overwritten.
 */
export function extractUTMFromUrl(url: string): {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
} {
  try {
    const parsed = new URL(url);
    return {
      utm_source: parsed.searchParams.get('utm_source') ?? undefined,
      utm_medium: parsed.searchParams.get('utm_medium') ?? undefined,
      utm_campaign: parsed.searchParams.get('utm_campaign') ?? undefined,
    };
  } catch {
    return {};
  }
}
```

---

## 14. Event Emission (`events.ts`)

The CRM module emits the following events. These extend the `AppEvent` union defined in SPEC-03's `src/lib/events/types.ts`.

```typescript
// Add to the existing AppEvent union in src/lib/events/types.ts

| { type: 'CONTACT_CREATED'; data: {
    id: string;
    phone: string | null;
    email: string | null;
    source: string | null;
    lifecycle_stage: string;
  }}
| { type: 'CONTACT_LIFECYCLE_CHANGED'; data: {
    contact_id: string;
    previous_stage: string;
    new_stage: string;
    reason?: string;
    triggered_by: 'system' | 'manual';
    actor_id?: string;
  }}
| { type: 'STUDENT_ENROLLED'; data: {
    student_id: string;
    contact_id: string;
    instructor_id: string;
  }}
```

**Event subscribers (downstream):**

| Event | Subscribers |
|-------|------------|
| `CONTACT_CREATED` | Notification Engine (welcome SMS/email for web leads), Auto-assign instructor (if solo), Admin Panel (new lead alert) |
| `CONTACT_LIFECYCLE_CHANGED` | Audit Trail (log transition), Notification Engine (lifecycle-specific emails), Analytics |
| `STUDENT_ENROLLED` | Notification Engine (welcome pack), CBT&A Engine (initialise competency matrix with 23 tasks at 'not_started'), Booking Engine (unlock student booking flow) |

---

## 15. API Route Handlers

### 15.1 `GET /api/v1/contacts` & `POST /api/v1/contacts`

```typescript
// src/app/api/v1/contacts/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { listContacts, createContact } from '@/lib/crm';
import { ListContactsSchema, CreateContactSchema } from '@/lib/crm/types';
import { CRMError } from '@/lib/crm/errors';
import { rateLimit } from '@/lib/rate-limit';

export async function GET(req: NextRequest) {
  try {
    await rateLimit(req, 'contacts:list', 100); // 100 req/min

    const auth = await getAuthContext(req);
    requireRole(auth, ['admin', 'instructor']);

    const params = Object.fromEntries(req.nextUrl.searchParams);
    const validated = ListContactsSchema.parse(params);

    const result = await listContacts(validated, auth);
    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    await rateLimit(req, 'contacts:create', 10); // 10 req/min (mutation)

    const auth = await getAuthContext(req);
    requireRole(auth, ['admin', 'instructor']);

    const body = await req.json();
    const validated = CreateContactSchema.parse(body);

    const result = await createContact(validated, auth);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

function handleError(error: unknown) {
  if (error instanceof CRMError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status }
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: error.flatten() } },
      { status: 400 }
    );
  }
  console.error('Unhandled CRM error:', error);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
    { status: 500 }
  );
}
```

### 15.2 `GET /api/v1/contacts/:id` & `PATCH /api/v1/contacts/:id`

```typescript
// src/app/api/v1/contacts/[id]/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { getContact, updateContact } from '@/lib/crm';
import { UpdateContactSchema } from '@/lib/crm/types';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext(req);
    requireRole(auth, ['admin', 'instructor']);

    const result = await getContact(params.id, auth);
    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext(req);
    requireRole(auth, ['admin', 'instructor']);

    const body = await req.json();
    const validated = UpdateContactSchema.parse(body);

    const result = await updateContact(params.id, validated, auth);
    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}
```

### 15.3 `GET /api/v1/contacts/:id/interactions`

```typescript
// src/app/api/v1/contacts/[id]/interactions/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { getInteractions } from '@/lib/crm';
import { InteractionsQuerySchema } from '@/lib/crm/types';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext(req);
    requireRole(auth, ['admin', 'instructor']);

    const queryParams = Object.fromEntries(req.nextUrl.searchParams);
    const validated = InteractionsQuerySchema.parse(queryParams);

    const result = await getInteractions(params.id, validated, auth);
    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}
```

### 15.4 `POST /api/v1/contacts/:id/convert`

```typescript
// src/app/api/v1/contacts/[id]/convert/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { convertToStudent } from '@/lib/crm';
import { ConvertContactSchema } from '@/lib/crm/types';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext(req);
    requireRole(auth, ['admin', 'instructor']);

    const body = await req.json();
    const validated = ConvertContactSchema.parse(body);

    const result = await convertToStudent(params.id, validated, auth);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
```

---

## 16. UTM Tracking

UTM parameters are captured from the booking widget referrer URL. The flow:

1. **Booking Widget (C02)** passes `document.referrer` or `window.location.search` UTMs along with the booking reservation request.
2. **Booking Engine (SPEC-03)** calls `upsertFromChannel()` from this CRM module, passing UTMs extracted via `extractUTMFromUrl()`.
3. **Contact record** stores `utm_source`, `utm_medium`, `utm_campaign` — set only on first contact, never overwritten.
4. **Admin Panel (C19)** displays source attribution in contact detail and CRM dashboard analytics.

### UTM capture at booking widget level (client-side):

```typescript
// In the booking widget (C02), capture UTMs from URL on load:
function captureUTMs(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source: params.get('utm_source') ?? '',
    utm_medium: params.get('utm_medium') ?? '',
    utm_campaign: params.get('utm_campaign') ?? '',
  };
}

// Pass to reservation API:
const reservation = {
  // ...booking data
  contact: { phone, email, first_name, last_name },
  ...captureUTMs(),
};
```

---

## 17. Contact Search

Contact search supports partial matching across multiple fields. The `search` query parameter on `GET /api/v1/contacts` performs a case-insensitive `ILIKE` across:

- `first_name`
- `last_name`
- `CONCAT(first_name, ' ', last_name)` (full name)
- `email`
- `phone`

For Rob's scale (20-30 active students, maybe 100-200 total contacts including prospects), PostgreSQL `ILIKE` with the existing indexes is performant. If contact volume grows beyond ~5000, consider adding a GIN trigram index:

```sql
-- Future optimisation if search becomes slow:
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_contacts_search_trgm ON contacts USING GIN (
  (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') || ' ' || COALESCE(email, '') || ' ' || COALESCE(phone, ''))
  gin_trgm_ops
);
```

---

## 18. Cron Jobs

Two cron jobs support the CRM lifecycle:

### 18.1 Nightly Lead Score Recalculation

```typescript
// src/app/api/cron/recalculate-scores/route.ts
// Triggered by Vercel Cron: 0 3 * * * (3am AEST daily)

import { NextResponse } from 'next/server';
import { recalculateAllScores } from '@/lib/crm/lead-scoring.service';
import { verifyCronSecret } from '@/lib/auth/cron';

export async function GET(req: Request) {
  verifyCronSecret(req);
  const result = await recalculateAllScores();
  return NextResponse.json({ status: 'ok', ...result });
}
```

### 18.2 Auto-Transition Completed → Alumni (30 days)

```typescript
// src/app/api/cron/alumni-transition/route.ts
// Triggered by Vercel Cron: 0 4 * * * (4am AEST daily)

import { NextResponse } from 'next/server';
import { sql, eq, and, lte } from 'drizzle-orm';
import { db } from '@/db';
import { contacts } from '@/db/schema';
import { verifyCronSecret } from '@/lib/auth/cron';

export async function GET(req: Request) {
  verifyCronSecret(req);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const result = await db
    .update(contacts)
    .set({ lifecycleStage: 'alumni', updatedAt: new Date() })
    .where(and(
      eq(contacts.lifecycleStage, 'completed'),
      lte(contacts.updatedAt, thirtyDaysAgo)
    ))
    .returning({ id: contacts.id });

  return NextResponse.json({
    status: 'ok',
    transitioned: result.length,
    contact_ids: result.map(r => r.id),
  });
}
```

### 18.3 Inactivity Reminder Notifications

```typescript
// src/app/api/cron/inactivity-reminders/route.ts
// Triggered by Vercel Cron: 0 17 * * * (4am AEST daily — runs after score recalc)

import { NextResponse } from 'next/server';
import { sql, and, inArray, lte, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { contacts } from '@/db/schema';
import { verifyCronSecret } from '@/lib/auth/cron';
import { INACTIVITY_REMINDER_DAYS, INACTIVITY_REMINDER_TEMPLATES } from '@/lib/crm/constants';
import { emitEvent } from '@/lib/crm/events';

/**
 * Sends reminder notifications to the instructor for contacts going cold.
 * 
 * Schedule:
 *   30 days inactive → gentle nudge
 *   60 days inactive → stronger warning
 *   80 days inactive → final warning (10 days until auto-lost)
 *
 * Only fires for prospect, lead, qualified stages.
 * Notifications delivered via Notification Engine (C18).
 */
export async function GET(req: Request) {
  verifyCronSecret(req);

  const now = new Date();
  const results: Record<number, number> = {};

  for (const days of INACTIVITY_REMINDER_DAYS) {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);

    // Find contacts whose last_contact_at is exactly in the target day window
    // (within a 24hr window to avoid duplicate sends)
    const dayStart = new Date(cutoff);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(cutoff);
    dayEnd.setHours(23, 59, 59, 999);

    const staleContacts = await db
      .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, instructorId: contacts.instructorId })
      .from(contacts)
      .where(and(
        inArray(contacts.lifecycleStage, ['prospect', 'lead', 'qualified']),
        sql`${contacts.lastContactAt} BETWEEN ${dayStart} AND ${dayEnd}`,
        isNotNull(contacts.instructorId)
      ));

    for (const contact of staleContacts) {
      emitEvent({
        type: 'INACTIVITY_REMINDER',
        data: {
          contact_id: contact.id,
          contact_name: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
          instructor_id: contact.instructorId!,
          days_inactive: days,
          template: INACTIVITY_REMINDER_TEMPLATES[days],
        },
      });
    }

    results[days] = staleContacts.length;
  }

  return NextResponse.json({ status: 'ok', reminders_sent: results });
}
```

### 18.4 Auto-Transition Lead → Lost (90 days inactive)

```typescript
// src/app/api/cron/lead-inactivity/route.ts
// Triggered by Vercel Cron: 0 18 * * * (5am AEST daily — runs after reminders)

import { NextResponse } from 'next/server';
import { sql, and, inArray, lte } from 'drizzle-orm';
import { db } from '@/db';
import { contacts } from '@/db/schema';
import { verifyCronSecret } from '@/lib/auth/cron';
import { LEAD_INACTIVITY_DAYS } from '@/lib/crm/constants';
import { emitEvent } from '@/lib/crm/events';

/**
 * Auto-transitions contacts to 'lost' after 90 days of inactivity.
 * 
 * Only affects: prospect, lead, qualified stages.
 * Lost contacts are retained — not deleted. They can be re-activated
 * to prospect manually if the person reaches out again.
 *
 * By the time this runs, the instructor has received reminders at 
 * 30, 60, and 80 days — they've had 3 chances to re-engage.
 */
export async function GET(req: Request) {
  verifyCronSecret(req);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LEAD_INACTIVITY_DAYS);

  const result = await db
    .update(contacts)
    .set({ lifecycleStage: 'lost', updatedAt: new Date() })
    .where(and(
      inArray(contacts.lifecycleStage, ['prospect', 'lead', 'qualified']),
      lte(contacts.lastContactAt, cutoff)
    ))
    .returning({ id: contacts.id, firstName: contacts.firstName });

  // Emit events for each transitioned contact
  for (const contact of result) {
    emitEvent({
      type: 'CONTACT_LIFECYCLE_CHANGED',
      data: {
        contact_id: contact.id,
        previous_stage: 'unknown',  // We don't track which stage they were in
        new_stage: 'lost',
        trigger: 'system:inactivity_timeout',
      },
    });
  }

  return NextResponse.json({
    status: 'ok',
    transitioned_to_lost: result.length,
    contact_ids: result.map(r => r.id),
  });
}
```

### 18.5 Vercel Cron Config

```json
// vercel.json (add to existing crons)
{
  "crons": [
    {
      "path": "/api/cron/recalculate-scores",
      "schedule": "0 16 * * *"
    },
    {
      "path": "/api/cron/inactivity-reminders",
      "schedule": "0 17 * * *"
    },
    {
      "path": "/api/cron/lead-inactivity",
      "schedule": "0 18 * * *"
    },
    {
      "path": "/api/cron/alumni-transition",
      "schedule": "0 19 * * *"
    }
  ]
}
```

> **Note:** Vercel cron uses UTC. Execution order matters: scores recalculated first (3am AEST), then inactivity reminders (4am), then auto-lost transition (5am), then alumni transition (6am). All run before business hours. `Australia/Canberra` timezone: UTC+10 (AEST) or UTC+11 (AEDT).

---

## 19. Integration Points

### 19.1 Booking Engine (SPEC-03) → CRM

SPEC-03 already includes an `upsertContact()` helper. After this spec is implemented, replace that with a call to `upsertFromChannel()`:

```typescript
// In SPEC-03's booking.service.ts, replace the inline upsertContact with:
import { upsertFromChannel } from '@/lib/crm';

const { contact_id } = await upsertFromChannel({
  phone: reservation.contact.phone,
  email: reservation.contact.email,
  first_name: reservation.contact.first_name,
  last_name: reservation.contact.last_name,
  source: reservation.booked_via === 'website' ? 'website' : reservation.booked_via,
  utm_source: reservation.utm_source,
  utm_medium: reservation.utm_medium,
  utm_campaign: reservation.utm_campaign,
  instructor_id: reservation.instructor_id,
}, auth);
```

### 19.2 Twilio SMS Webhook → CRM

```typescript
// In SMS webhook handler (Phase 2, C06):
import { upsertFromChannel } from '@/lib/crm';

const { contact_id, is_new } = await upsertFromChannel({
  phone: inboundSms.From,
  source: 'sms',
  source_detail: 'Twilio inbound',
}, systemAuth);
```

### 19.3 Vapi Voice Webhook → CRM

```typescript
// In voice agent webhook handler (Phase 2, C05):
import { upsertFromChannel } from '@/lib/crm';

const { contact_id, is_new } = await upsertFromChannel({
  phone: callEvent.caller_phone,
  first_name: callEvent.extracted_name,
  source: 'voice_agent',
  source_detail: `Vapi call ${callEvent.call_id}`,
}, systemAuth);
```

### 19.4 Web Chat Widget → CRM

```typescript
// In web chat start handler (Phase 2, C04):
import { upsertFromChannel } from '@/lib/crm';

const { contact_id, is_new } = await upsertFromChannel({
  email: chatSession.email,       // If provided
  first_name: chatSession.name,   // If provided
  source: 'web_chat',
  source_detail: chatSession.page_url,
}, systemAuth);
```

### 19.5 LESSON_COMPLETED Event → CRM

```typescript
// In event subscriber setup:
eventBus.on('LESSON_COMPLETED', async (event) => {
  // Auto-transition enrolled → active
  await onFirstLessonCompleted(event.data.student_id, systemAuth);

  // Touch contact + recompute score
  const contact = await findContactByStudentId(event.data.student_id);
  if (contact) {
    await touchContact(contact.id);
    await computeLeadScore(contact.id);
  }
});
```

---

## 20. Testing Strategy

### 20.1 Unit Tests

| Test File | Coverage |
|-----------|----------|
| `contacts.service.test.ts` | CRUD operations, search, RBAC enforcement, soft delete, mapToResponse |
| `lifecycle.service.test.ts` | All valid transitions, rejection of invalid transitions, manual vs system triggers, auto-promotion |
| `lead-scoring.service.test.ts` | Scoring weights, recency decay, clamping, bulk recalculation |
| `deduplication.service.test.ts` | Phone normalisation (AU numbers), findDuplicate (phone, email, both), mergeContacts (field merging, relation re-linking, soft delete) |
| `interactions.service.test.ts` | Timeline aggregation from each source, sorting, pagination, type filtering |
| `convert.service.test.ts` | Standard convert, parent-as-contact convert, stage validation, idempotency check, student creation, parent/student link, profile role update, event emission |
| `referral.service.test.ts` | Code generation, uniqueness, apply to new contact, invalid code handling, stats computation, auto-generation on completion |
| `export.service.test.ts` | Column selection, RBAC filtering, CSV escaping (commas, quotes, newlines), date formatting, empty result set |

### 20.2 Integration Tests

| Test File | Scenario |
|-----------|----------|
| `contact-lifecycle.test.ts` | Full prospect → lead → qualified → enrolled → active → completed → alumni with proper event emissions at each stage |
| `deduplication.test.ts` | Create two contacts with same phone, verify dedup. Merge and verify relation re-linking. |
| `channel-auto-create.test.ts` | Simulate SMS inbound creating contact, then voice call from same number touching same contact, then booking from same person |
| `referral-flow.test.ts` | Student completes → auto-generates referral code → new contact uses code → attribution tracked → referrer stats updated |

### 20.3 Key Edge Cases to Test

1. **Phone normalisation:** `'0412345678'`, `'+61 412 345 678'`, `'61412345678'`, `'04 1234 5678'` all resolve to `'+61412345678'`
2. **Duplicate on create:** Creating a contact with an existing phone returns the existing contact (not an error)
3. **Duplicate on update:** Changing a contact's phone to one that already exists on another contact returns a 409
4. **Invalid transition:** `enrolled` → `lead` throws `InvalidTransitionError`
5. **Convert non-qualified:** Converting a `prospect` as instructor throws error (admin can override)
6. **Double convert:** Converting an already-enrolled contact throws `ConvertError`
7. **Parent-as-contact convert:** `contact_is_parent: true` without `student_details` throws validation error. With details: creates 2 contacts, 1 student, 1 parent, 1 link
8. **Search:** `search=rob` matches "Rob Harrison" and "robert@gmail.com" and "0261234567" (if contains "rob")
9. **Interaction timeline:** Contacts with bookings + payments + messages + calls returns a correctly sorted merged timeline
10. **Lead score:** Score never goes below 0 or above 200
11. **Merge:** After merge, all bookings/conversations/calls point to primary. Secondary is soft-deleted.
12. **Referral code collision:** generateReferralCode retries on unique constraint violation (up to 3 attempts)
13. **Invalid referral code:** applyReferralCode returns null (no error) — invalid codes silently ignored
14. **CSV export RBAC:** Instructor export only contains their own contacts. Admin export contains all.
15. **Inactivity crons:** Contact at 90 days moves to lost. Contact at 89 days stays. Contact touched at day 88 resets countdown.

---

## 21. Error Response Format

All CRM endpoints return errors in this consistent shape (matching SPEC-03):

```json
{
  "error": {
    "code": "CONTACT_NOT_FOUND",
    "message": "Contact not found: abc-123",
    "details": {}
  }
}
```

| Code | HTTP | When |
|------|------|------|
| `VALIDATION_ERROR` | 400 | Zod validation failure |
| `FORBIDDEN` | 403 | RBAC: wrong role or wrong instructor |
| `CONTACT_NOT_FOUND` | 404 | Contact ID doesn't exist or is soft-deleted |
| `DUPLICATE_CONTACT` | 409 | Phone or email matches existing contact |
| `DUPLICATE_ON_UPDATE` | 409 | PATCH would create duplicate |
| `INVALID_LIFECYCLE_TRANSITION` | 422 | Stage A → Stage B is not allowed |
| `MANUAL_TRANSITION_REQUIRED` | 422 | System tried a manual-only transition |
| `CONVERT_ERROR` | 422 | Contact not in convertible stage, or student already exists |
| `INTERNAL_ERROR` | 500 | Unhandled exception |

---

## 22. Implementation Checklist

```
Phase 1 — Core CRUD (Days 1-2)
├── [ ] types.ts — All types + Zod schemas
├── [ ] constants.ts — Lifecycle transitions, scoring weights
├── [ ] errors.ts — Error classes
├── [ ] contacts.service.ts — list, get, create, update, softDelete, touch
├── [ ] deduplication.service.ts — normalisePhone, findDuplicate
├── [ ] API: GET/POST /api/v1/contacts
├── [ ] API: GET/PATCH /api/v1/contacts/:id
└── [ ] Unit tests for CRUD + dedup

Phase 2 — Lifecycle + Scoring (Days 3-4)
├── [ ] lifecycle.service.ts — transition, autoPromotion
├── [ ] lead-scoring.service.ts — computeLeadScore, recalculateAll
├── [ ] events.ts — CONTACT_CREATED, LIFECYCLE_CHANGED events
├── [ ] Unit tests for lifecycle + scoring
└── [ ] Cron: nightly score recalculation

Phase 3 — Interactions + Convert (Days 5-6)
├── [ ] interactions.service.ts — timeline aggregation
├── [ ] convert.service.ts — prospect → enrolled student
├── [ ] API: GET /api/v1/contacts/:id/interactions
├── [ ] API: POST /api/v1/contacts/:id/convert
├── [ ] Unit tests for interactions + convert
└── [ ] Cron: alumni transition

Phase 4 — Auto-Create + Merge + Integration (Days 7-9)
├── [ ] auto-create.service.ts — upsertFromChannel, extractUTM
├── [ ] mergeContacts in deduplication.service.ts
├── [ ] Replace SPEC-03 inline upsertContact
├── [ ] referral.service.ts — code generation, tracking, conversion attribution
├── [ ] export.service.ts — CSV export with configurable columns
├── [ ] Integration tests (full lifecycle, dedup, channel auto-create)
├── [ ] Wire up LESSON_COMPLETED → CRM event handler
├── [ ] Cron: inactivity reminders (30/60/80 days)
├── [ ] Cron: lead→lost auto-transition (90 days)
└── [ ] Final review + edge case testing
```

---

## 23. Referral Tracking (`referral.service.ts`)

The CRM owns referral tracking end-to-end. When a student completes their course (all 23 CBT&A tasks), they're offered a referral code. When a new contact signs up using that code, the referring student gets credit.

### 23.1 Referral Code Generation

```typescript
// src/lib/crm/referral.service.ts

import { eq, and, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { contacts, students } from '@/db/schema';
import { eventBus } from '@/lib/events';

/**
 * Referral code format: NEXDRIVE-{FIRST_NAME}-{4_RANDOM_CHARS}
 * Example: NEXDRIVE-SARAH-A7K2
 *
 * Generated automatically when student reaches 'completed' stage.
 * Also available on-demand for active students (Rob can share early).
 */

function generateReferralCode(firstName: string): string {
  const name = (firstName || 'FRIEND').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I ambiguity
  const random = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `NEXDRIVE-${name}-${random}`;
}

/**
 * Get or create a referral code for a student.
 *
 * Stored on the contacts table in a new `referral_code` column (TEXT, UNIQUE, nullable).
 * Only one code per contact — idempotent.
 */
export async function getOrCreateReferralCode(
  contactId: string
): Promise<{ referral_code: string; is_new: boolean }> {
  const [contact] = await db
    .select({ id: contacts.id, referralCode: contacts.referralCode, firstName: contacts.firstName })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) throw new Error(`Contact not found: ${contactId}`);

  // Already has a code
  if (contact.referralCode) {
    return { referral_code: contact.referralCode, is_new: false };
  }

  // Generate and save
  let code: string;
  let attempts = 0;
  
  // Retry loop in case of unlikely collision
  while (true) {
    code = generateReferralCode(contact.firstName ?? '');
    try {
      await db
        .update(contacts)
        .set({ referralCode: code, updatedAt: new Date() })
        .where(and(eq(contacts.id, contactId), isNull(contacts.referralCode)));
      break;
    } catch (err: any) {
      if (err.code === '23505' && attempts < 3) { // unique constraint violation
        attempts++;
        continue;
      }
      throw err;
    }
  }

  return { referral_code: code!, is_new: true };
}

/**
 * Apply a referral code to a new contact.
 *
 * Called during upsertFromChannel when a referral_code is provided
 * (e.g., from booking widget query param ?ref=NEXDRIVE-SARAH-A7K2).
 *
 * Sets:
 *   - contact.referred_by_contact_id → the referrer's contact ID
 *   - contact.referral_source → 'referral'
 *   - contact.source_detail → the referral code
 */
export async function applyReferralCode(
  contactId: string,
  referralCode: string
): Promise<{ referrer_contact_id: string; referrer_name: string } | null> {
  // Find the referrer
  const [referrer] = await db
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName })
    .from(contacts)
    .where(eq(contacts.referralCode, referralCode.toUpperCase()))
    .limit(1);

  if (!referrer) return null; // Invalid code — silently ignore

  // Update the new contact
  await db
    .update(contacts)
    .set({
      referredByContactId: referrer.id,
      source: 'referral',
      sourceDetail: referralCode.toUpperCase(),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));

  // Emit event — Notification Engine can notify the referrer
  eventBus.emit({
    type: 'REFERRAL_APPLIED' as any,
    data: {
      referrer_contact_id: referrer.id,
      referred_contact_id: contactId,
      referral_code: referralCode.toUpperCase(),
    },
  });

  return {
    referrer_contact_id: referrer.id,
    referrer_name: `${referrer.firstName ?? ''} ${referrer.lastName ?? ''}`.trim(),
  };
}

/**
 * Get referral stats for a contact.
 */
export async function getReferralStats(contactId: string): Promise<{
  referral_code: string | null;
  total_referrals: number;
  converted_referrals: number;  // Referrals that became enrolled students
}> {
  const [contact] = await db
    .select({ referralCode: contacts.referralCode })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) throw new Error(`Contact not found: ${contactId}`);
  if (!contact.referralCode) return { referral_code: null, total_referrals: 0, converted_referrals: 0 };

  const referrals = await db
    .select({
      id: contacts.id,
      lifecycleStage: contacts.lifecycleStage,
    })
    .from(contacts)
    .where(eq(contacts.referredByContactId, contactId));

  const enrolled_stages = ['enrolled', 'active', 'completed', 'alumni'];

  return {
    referral_code: contact.referralCode,
    total_referrals: referrals.length,
    converted_referrals: referrals.filter(r => enrolled_stages.includes(r.lifecycleStage)).length,
  };
}
```

### 23.2 Database Additions

Two new columns on the `contacts` table:

```sql
-- Add to contacts table (SPEC-01 migration)
ALTER TABLE contacts ADD COLUMN referral_code TEXT UNIQUE;
ALTER TABLE contacts ADD COLUMN referred_by_contact_id UUID REFERENCES contacts(id);
CREATE INDEX idx_contacts_referral_code ON contacts(referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX idx_contacts_referred_by ON contacts(referred_by_contact_id) WHERE referred_by_contact_id IS NOT NULL;
```

### 23.3 API Endpoints

```
GET  /api/v1/contacts/:id/referral       → getReferralStats (+ generate code if none exists)
POST /api/v1/contacts/:id/referral/apply  → applyReferralCode (called internally by booking engine)
```

### 23.4 Integration with Booking Widget (C02)

The booking widget accepts a `?ref=` query parameter. When present:

```typescript
// In SPEC-03 booking flow, after upsertFromChannel:
if (referralCode) {
  await applyReferralCode(contact_id, referralCode);
}
```

### 23.5 Reward Mechanism (Future)

The CRM tracks who-referred-whom and conversion status. The actual reward (e.g., "$20 credit per converted referral") is a Payment Engine (C10) concern. When the CRM emits `REFERRAL_APPLIED` and the referred contact later transitions to `enrolled`, the Payment Engine can issue a credit.

> **Decision:** Reward value and type are configurable in the Admin Panel (C19). Not hardcoded. Default: no reward until Rob activates it.

### 23.6 Auto-Generation on Completion

When a student hits the `completed` lifecycle stage (all 23 CBT&A tasks achieved), the system auto-generates a referral code and sends a congratulatory notification with the code.

```typescript
// Event handler — subscribe to CONTACT_LIFECYCLE_CHANGED
async function onStudentCompleted(event: { contact_id: string; new_stage: string }) {
  if (event.new_stage !== 'completed') return;
  const { referral_code } = await getOrCreateReferralCode(event.contact_id);
  
  // Notify student with their referral code
  eventBus.emit({
    type: 'NOTIFICATION_REQUESTED' as any,
    data: {
      template: 'STUDENT_COMPLETED_WITH_REFERRAL',
      contact_id: event.contact_id,
      data: { referral_code },
    },
  });
}
```

---

## 24. CSV Export (`export.service.ts`)

The CRM service layer owns data extraction. The Admin Panel (C19) will provide the button/UI.

```typescript
// src/lib/crm/export.service.ts

import { eq, and, isNull, ilike, sql, inArray, between, desc, asc } from 'drizzle-orm';
import { db } from '@/db';
import { contacts } from '@/db/schema';
import type { AuthContext } from '@/lib/auth/types';

/**
 * Configurable columns for CSV export.
 * Admin selects which columns to include via the UI.
 */
export const EXPORTABLE_COLUMNS = {
  first_name: 'First Name',
  last_name: 'Last Name',
  email: 'Email',
  phone: 'Phone',
  lifecycle_stage: 'Lifecycle Stage',
  source: 'Source',
  source_detail: 'Source Detail',
  lead_score: 'Lead Score',
  interaction_count: 'Interactions',
  first_contact_at: 'First Contact',
  last_contact_at: 'Last Contact',
  utm_source: 'UTM Source',
  utm_medium: 'UTM Medium',
  utm_campaign: 'UTM Campaign',
  referral_code: 'Referral Code',
  notes: 'Notes',
  created_at: 'Created',
} as const;

export type ExportColumn = keyof typeof EXPORTABLE_COLUMNS;

export interface ExportOptions {
  columns: ExportColumn[];
  filters?: {
    lifecycle_stage?: string[];
    source?: string[];
    instructor_id?: string;
    created_after?: Date;
    created_before?: Date;
    search?: string;
  };
  sort_by?: ExportColumn;
  sort_order?: 'asc' | 'desc';
}

/**
 * Export contacts as CSV string.
 *
 * - Respects RBAC: instructors only see their own contacts
 * - Columns are configurable
 * - Filters match the list endpoint
 * - Returns raw CSV string (Admin Panel handles download)
 */
export async function exportContactsCsv(
  options: ExportOptions,
  auth: AuthContext
): Promise<string> {
  const { columns, filters, sort_by, sort_order } = options;

  // Build query conditions
  const conditions = [isNull(contacts.deletedAt)];

  // RBAC
  if (auth.role === 'instructor') {
    conditions.push(eq(contacts.instructorId, auth.instructorId!));
  }

  if (filters?.lifecycle_stage?.length) {
    conditions.push(inArray(contacts.lifecycleStage, filters.lifecycle_stage as any));
  }
  if (filters?.source?.length) {
    conditions.push(inArray(contacts.source, filters.source as any));
  }
  if (filters?.instructor_id) {
    conditions.push(eq(contacts.instructorId, filters.instructor_id));
  }
  if (filters?.created_after) {
    conditions.push(sql`${contacts.createdAt} >= ${filters.created_after}`);
  }
  if (filters?.created_before) {
    conditions.push(sql`${contacts.createdAt} <= ${filters.created_before}`);
  }
  if (filters?.search) {
    conditions.push(
      sql`(
        ${contacts.firstName} ILIKE ${'%' + filters.search + '%'} OR
        ${contacts.lastName} ILIKE ${'%' + filters.search + '%'} OR
        ${contacts.email} ILIKE ${'%' + filters.search + '%'} OR
        ${contacts.phone} ILIKE ${'%' + filters.search + '%'}
      )`
    );
  }

  // Query
  const rows = await db
    .select()
    .from(contacts)
    .where(and(...conditions))
    .orderBy(
      sort_order === 'asc'
        ? asc(contacts[sort_by ?? 'createdAt'])
        : desc(contacts[sort_by ?? 'createdAt'])
    );

  // Build CSV
  const header = columns.map(c => EXPORTABLE_COLUMNS[c]);
  const csvRows = rows.map(row =>
    columns.map(col => {
      const val = row[col as keyof typeof row];
      if (val === null || val === undefined) return '';
      if (val instanceof Date) return val.toISOString();
      const str = String(val);
      // Escape CSV: wrap in quotes if contains comma, newline, or quote
      return str.includes(',') || str.includes('\n') || str.includes('"')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    })
  );

  return [header.join(','), ...csvRows.map(r => r.join(','))].join('\n');
}
```

### 24.1 API Endpoint

```
GET /api/v1/contacts/export?columns=first_name,last_name,email,phone,lifecycle_stage&lifecycle_stage=active,enrolled&format=csv
```

Returns `Content-Type: text/csv` with `Content-Disposition: attachment; filename="nexdrive-contacts-2026-02-20.csv"`.

> **Split:** The CRM provides this endpoint and the data extraction logic. The Admin Panel (C19) provides the UI: column picker, filter selection, download button.

---

## 25. Resolved Design Decisions

Formerly "Open Questions for Rob" — all resolved 2026-02-20.

| # | Question | Decision | Impact |
|---|----------|----------|--------|
| 1 | Lead inactivity timeout: 90 days? | **Yes, 90 days confirmed.** Reminder notifications at 30, 60, and 80 days before auto-transition. Lost contacts retained, not deleted. | Added: `INACTIVITY_REMINDER_DAYS` constants, inactivity reminder cron (§18.3), lead→lost cron (§18.4) |
| 2 | Referral tracking in CRM? | **Yes, CRM owns it.** Code generation, tracking, conversion attribution all in CRM. Reward mechanism deferred to Payment Engine (C10). | Added: §23 Referral Tracking, `referral.service.ts`, 2 new columns on contacts table |
| 3 | CSV export — CRM or Admin Panel? | **Split.** CRM service layer owns data extraction (`exportContactsCsv()`). Admin Panel (C19) owns the UI (column picker, download button). | Added: §24 CSV Export, `export.service.ts`. Flagged for C19 spec. |
| 4 | Parent linking on convert? | **Flexible.** Convert endpoint supports `contact_is_parent: true` flag. Creates student contact, student record, parent record, and link in one transaction. Handles the real-world scenario of parent enquiring on behalf of learner. | Rewrote: §12 Convert Service with `convertStandard()` and `convertWithParent()` branches |
| 5 | Contact merge UI in Admin Panel? | **Yes.** Service layer merge is in this spec. UI button flagged as requirement for Admin Panel spec (C19). | No spec change. Flagged for C19. |
