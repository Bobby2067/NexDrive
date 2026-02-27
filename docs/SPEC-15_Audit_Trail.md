# SPEC-15: Audit Trail (C14)
### NexDrive Academy — Phase 3: Digitise the Paperwork
**Version:** 1.0  
**Date:** 22 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §3.3 (audit_log), §3.5 (compute_audit_hash trigger), SPEC-01 (DB schema), SPEC-02 (Auth/RBAC)  
**Phase:** 3 (Weeks 13–20)  
**Estimated Effort:** 2–3 days  

---

## 1. Overview

This specification defines the Audit Trail service (C14) — the immutable, tamper-evident event log for NexDrive Academy. Every compliance-relevant action writes to `audit_log` via a single service function. The database enforces append-only semantics. SHA-256 hash chains make tampering detectable. Admin APIs expose query, export, and chain-verification endpoints.

**This is a self-contained implementation brief.** A developer or AI coding agent should be able to implement this spec end-to-end without consulting the architecture document.

### 1.1 What This Component Does

- Records every compliance-relevant action across all services as a structured event
- Computes a SHA-256 hash chain in the database (tamper-evident, verified on demand)
- Provides admin-only query API with full filtering support
- Provides chain integrity verification endpoint (walks the entire chain, reports breaks)
- Exports logs to CSV or JSON for ACT Government auditors
- Enforces append-only at the database constraint level — no UPDATE, no DELETE, ever

### 1.2 What Gets Audited

The rule is simple: **if it touches a student, a booking, a lesson, a payment, a competency, a signature, or a system configuration — it gets audited.** Ephemeral read-only queries (e.g. viewing your own profile) do not need to be audited, but all mutations and all compliance-critical reads do.

### 1.3 Non-Negotiable Rules

1. `audit.log()` must **never throw** — audit failure must not break the parent operation
2. Audit writes are **always async** and must not block request response time
3. The `audit_log` table has **no `updated_at`**, **no soft delete** — it is insert-only
4. Database constraints prevent UPDATE and DELETE on `audit_log` (enforced via trigger, not just convention)
5. Hash chain is computed by a **database trigger** (`BEFORE INSERT`) — not in application code
6. Retention is **indefinite** — audit logs are never expired or purged
7. Export is gated to `admin` role only, with export event itself written to audit log
8. Australian data residency: all logs in Neon Sydney — never replicated offshore

---

## 2. File Structure

```
src/
├── lib/
│   └── audit/
│       ├── index.ts              # Public export: audit.log(), AuditEventType, AuditSeverity
│       ├── service.ts            # Core audit.log() implementation
│       ├── event-types.ts        # Complete AuditEventType enum + metadata
│       └── verify.ts             # Chain verification logic
├── app/
│   └── api/
│       └── v1/
│           └── admin/
│               └── audit/
│                   ├── route.ts          # GET /api/v1/admin/audit
│                   ├── verify/
│                   │   └── route.ts      # GET /api/v1/admin/audit/verify
│                   └── export/
│                       └── route.ts      # GET /api/v1/admin/audit/export
└── db/
    └── schema/
        └── compliance.ts         # audit_log Drizzle schema (already in SPEC-01)
```

---

## 3. Database Schema (Already in SPEC-01 — Reproduced Here for Clarity)

The `audit_log` table is defined in SPEC-01. Reproducing here so this spec is self-contained.

```sql
CREATE TABLE audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event classification
  event_type      TEXT NOT NULL,   -- AuditEventType enum value
  severity        TEXT NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info', 'warning', 'critical')),

  -- Who did it (NULL for system/cron events)
  actor_id        TEXT,            -- Clerk user ID
  actor_role      TEXT,            -- 'admin', 'instructor', 'student', 'parent', 'system'

  -- What was affected
  subject_type    TEXT,            -- 'lesson', 'booking', 'student', 'payment', etc.
  subject_id      UUID,

  -- Event-specific payload
  details         JSONB NOT NULL DEFAULT '{}',

  -- Request context
  ip_address      INET,
  user_agent      TEXT,
  gps_latitude    NUMERIC(10,7),
  gps_longitude   NUMERIC(10,7),

  -- Hash chain (computed by trigger, never set by application)
  previous_hash   TEXT,
  record_hash     TEXT NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()

  -- STRICTLY APPEND-ONLY:
  -- No updated_at. No deleted_at.
  -- No UPDATE. No DELETE. Ever.
);

-- Indexes for query performance
CREATE INDEX idx_audit_event_type ON audit_log(event_type);
CREATE INDEX idx_audit_actor      ON audit_log(actor_id);
CREATE INDEX idx_audit_subject    ON audit_log(subject_type, subject_id);
CREATE INDEX idx_audit_created    ON audit_log(created_at DESC);
CREATE INDEX idx_audit_severity   ON audit_log(severity);
```

### 3.1 Append-Only Enforcement Trigger

This trigger fires BEFORE any UPDATE or DELETE and raises an exception. Combined with the hash chain trigger on INSERT, this makes `audit_log` tamper-resistant at the database level.

```sql
-- Prevent UPDATE
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only. UPDATE and DELETE are not permitted. (attempted operation: %)', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
```

### 3.2 SHA-256 Hash Chain Trigger (from Architecture §3.5)

This trigger fires BEFORE INSERT and sets `previous_hash` (the hash of the most recently created record) and `record_hash` (SHA-256 of this record's fields). The application never touches these columns.

```sql
CREATE OR REPLACE FUNCTION compute_audit_hash()
RETURNS TRIGGER AS $$
BEGIN
  -- previous_hash = the record_hash of the latest existing record
  NEW.previous_hash := (
    SELECT record_hash
    FROM audit_log
    ORDER BY created_at DESC
    LIMIT 1
  );

  -- record_hash = SHA-256 of: event_type + actor_id + subject_id + created_at + previous_hash
  -- GENESIS sentinel used when no previous record exists (first record in chain)
  NEW.record_hash := encode(
    sha256(
      (
        NEW.event_type
        || COALESCE(NEW.actor_id, 'SYSTEM')
        || COALESCE(NEW.subject_id::TEXT, 'NULL')
        || NEW.created_at::TEXT
        || COALESCE(NEW.previous_hash, 'GENESIS')
      )::bytea
    ),
    'hex'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_hash_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION compute_audit_hash();
```

**Hash input fields** (order is fixed and must never change):
1. `event_type`
2. `actor_id` (or literal `'SYSTEM'` if NULL)
3. `subject_id::TEXT` (or literal `'NULL'` if NULL)
4. `created_at::TEXT` (PostgreSQL default ISO 8601 format)
5. `previous_hash` (or literal `'GENESIS'` for first record)

If the algorithm or field order ever changes, it will break chain verification. **This is by design** — any schema migration that changes these fields must be accompanied by a chain migration plan.

### 3.3 Drizzle Schema

```typescript
// src/db/schema/compliance.ts (add to existing file from SPEC-01)

import { pgTable, uuid, text, jsonb, inet, numeric, timestamp } from 'drizzle-orm/pg-core';

export const auditLog = pgTable('audit_log', {
  id:           uuid('id').primaryKey().defaultRandom(),
  eventType:    text('event_type').notNull(),
  severity:     text('severity').notNull().default('info'),
  actorId:      text('actor_id'),
  actorRole:    text('actor_role'),
  subjectType:  text('subject_type'),
  subjectId:    uuid('subject_id'),
  details:      jsonb('details').notNull().default({}),
  ipAddress:    inet('ip_address'),
  userAgent:    text('user_agent'),
  gpsLatitude:  numeric('gps_latitude', { precision: 10, scale: 7 }),
  gpsLongitude: numeric('gps_longitude', { precision: 10, scale: 7 }),
  previousHash: text('previous_hash'),
  recordHash:   text('record_hash').notNull(),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // NOTE: No updatedAt. No deletedAt. This table is append-only.
});

export type AuditLogRecord  = typeof auditLog.$inferSelect;
export type AuditLogInsert  = typeof auditLog.$inferInsert;
```

---

## 4. Audit Event Types

### 4.1 Complete Enum Definition

```typescript
// src/lib/audit/event-types.ts

export const AuditEventType = {
  // ── Lessons ──────────────────────────────────────────────────────────────
  LESSON_CREATED:                'LESSON_CREATED',
  LESSON_UPDATED:                'LESSON_UPDATED',          // Draft edits only (before signing)
  LESSON_SIGNED_BY_INSTRUCTOR:   'LESSON_SIGNED_BY_INSTRUCTOR',
  LESSON_SIGNED_BY_STUDENT:      'LESSON_SIGNED_BY_STUDENT',
  LESSON_COMPLETED:              'LESSON_COMPLETED',         // Both signatures captured
  LESSON_CORRECTION_CREATED:     'LESSON_CORRECTION_CREATED',
  LESSON_BRIDGE_FORM_GENERATED:  'LESSON_BRIDGE_FORM_GENERATED',
  LESSON_DISPUTED:               'LESSON_DISPUTED',

  // ── Bookings ─────────────────────────────────────────────────────────────
  BOOKING_CREATED:               'BOOKING_CREATED',
  BOOKING_CONFIRMED:             'BOOKING_CONFIRMED',
  BOOKING_CANCELLED:             'BOOKING_CANCELLED',
  BOOKING_RESCHEDULED:           'BOOKING_RESCHEDULED',
  BOOKING_STARTED:               'BOOKING_STARTED',
  BOOKING_COMPLETED:             'BOOKING_COMPLETED',        // Triggers lesson creation
  BOOKING_NO_SHOW:               'BOOKING_NO_SHOW',

  // ── Competencies ─────────────────────────────────────────────────────────
  COMPETENCY_TAUGHT:             'COMPETENCY_TAUGHT',
  COMPETENCY_ASSESSED:           'COMPETENCY_ASSESSED',
  COMPETENCY_ACHIEVED:           'COMPETENCY_ACHIEVED',      // Signed-off as competent
  COMPETENCY_NOT_YET_COMPETENT:  'COMPETENCY_NOT_YET_COMPETENT',
  COMPETENCY_SIGNED_OFF:         'COMPETENCY_SIGNED_OFF',    // Signature captured
  CERTIFICATE_ELIGIBILITY_CHECKED: 'CERTIFICATE_ELIGIBILITY_CHECKED',
  CERTIFICATE_ISSUED:            'CERTIFICATE_ISSUED',

  // ── Payments ─────────────────────────────────────────────────────────────
  PAYMENT_CREATED:               'PAYMENT_CREATED',
  PAYMENT_PROCESSED:             'PAYMENT_PROCESSED',
  PAYMENT_FAILED:                'PAYMENT_FAILED',
  PAYMENT_REFUNDED:              'PAYMENT_REFUNDED',
  PAYMENT_DISPUTED:              'PAYMENT_DISPUTED',
  PACKAGE_PURCHASED:             'PACKAGE_PURCHASED',
  PACKAGE_CREDIT_USED:           'PACKAGE_CREDIT_USED',
  PACKAGE_EXPIRED:               'PACKAGE_EXPIRED',
  VOUCHER_REDEEMED:              'VOUCHER_REDEEMED',
  VOUCHER_CREATED:               'VOUCHER_CREATED',
  INVOICE_GENERATED:             'INVOICE_GENERATED',

  // ── Signatures ───────────────────────────────────────────────────────────
  SIGNATURE_CAPTURED:            'SIGNATURE_CAPTURED',       // Any signature captured
  SIGNATURE_CHAIN_VERIFIED:      'SIGNATURE_CHAIN_VERIFIED',

  // ── Students / Users ─────────────────────────────────────────────────────
  STUDENT_ENROLLED:              'STUDENT_ENROLLED',
  STUDENT_STATUS_CHANGED:        'STUDENT_STATUS_CHANGED',
  STUDENT_INSTRUCTOR_CHANGED:    'STUDENT_INSTRUCTOR_CHANGED',
  STUDENT_PRIVACY_UPDATED:       'STUDENT_PRIVACY_UPDATED',
  STUDENT_COMPLETED:             'STUDENT_COMPLETED',
  PROFILE_CREATED:               'PROFILE_CREATED',
  PROFILE_UPDATED:               'PROFILE_UPDATED',

  // ── Parents ──────────────────────────────────────────────────────────────
  PARENT_INVITED:                'PARENT_INVITED',
  PARENT_LINK_ACCEPTED:          'PARENT_LINK_ACCEPTED',
  PARENT_LINK_REVOKED:           'PARENT_LINK_REVOKED',
  PARENT_PERMISSIONS_UPDATED:    'PARENT_PERMISSIONS_UPDATED',

  // ── Instructors ──────────────────────────────────────────────────────────
  INSTRUCTOR_ONBOARDED:          'INSTRUCTOR_ONBOARDED',
  INSTRUCTOR_STATUS_CHANGED:     'INSTRUCTOR_STATUS_CHANGED',
  INSTRUCTOR_VERIFIED:           'INSTRUCTOR_VERIFIED',
  AVAILABILITY_RULE_UPDATED:     'AVAILABILITY_RULE_UPDATED',
  AVAILABILITY_OVERRIDE_CREATED: 'AVAILABILITY_OVERRIDE_CREATED',

  // ── CRM / Contacts ───────────────────────────────────────────────────────
  CONTACT_CREATED:               'CONTACT_CREATED',
  CONTACT_UPDATED:               'CONTACT_UPDATED',
  CONTACT_LIFECYCLE_CHANGED:     'CONTACT_LIFECYCLE_CHANGED',  // prospect→lead→enrolled etc.
  CONTACT_CONVERTED:             'CONTACT_CONVERTED',           // To enrolled student

  // ── Auth / Access ─────────────────────────────────────────────────────────
  USER_LOGIN:                    'USER_LOGIN',
  USER_LOGOUT:                   'USER_LOGOUT',
  USER_LOGIN_FAILED:             'USER_LOGIN_FAILED',
  USER_ROLE_CHANGED:             'USER_ROLE_CHANGED',
  USER_SUSPENDED:                'USER_SUSPENDED',
  PERMISSION_DENIED:             'PERMISSION_DENIED',           // RBAC enforcement triggered
  PRIVATE_NOTE_ACCESSED:         'PRIVATE_NOTE_ACCESSED',       // Instructor views own notes

  // ── System / Admin ───────────────────────────────────────────────────────
  ADMIN_ACTION:                  'ADMIN_ACTION',               // Catch-all for admin operations
  SERVICE_UPDATED:               'SERVICE_UPDATED',
  PACKAGE_UPDATED:               'PACKAGE_UPDATED',
  SYSTEM_CONFIG_CHANGED:         'SYSTEM_CONFIG_CHANGED',

  // ── AI Channels ───────────────────────────────────────────────────────────
  VOICE_CALL_COMPLETED:          'VOICE_CALL_COMPLETED',
  SMS_CONVERSATION_STARTED:      'SMS_CONVERSATION_STARTED',
  AI_BOOKING_MADE:               'AI_BOOKING_MADE',            // Booking made by AI agent
  AI_HANDOFF_TRIGGERED:          'AI_HANDOFF_TRIGGERED',

  // ── Webhooks ─────────────────────────────────────────────────────────────
  WEBHOOK_RECEIVED:              'WEBHOOK_RECEIVED',           // Raw webhook from Twilio, Stripe, etc.

  // ── Audit Trail Itself ────────────────────────────────────────────────────
  AUDIT_LOG_EXPORTED:            'AUDIT_LOG_EXPORTED',         // Who exported the audit log
  AUDIT_CHAIN_VERIFIED:          'AUDIT_CHAIN_VERIFIED',       // Admin ran chain verification
  AUDIT_CHAIN_INTEGRITY_FAILED:  'AUDIT_CHAIN_INTEGRITY_FAILED', // Broken link detected
} as const;

export type AuditEventType = typeof AuditEventType[keyof typeof AuditEventType];

export const AuditSeverity = {
  INFO:     'info',
  WARNING:  'warning',
  CRITICAL: 'critical',
} as const;

export type AuditSeverity = typeof AuditSeverity[keyof typeof AuditSeverity];

// Severity defaults per event type — used by audit.log() when severity not specified
export const EVENT_SEVERITY_DEFAULTS: Record<AuditEventType, AuditSeverity> = {
  LESSON_CREATED:                    'info',
  LESSON_UPDATED:                    'info',
  LESSON_SIGNED_BY_INSTRUCTOR:       'info',
  LESSON_SIGNED_BY_STUDENT:          'info',
  LESSON_COMPLETED:                  'info',
  LESSON_CORRECTION_CREATED:         'warning',   // Corrections warrant attention
  LESSON_BRIDGE_FORM_GENERATED:      'info',
  LESSON_DISPUTED:                   'critical',
  BOOKING_CREATED:                   'info',
  BOOKING_CONFIRMED:                 'info',
  BOOKING_CANCELLED:                 'warning',
  BOOKING_RESCHEDULED:               'info',
  BOOKING_STARTED:                   'info',
  BOOKING_COMPLETED:                 'info',
  BOOKING_NO_SHOW:                   'warning',
  COMPETENCY_TAUGHT:                 'info',
  COMPETENCY_ASSESSED:               'info',
  COMPETENCY_ACHIEVED:               'info',
  COMPETENCY_NOT_YET_COMPETENT:      'info',
  COMPETENCY_SIGNED_OFF:             'info',
  CERTIFICATE_ELIGIBILITY_CHECKED:   'info',
  CERTIFICATE_ISSUED:                'info',
  PAYMENT_CREATED:                   'info',
  PAYMENT_PROCESSED:                 'info',
  PAYMENT_FAILED:                    'warning',
  PAYMENT_REFUNDED:                  'warning',
  PAYMENT_DISPUTED:                  'critical',
  PACKAGE_PURCHASED:                 'info',
  PACKAGE_CREDIT_USED:               'info',
  PACKAGE_EXPIRED:                   'warning',
  VOUCHER_REDEEMED:                  'info',
  VOUCHER_CREATED:                   'info',
  INVOICE_GENERATED:                 'info',
  SIGNATURE_CAPTURED:                'info',
  SIGNATURE_CHAIN_VERIFIED:          'info',
  STUDENT_ENROLLED:                  'info',
  STUDENT_STATUS_CHANGED:            'warning',
  STUDENT_INSTRUCTOR_CHANGED:        'warning',
  STUDENT_PRIVACY_UPDATED:           'info',
  STUDENT_COMPLETED:                 'info',
  PROFILE_CREATED:                   'info',
  PROFILE_UPDATED:                   'info',
  PARENT_INVITED:                    'info',
  PARENT_LINK_ACCEPTED:              'info',
  PARENT_LINK_REVOKED:               'warning',
  PARENT_PERMISSIONS_UPDATED:        'info',
  INSTRUCTOR_ONBOARDED:              'info',
  INSTRUCTOR_STATUS_CHANGED:         'warning',
  INSTRUCTOR_VERIFIED:               'info',
  AVAILABILITY_RULE_UPDATED:         'info',
  AVAILABILITY_OVERRIDE_CREATED:     'info',
  CONTACT_CREATED:                   'info',
  CONTACT_UPDATED:                   'info',
  CONTACT_LIFECYCLE_CHANGED:         'info',
  CONTACT_CONVERTED:                 'info',
  USER_LOGIN:                        'info',
  USER_LOGOUT:                       'info',
  USER_LOGIN_FAILED:                 'warning',
  USER_ROLE_CHANGED:                 'critical',
  USER_SUSPENDED:                    'critical',
  PERMISSION_DENIED:                 'warning',
  PRIVATE_NOTE_ACCESSED:             'info',
  ADMIN_ACTION:                      'warning',
  SERVICE_UPDATED:                   'warning',
  PACKAGE_UPDATED:                   'warning',
  SYSTEM_CONFIG_CHANGED:             'critical',
  VOICE_CALL_COMPLETED:              'info',
  SMS_CONVERSATION_STARTED:          'info',
  AI_BOOKING_MADE:                   'info',
  AI_HANDOFF_TRIGGERED:              'warning',
  WEBHOOK_RECEIVED:                  'info',
  AUDIT_LOG_EXPORTED:                'critical',  // Always log exports at critical
  AUDIT_CHAIN_VERIFIED:              'info',
  AUDIT_CHAIN_INTEGRITY_FAILED:      'critical',
};
```

---

## 5. Core Service: `audit.log()`

This is the single function all other services call. It is the only code path that writes to `audit_log`.

### 5.1 Types

```typescript
// src/lib/audit/service.ts

import { AuditEventType, AuditSeverity, EVENT_SEVERITY_DEFAULTS } from './event-types';

export interface AuditContext {
  ipAddress?:   string;   // Request IP (from headers)
  userAgent?:   string;   // User-Agent header
  gpsLatitude?: number;   // From lesson recording device
  gpsLongitude?: number;
}

export interface AuditParams {
  eventType:    AuditEventType;
  actorId?:     string;              // Clerk user ID; omit for system events
  actorRole?:   string;              // 'admin' | 'instructor' | 'student' | 'parent' | 'system'
  subjectType?: string;              // 'lesson' | 'booking' | 'student' | 'payment' | etc.
  subjectId?:   string;              // UUID of the affected record
  details?:     Record<string, unknown>; // Event-specific payload — be descriptive
  severity?:    AuditSeverity;       // Defaults to EVENT_SEVERITY_DEFAULTS[eventType]
  context?:     AuditContext;
}
```

### 5.2 Implementation

```typescript
// src/lib/audit/service.ts (continued)

import { db } from '@/db';
import { auditLog } from '@/db/schema/compliance';

/**
 * Write an audit event to the immutable audit_log table.
 *
 * RULES:
 * - NEVER throws. If audit write fails, log to Sentry and continue.
 * - Always async — never awaited in the calling hot path unless strictly needed.
 * - Hash chain and append-only enforcement handled by DB triggers.
 * - The application NEVER sets previous_hash or record_hash — those are trigger-computed.
 *
 * USAGE:
 *   // Fire-and-forget (preferred — does not slow parent operation)
 *   void audit.log({ eventType: AuditEventType.LESSON_CREATED, ... });
 *
 *   // Awaited (use only when audit confirmation is required before responding)
 *   await audit.log({ ... });
 */
export async function auditLog(params: AuditParams): Promise<void> {
  const {
    eventType,
    actorId,
    actorRole,
    subjectType,
    subjectId,
    details = {},
    severity = EVENT_SEVERITY_DEFAULTS[params.eventType] ?? 'info',
    context = {},
  } = params;

  try {
    await db.insert(auditLog).values({
      eventType,
      severity,
      actorId:      actorId   ?? null,
      actorRole:    actorRole ?? null,
      subjectType:  subjectType ?? null,
      subjectId:    subjectId   ?? null,
      details,
      ipAddress:    context.ipAddress   ?? null,
      userAgent:    context.userAgent   ?? null,
      gpsLatitude:  context.gpsLatitude  ? String(context.gpsLatitude)  : null,
      gpsLongitude: context.gpsLongitude ? String(context.gpsLongitude) : null,
      // previous_hash and record_hash: DO NOT SET — computed by DB trigger
    });
  } catch (error) {
    // Audit failure must NEVER break the parent operation
    // Report to Sentry but swallow the error
    console.error('[Audit] Failed to write audit event:', { eventType, actorId, subjectId, error });
    // In production: Sentry.captureException(error, { extra: { eventType, actorId } });
  }
}

// Convenience namespace export
export const audit = { log: auditLog };
```

### 5.3 Context Extraction Helpers

These are helpers called in API route handlers to pull request context before passing to services.

```typescript
// src/lib/audit/service.ts (continued)

import { NextRequest } from 'next/server';

/**
 * Extract audit context from a Next.js API request.
 * Call this in route handlers, pass the result down to service functions.
 */
export function extractAuditContext(req: NextRequest): AuditContext {
  return {
    ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? req.headers.get('x-real-ip')
      ?? undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
  };
}

/**
 * Extract audit context from Clerk auth session.
 * Augments extractAuditContext with actor fields.
 */
export function extractAuditActor(sessionClaims: Record<string, unknown> | null) {
  if (!sessionClaims) return { actorId: undefined, actorRole: 'system' as const };
  return {
    actorId:   sessionClaims.sub as string | undefined,
    actorRole: sessionClaims.role as string | undefined,
  };
}
```

---

## 6. Usage Examples — How Other Services Call This

Every service that performs an auditable action must call `audit.log()`. The call should be fire-and-forget (`void audit.log(...)`) unless the business logic requires knowing the audit record was persisted before continuing.

```typescript
// ── Example 1: Booking Engine (C08) ──────────────────────────────────────
import { audit, AuditEventType, extractAuditContext, extractAuditActor } from '@/lib/audit';

// In POST /api/v1/booking/confirm handler:
const ctx     = extractAuditContext(req);
const actor   = extractAuditActor(sessionClaims);

const booking = await bookingService.confirm(reservationId, paymentIntentId);

void audit.log({
  eventType:   AuditEventType.BOOKING_CONFIRMED,
  ...actor,
  subjectType: 'booking',
  subjectId:   booking.id,
  details: {
    studentId:     booking.student_id,
    instructorId:  booking.instructor_id,
    scheduledDate: booking.scheduled_date,
    serviceId:     booking.service_id,
    amountCents:   booking.total_price_cents,
  },
  context: ctx,
});

// ── Example 2: Lesson Service (C11) ──────────────────────────────────────
const lesson = await lessonService.create(lessonData);

void audit.log({
  eventType:   AuditEventType.LESSON_CREATED,
  actorId:     instructorId,
  actorRole:   'instructor',
  subjectType: 'lesson',
  subjectId:   lesson.id,
  details: {
    studentId:              lesson.student_id,
    lessonNumber:           lesson.lesson_number,
    lessonDate:             lesson.lesson_date,
    totalMinutes:           lesson.total_minutes,
    competenciesTaught:     lesson.competencies_taught,
    competenciesAssessed:   lesson.competencies_assessed,
    competenciesAchieved:   [...lesson.competencies_achieved_auto, ...lesson.competencies_achieved_manual],
  },
  context: { ...ctx, gpsLatitude: lessonData.gpsLatitude, gpsLongitude: lessonData.gpsLongitude },
});

// ── Example 3: Competency Engine (C12) — AWAITED (compliance critical) ───
// For competency sign-off, we await the audit write before returning success
// because regulators need to see this in the chain.
await audit.log({
  eventType:   AuditEventType.COMPETENCY_SIGNED_OFF,
  actorId:     instructorId,
  actorRole:   'instructor',
  subjectType: 'student_competency',
  subjectId:   competencyRecord.id,
  details: {
    studentId:    studentId,
    taskNumber:   competencyRecord.task_number,
    taskName:     competencyRecord.task_name,
    status:       'competent',
    transmission: competencyRecord.transmission,
    lessonId:     competencyRecord.lesson_id,
    signatureId:  competencyRecord.signature_id,
  },
  context: ctx,
});

// ── Example 4: System event (no actor) ───────────────────────────────────
void audit.log({
  eventType:   AuditEventType.PACKAGE_EXPIRED,
  actorId:     undefined,
  actorRole:   'system',
  subjectType: 'student_package',
  subjectId:   expiredPackage.id,
  details: {
    studentId:      expiredPackage.student_id,
    packageId:      expiredPackage.package_id,
    creditsWasted:  expiredPackage.credits_remaining,
    expiredAt:      expiredPackage.expires_at,
  },
});

// ── Example 5: Permission denied (security critical) ─────────────────────
void audit.log({
  eventType: AuditEventType.PERMISSION_DENIED,
  actorId:   requestingUserId,
  actorRole: requestingUserRole,
  subjectType: 'lesson',
  subjectId:   attemptedLessonId,
  severity:  'warning',
  details: {
    attemptedAction: 'view_private_notes',
    deniedReason:    'RBAC: student role cannot access private_notes',
    endpoint:        '/api/v1/lessons/:id/private-notes',
  },
  context: ctx,
});
```

---

## 7. API Endpoints

### 7.1 GET /api/v1/admin/audit

Query the audit log. Admin only (enforced by Clerk middleware checking `role === 'admin'`).

**Route:** `src/app/api/v1/admin/audit/route.ts`

**Auth:** `👑 Admin`

**Query Parameters:**

| Param | Type | Description |
|---|---|---|
| `event_type` | `AuditEventType` | Filter by specific event type |
| `actor_id` | `string` | Filter by Clerk user ID of actor |
| `actor_role` | `string` | Filter by actor role |
| `subject_type` | `string` | Filter by subject type (`lesson`, `booking`, etc.) |
| `subject_id` | `UUID` | Filter by specific subject record |
| `severity` | `info \| warning \| critical` | Filter by severity |
| `date_from` | `ISO 8601` | Start of date range (inclusive) |
| `date_to` | `ISO 8601` | End of date range (inclusive) |
| `cursor` | `string` | Pagination cursor (opaque, from previous response) |
| `limit` | `integer` | Page size, 1–100. Default: 50 |

**Implementation:**

```typescript
// src/app/api/v1/admin/audit/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { auditLog } from '@/db/schema/compliance';
import { and, eq, gte, lte, desc, gt } from 'drizzle-orm';
import { audit, AuditEventType, extractAuditContext } from '@/lib/audit';

export async function GET(req: NextRequest) {
  // Auth: admin only
  const { sessionClaims } = await auth();
  if (sessionClaims?.role !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, { status: 403 });
  }

  const url = new URL(req.url);
  const params = {
    eventType:   url.searchParams.get('event_type'),
    actorId:     url.searchParams.get('actor_id'),
    actorRole:   url.searchParams.get('actor_role'),
    subjectType: url.searchParams.get('subject_type'),
    subjectId:   url.searchParams.get('subject_id'),
    severity:    url.searchParams.get('severity'),
    dateFrom:    url.searchParams.get('date_from'),
    dateTo:      url.searchParams.get('date_to'),
    cursor:      url.searchParams.get('cursor'),
    limit:       Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100),
  };

  // Build filter conditions
  const conditions = [];
  if (params.eventType)   conditions.push(eq(auditLog.eventType,   params.eventType));
  if (params.actorId)     conditions.push(eq(auditLog.actorId,     params.actorId));
  if (params.actorRole)   conditions.push(eq(auditLog.actorRole,   params.actorRole));
  if (params.subjectType) conditions.push(eq(auditLog.subjectType, params.subjectType));
  if (params.subjectId)   conditions.push(eq(auditLog.subjectId,   params.subjectId));
  if (params.severity)    conditions.push(eq(auditLog.severity,    params.severity));
  if (params.dateFrom)    conditions.push(gte(auditLog.createdAt, new Date(params.dateFrom)));
  if (params.dateTo)      conditions.push(lte(auditLog.createdAt, new Date(params.dateTo)));

  // Cursor-based pagination — cursor is the `created_at` of the last record seen
  if (params.cursor) {
    try {
      const cursorDate = new Date(Buffer.from(params.cursor, 'base64url').toString());
      conditions.push(lte(auditLog.createdAt, cursorDate));
    } catch {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid cursor' } }, { status: 422 });
    }
  }

  const rows = await db
    .select()
    .from(auditLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(params.limit + 1); // Fetch one extra to determine has_more

  const hasMore = rows.length > params.limit;
  const data    = hasMore ? rows.slice(0, params.limit) : rows;
  const nextCursor = hasMore
    ? Buffer.from(data[data.length - 1].createdAt.toISOString()).toString('base64url')
    : null;

  return NextResponse.json({
    data,
    meta: {
      cursor:     nextCursor,
      has_more:   hasMore,
      count:      data.length,
    },
  });
}
```

**Example Response:**

```json
{
  "data": [
    {
      "id": "uuid",
      "event_type": "LESSON_COMPLETED",
      "severity": "info",
      "actor_id": "user_2abc...",
      "actor_role": "instructor",
      "subject_type": "lesson",
      "subject_id": "uuid",
      "details": {
        "student_id": "uuid",
        "lesson_number": 12,
        "total_minutes": 60,
        "competencies_achieved": [3, 7]
      },
      "ip_address": "203.0.113.1",
      "previous_hash": "a3f1...",
      "record_hash": "8bc2...",
      "created_at": "2026-03-15T09:30:00Z"
    }
  ],
  "meta": {
    "cursor": "MjAyNi0wMy0xNVQwOTozMDowMFo=",
    "has_more": true,
    "count": 50
  }
}
```

---

### 7.2 GET /api/v1/admin/audit/verify

Walk the entire hash chain from oldest to newest. Report first broken link. This is the tool auditors use to confirm the log has not been tampered with.

**Route:** `src/app/api/v1/admin/audit/verify/route.ts`

**Auth:** `👑 Admin`

**Implementation:**

```typescript
// src/lib/audit/verify.ts

import { createHash } from 'crypto';
import { db } from '@/db';
import { auditLog } from '@/db/schema/compliance';
import { asc } from 'drizzle-orm';

export interface ChainVerificationResult {
  valid:        boolean;
  totalRecords: number;
  verifiedAt:   string;
  brokenLinks:  BrokenLink[];
  firstRecordId: string | null;
  lastRecordId:  string | null;
}

export interface BrokenLink {
  recordId:         string;
  position:         number;        // 1-based position in chain
  expectedHash:     string;        // What we computed
  storedHash:       string;        // What was in the DB
  previousRecordId: string | null;
}

export async function verifyAuditChain(): Promise<ChainVerificationResult> {
  // Fetch all records ordered oldest-first
  // For very large chains (10k+ records), consider streaming or batch processing
  const records = await db
    .select()
    .from(auditLog)
    .orderBy(asc(auditLog.createdAt));

  const brokenLinks: BrokenLink[] = [];
  let previousHash: string | null = null;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    // Recompute the expected hash using the same algorithm as the DB trigger
    const inputString =
      record.eventType
      + (record.actorId ?? 'SYSTEM')
      + (record.subjectId ?? 'NULL')
      + record.createdAt.toISOString().replace('T', ' ').replace('Z', '+00')  // match PostgreSQL ::TEXT format
      + (previousHash ?? 'GENESIS');

    const expectedHash = createHash('sha256').update(inputString).digest('hex');

    if (expectedHash !== record.recordHash) {
      brokenLinks.push({
        recordId:         record.id,
        position:         i + 1,
        expectedHash,
        storedHash:       record.recordHash,
        previousRecordId: i > 0 ? records[i - 1].id : null,
      });
    }

    // Regardless of whether this record's hash is valid, advance the chain
    // so we can detect all broken links, not just the first one
    previousHash = record.recordHash;
  }

  return {
    valid:         brokenLinks.length === 0,
    totalRecords:  records.length,
    verifiedAt:    new Date().toISOString(),
    brokenLinks,
    firstRecordId: records.length > 0 ? records[0].id : null,
    lastRecordId:  records.length > 0 ? records[records.length - 1].id : null,
  };
}
```

```typescript
// src/app/api/v1/admin/audit/verify/route.ts

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { verifyAuditChain } from '@/lib/audit/verify';
import { audit, AuditEventType } from '@/lib/audit';

export async function GET() {
  const { sessionClaims } = await auth();
  if (sessionClaims?.role !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, { status: 403 });
  }

  const result = await verifyAuditChain();

  // Log the verification itself to the audit trail
  void audit.log({
    eventType:   result.valid
                   ? AuditEventType.AUDIT_CHAIN_VERIFIED
                   : AuditEventType.AUDIT_CHAIN_INTEGRITY_FAILED,
    actorId:     sessionClaims.sub as string,
    actorRole:   'admin',
    subjectType: 'audit_log',
    severity:    result.valid ? 'info' : 'critical',
    details: {
      totalRecords:    result.totalRecords,
      brokenLinkCount: result.brokenLinks.length,
      brokenLinks:     result.valid ? [] : result.brokenLinks.slice(0, 10), // Cap to avoid huge payloads
    },
  });

  return NextResponse.json({ data: result }, { status: result.valid ? 200 : 200 });
  // Always 200 — the `valid` field tells the client the result
}
```

**Example Response (valid chain):**

```json
{
  "data": {
    "valid": true,
    "total_records": 1842,
    "verified_at": "2026-04-01T11:00:00Z",
    "broken_links": [],
    "first_record_id": "uuid",
    "last_record_id": "uuid"
  }
}
```

**Example Response (tampered chain):**

```json
{
  "data": {
    "valid": false,
    "total_records": 1842,
    "verified_at": "2026-04-01T11:00:00Z",
    "broken_links": [
      {
        "record_id": "uuid",
        "position": 714,
        "expected_hash": "3a9f...",
        "stored_hash": "99ab...",
        "previous_record_id": "uuid"
      }
    ],
    "first_record_id": "uuid",
    "last_record_id": "uuid"
  }
}
```

---

### 7.3 GET /api/v1/admin/audit/export

Export audit log to CSV or JSON for ACT Government auditors. Supports all the same filters as the query endpoint. Writing this export event to the audit trail itself is mandatory.

**Route:** `src/app/api/v1/admin/audit/export/route.ts`

**Auth:** `👑 Admin`

**Query Parameters:** All of the same filters as `/admin/audit` (see §7.1), plus:

| Param | Type | Description |
|---|---|---|
| `format` | `csv \| json` | Export format. Default: `json` |

**Implementation:**

```typescript
// src/app/api/v1/admin/audit/export/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { auditLog } from '@/db/schema/compliance';
import { and, eq, gte, lte, desc } from 'drizzle-orm';
import { audit, AuditEventType, extractAuditContext } from '@/lib/audit';

export async function GET(req: NextRequest) {
  const { sessionClaims } = await auth();
  if (sessionClaims?.role !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'json';

  // Build filters (same as query endpoint — refactor to shared helper)
  const conditions = [];
  const eventType   = url.searchParams.get('event_type');
  const actorId     = url.searchParams.get('actor_id');
  const subjectType = url.searchParams.get('subject_type');
  const subjectId   = url.searchParams.get('subject_id');
  const dateFrom    = url.searchParams.get('date_from');
  const dateTo      = url.searchParams.get('date_to');

  if (eventType)   conditions.push(eq(auditLog.eventType,   eventType));
  if (actorId)     conditions.push(eq(auditLog.actorId,     actorId));
  if (subjectType) conditions.push(eq(auditLog.subjectType, subjectType));
  if (subjectId)   conditions.push(eq(auditLog.subjectId,   subjectId));
  if (dateFrom)    conditions.push(gte(auditLog.createdAt,  new Date(dateFrom)));
  if (dateTo)      conditions.push(lte(auditLog.createdAt,  new Date(dateTo)));

  const rows = await db
    .select()
    .from(auditLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt));

  // Log the export action — ALWAYS. Exporter, timestamp, filters, record count.
  void audit.log({
    eventType:   AuditEventType.AUDIT_LOG_EXPORTED,
    actorId:     sessionClaims.sub as string,
    actorRole:   'admin',
    subjectType: 'audit_log',
    severity:    'critical',
    details: {
      format,
      filters:      { eventType, actorId, subjectType, subjectId, dateFrom, dateTo },
      recordCount:  rows.length,
      exportedAt:   new Date().toISOString(),
    },
    context: extractAuditContext(req),
  });

  if (format === 'csv') {
    const csv = toCSV(rows);
    return new NextResponse(csv, {
      headers: {
        'Content-Type':        'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="nexdrive-audit-${Date.now()}.csv"`,
      },
    });
  }

  return new NextResponse(JSON.stringify({ data: rows, meta: { count: rows.length } }, null, 2), {
    headers: {
      'Content-Type':        'application/json',
      'Content-Disposition': `attachment; filename="nexdrive-audit-${Date.now()}.json"`,
    },
  });
}

function toCSV(rows: typeof auditLog.$inferSelect[]): string {
  const headers = [
    'id', 'event_type', 'severity', 'actor_id', 'actor_role',
    'subject_type', 'subject_id', 'details', 'ip_address',
    'previous_hash', 'record_hash', 'created_at',
  ];

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };

  const csvRows = rows.map(row =>
    headers.map(h => escape(row[h as keyof typeof row])).join(',')
  );

  return [headers.join(','), ...csvRows].join('\r\n');
}
```

---

## 8. Performance Considerations

### 8.1 Fire-and-Forget Pattern

All services should call `void audit.log(...)` (fire-and-forget) unless there is a specific compliance requirement to await the write. This means audit logging adds approximately 0ms to the observed request latency.

The only cases where you `await audit.log(...)` are:
- Competency sign-off (`COMPETENCY_SIGNED_OFF`) — regulators require this to be in the chain before the API response confirms success
- Certificate issuance (`CERTIFICATE_ISSUED`) — same rationale
- E-signature capture (`SIGNATURE_CAPTURED`) — the signature is the audit record

Everything else: fire-and-forget.

### 8.2 Index Strategy

The four indexes on `audit_log` (`event_type`, `actor_id`, `subject_type+subject_id`, `created_at DESC`) cover all query patterns in the admin UI and export endpoint. No full-table scans.

The `created_at DESC` index makes cursor-based pagination O(log n) regardless of table size.

### 8.3 Hash Chain Trigger Contention

The `compute_audit_hash()` trigger does a `SELECT record_hash FROM audit_log ORDER BY created_at DESC LIMIT 1` on every insert. At NexDrive's scale (< 1,000 audit events/day), this is negligible. If the platform ever hits 10k+ events/day, consider a dedicated sequence table or a Redis-backed hash pointer to avoid the per-insert table scan.

### 8.4 Verification Performance

`verifyAuditChain()` fetches all records into memory. At 1,842 records with ~500 bytes each, that's under 1MB — fine. At 100k records it becomes slow. Add a limit or streaming strategy when the table exceeds ~50k rows. Add a TODO comment in the code.

### 8.5 Export Performance

For large exports (>10k rows), stream the response rather than buffering. The current implementation buffers. Mark as a TODO for v2 when scale demands it.

---

## 9. What Gets Audited — Per-Table Summary

| Table | Events Audited | Severity |
|---|---|---|
| `lessons` | CREATED, UPDATED (draft), SIGNED (x2), COMPLETED, CORRECTION_CREATED, DISPUTED | info / warning / critical |
| `bookings` | CREATED, CONFIRMED, CANCELLED, RESCHEDULED, STARTED, COMPLETED, NO_SHOW | info / warning |
| `student_competencies` | TAUGHT, ASSESSED, ACHIEVED, NOT_YET_COMPETENT, SIGNED_OFF | info |
| `signatures` | CAPTURED | info |
| `payments` | CREATED, PROCESSED, FAILED, REFUNDED, DISPUTED | info / warning / critical |
| `packages` / `student_packages` | PURCHASED, CREDIT_USED, EXPIRED | info / warning |
| `vouchers` | CREATED, REDEEMED | info |
| `students` | ENROLLED, STATUS_CHANGED, INSTRUCTOR_CHANGED, PRIVACY_UPDATED, COMPLETED | info / warning |
| `profiles` | CREATED, UPDATED | info |
| `parents` / `parent_student_links` | INVITED, ACCEPTED, REVOKED, PERMISSIONS_UPDATED | info / warning |
| `instructors` | ONBOARDED, STATUS_CHANGED, VERIFIED | info / warning |
| `availability_rules` / `availability_overrides` | UPDATED, CREATED | info |
| `contacts` | CREATED, UPDATED, LIFECYCLE_CHANGED, CONVERTED | info |
| `lesson_bridge_forms` | GENERATED | info |
| `certificates` | ELIGIBILITY_CHECKED, ISSUED | info |
| `call_logs` | CALL_COMPLETED | info |
| `conversations` / `messages` | SMS_CONVERSATION_STARTED, AI_HANDOFF_TRIGGERED | info / warning |
| Auth events | USER_LOGIN, USER_LOGOUT, USER_LOGIN_FAILED, ROLE_CHANGED, SUSPENDED | info / warning / critical |
| RBAC enforcement | PERMISSION_DENIED | warning |
| `private_notes` | ACCESSED (instructor reads their own notes) | info |
| System/Admin | SERVICE_UPDATED, PACKAGE_UPDATED, SYSTEM_CONFIG_CHANGED, ADMIN_ACTION | warning / critical |
| Webhooks | WEBHOOK_RECEIVED (Twilio, Stripe, etc. — raw payload in details) | info |
| Audit trail | EXPORTED, CHAIN_VERIFIED, CHAIN_INTEGRITY_FAILED | info / critical |

---

## 10. Retention Policy

Audit logs are **retained indefinitely**. There is no TTL, no archival job, and no purge schedule.

- The ACT Government may audit NexDrive Academy at any time
- Lessons and competencies recorded today may be reviewed years later
- No data sovereignty issue: all logs are in Neon Sydney

Neon's storage pricing is based on stored data. At the expected volume (< 5,000 events/month), 1 year of logs is approximately 30MB — negligible cost.

If storage becomes a concern in future, logs older than 7 years can be archived to Cloudflare R2 as compressed JSONL and removed from the hot database. This requires a separate spec and Rob's explicit approval.

---

## 11. Security Considerations

### Database Triggers as Last Line of Defence

The `prevent_audit_log_mutation()` trigger fires at the PostgreSQL level — it cannot be bypassed by application code, ORM bugs, or misconfigured API routes. Even a direct database connection used by a malicious actor cannot UPDATE or DELETE audit records (assuming normal DB user privileges; the trigger runs with SECURITY DEFINER if elevated privileges are needed).

### Private Notes Never in Audit Details

When auditing `PRIVATE_NOTE_ACCESSED`, the `details` field must include `{ noteId, studentId, instructorId }` — never the note content itself. Audit logs are visible to admins and exported to regulators; private note content must remain confidential.

### Sensitive Data in Details

Never include in `details`:
- Raw payment card data
- Passwords, tokens, secrets
- Full signature images (use signature_id)
- Private note content

Safe to include:
- Record IDs (UUIDs)
- Status values and status changes (before/after)
- Numeric values (amounts in cents, minutes, task numbers)
- Metadata (GPS, device info)
- Computed results (was eligible: true/false)

### Export Gating

Audit log exports are only available to the `admin` role, and every export is itself logged at `critical` severity. This creates an audit trail of the audit trail — regulators can see exactly who accessed the log and when.

---

## 12. Drizzle ORM — Select Helper (Type Safety)

```typescript
// src/lib/audit/index.ts (barrel export)

export { auditLog as audit } from './service';
export { AuditEventType, AuditSeverity, EVENT_SEVERITY_DEFAULTS } from './event-types';
export { extractAuditContext, extractAuditActor } from './service';
export { verifyAuditChain } from './verify';
export type { AuditParams, AuditContext, ChainVerificationResult } from './service';
```

---

## 13. Environment Variables

No new environment variables required. Audit service uses the existing `db` connection from SPEC-01.

---

## 14. Testing Strategy

### Unit Tests

- `audit.log()` must not throw even when the database is unavailable (mock `db.insert` to throw and assert no exception propagates)
- `audit.log()` with all fields specified persists the correct values (assert the insert call receives correct data)
- `EVENT_SEVERITY_DEFAULTS` covers every value in `AuditEventType` (exhaustive type check)

### Integration Tests (against Neon dev branch)

- Insert an audit record → verify `previous_hash` and `record_hash` are set by trigger
- Insert a sequence of 10 records → run `verifyAuditChain()` → assert `valid: true`
- Manually corrupt one record's `record_hash` in the dev DB → run `verifyAuditChain()` → assert the broken link is found at the correct position
- Attempt to UPDATE an audit record → assert trigger raises exception
- Attempt to DELETE an audit record → assert trigger raises exception

### API Tests

- `GET /api/v1/admin/audit` with `instructor` session → 403
- `GET /api/v1/admin/audit` with `admin` session + valid filters → 200 with correct pagination
- `GET /api/v1/admin/audit/verify` with valid chain → `{ valid: true }`
- `GET /api/v1/admin/audit/export?format=csv` → valid CSV with correct headers
- `GET /api/v1/admin/audit/export?format=json` → `AUDIT_LOG_EXPORTED` event written to log after response

### Compliance Smoke Test

Run this after every deployment to production:

```typescript
// scripts/verify-audit-chain.ts
// Run with: npx tsx scripts/verify-audit-chain.ts

import { verifyAuditChain } from '@/lib/audit/verify';

const result = await verifyAuditChain();
if (!result.valid) {
  console.error('❌ AUDIT CHAIN INTEGRITY FAILED:', result.brokenLinks);
  process.exit(1);
}
console.log(`✅ Audit chain valid. ${result.totalRecords} records verified.`);
```

---

## 15. Dependencies on Other Components

| Component | Dependency |
|---|---|
| SPEC-01 (DB Schema) | `audit_log` table and triggers must exist before this component can be used |
| SPEC-02 (Auth/RBAC) | Admin-role check on all three API endpoints |
| All other components | Import `{ audit }` from `@/lib/audit` and call `audit.log()` |

**This component has no runtime dependencies on other NexDrive components.** It is a foundational service that other components depend on, not the other way around. It can be built and deployed in Phase 0 or early Phase 3, before the components it serves are built — their calls to `audit.log()` will simply accumulate records once the table exists.

---

## 16. Implementation Order

1. Confirm SPEC-01 migrations are applied — `audit_log` table, `compute_audit_hash` trigger, `prevent_audit_log_mutation` trigger
2. Write and export `AuditEventType` enum and `EVENT_SEVERITY_DEFAULTS` (`event-types.ts`)
3. Implement `audit.log()` service function (`service.ts`)
4. Write unit tests for `audit.log()` — especially the "never throws" guarantee
5. Implement chain verification (`verify.ts`)
6. Implement three API route handlers (`audit/route.ts`, `audit/verify/route.ts`, `audit/export/route.ts`)
7. Write API tests
8. Add calls to `audit.log()` in each service as those components are built (C08, C10, C11, C12, C13, etc.)
9. Add compliance smoke test script to CI/CD pipeline

---

*End of SPEC-15: Audit Trail (C14)*

*Next specs in Phase 3: SPEC-16 Private Notes (C15), SPEC-17 Lesson Bridge Forms (C25)*
