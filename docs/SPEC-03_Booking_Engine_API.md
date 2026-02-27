# SPEC-03: Booking Engine API (C08)
### NexDrive Academy — Phase 1 Revenue Engine
**Version:** 1.0  
**Date:** 20 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.2, §5.2; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC)  
**Phase:** 1 (Revenue Engine — Weeks 3-6)  
**Estimated Effort:** 8-10 days  

---

## 1. Overview

The Booking Engine is NexDrive Academy's scheduling brain. It exposes REST APIs that the Booking Widget (C02), Voice Agent (C05), SMS Agent (C06), Student Portal (C03), and Admin Panel (C19) all call to check availability, reserve slots, confirm bookings, and manage the booking lifecycle.

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **All times are Australia/Canberra (AEST/AEDT).** Database stores `TIMESTAMPTZ` (UTC internally), but all slot computation and display is in `Australia/Canberra`. DST transitions must be handled correctly.
2. **No double-booking.** Enforced at three levels: application logic, Redis slot lock, and the `idx_bookings_no_overlap` unique index.
3. **10-minute reservation hold.** Temporary Redis lock prevents two users from booking the same slot simultaneously. Reservation expires automatically.
4. **24-hour cancellation policy.** Cancellations with less than 24 hours notice may incur a fee (configurable).
5. **Buffer time between lessons.** Configurable per instructor (`default_buffer_minutes`, default 15 min). The buffer is added AFTER each booking, reducing the next available start time.
6. **Max lessons per day.** Configurable per instructor (`max_lessons_per_day`, default 8). Enforced during availability computation.
7. **Multi-instructor from day one.** Every query scopes by `instructor_id`.
8. **Monetary values in integer cents.** `price_cents`, `amount_cents` — never floating point.
9. **Event-driven side effects.** Booking mutations emit events; notification/CRM listeners handle downstream effects.
10. **Bookings are updatable** (not append-only like lessons). Status transitions follow a strict state machine.

### 1.2 Booking Status State Machine

```
                    ┌──────────────────────────────────────────────┐
                    │                                              │
                    ▼                                              │
  ┌─────────┐   ┌──────────┐   ┌─────────────┐   ┌───────────┐  │
  │ pending  │──►│confirmed │──►│ in_progress │──►│ completed │  │
  └────┬─────┘   └────┬─────┘   └─────────────┘   └───────────┘  │
       │              │                                            │
       │              ├──────────────────────────────────────────►─┤
       │              │                                            │
       ▼              ▼                                            │
  ┌─────────┐   ┌──────────┐                                      │
  │cancelled│   │ no_show  │                                      │
  └─────────┘   └──────────┘                                      │
       ▲                                                           │
       │              ┌─────────────┐                              │
       └──────────────│ rescheduled │◄─────────────────────────────┘
                      └─────────────┘
```

**Valid Transitions:**

| From | To | Who Can Trigger | Conditions |
|------|----|-----------------|------------|
| `pending` | `confirmed` | System (on payment/confirm) | Payment received or waived |
| `pending` | `cancelled` | Student, Instructor, Admin | Any time while pending |
| `confirmed` | `in_progress` | Instructor | At or near scheduled start time |
| `confirmed` | `cancelled` | Student, Instructor, Admin | Subject to cancellation policy |
| `confirmed` | `no_show` | Instructor, Admin | After scheduled end time |
| `confirmed` | `rescheduled` | Student, Instructor, Admin | Creates new booking, marks old as rescheduled |
| `in_progress` | `completed` | Instructor | After lesson delivery |
| `in_progress` | `cancelled` | Instructor, Admin | Emergency mid-lesson cancel (rare) |

**Terminal states:** `completed`, `cancelled`, `no_show`, `rescheduled`. No transitions out of these.

---

## 2. File Structure

```
src/
├── lib/
│   ├── booking/
│   │   ├── index.ts                        # Barrel export
│   │   ├── types.ts                        # All booking-related types + Zod schemas
│   │   ├── errors.ts                       # Booking-specific error classes
│   │   ├── constants.ts                    # Status values, defaults, config
│   │   ├── availability.service.ts         # Core availability computation algorithm
│   │   ├── booking.service.ts              # Booking CRUD + lifecycle operations
│   │   ├── reservation.service.ts          # Redis slot reservation system
│   │   ├── services.service.ts             # Service type queries
│   │   ├── state-machine.ts                # Booking status transition validator
│   │   ├── cancellation-policy.ts          # Cancellation policy enforcement
│   │   └── events.ts                       # Event emission for booking lifecycle
│   └── events/
│       ├── index.ts                        # EventBus singleton
│       └── types.ts                        # AppEvent union type
├── app/
│   └── api/
│       └── v1/
│           ├── booking/
│           │   ├── availability/
│           │   │   └── route.ts            # GET /api/v1/booking/availability
│           │   ├── services/
│           │   │   └── route.ts            # GET /api/v1/booking/services
│           │   ├── reserve/
│           │   │   └── route.ts            # POST /api/v1/booking/reserve
│           │   └── confirm/
│           │       └── route.ts            # POST /api/v1/booking/confirm
│           └── bookings/
│               ├── route.ts                # GET /api/v1/bookings
│               ├── upcoming/
│               │   └── route.ts            # GET /api/v1/bookings/upcoming
│               └── [id]/
│                   ├── route.ts            # GET, PATCH /api/v1/bookings/:id
│                   ├── cancel/
│                   │   └── route.ts        # POST /api/v1/bookings/:id/cancel
│                   ├── start/
│                   │   └── route.ts        # POST /api/v1/bookings/:id/start
│                   └── complete/
│                       └── route.ts        # POST /api/v1/bookings/:id/complete
└── __tests__/
    └── lib/
        └── booking/
            ├── availability.service.test.ts
            ├── booking.service.test.ts
            ├── reservation.service.test.ts
            ├── state-machine.test.ts
            ├── cancellation-policy.test.ts
            └── integration/
                ├── booking-flow.test.ts     # Full reserve→confirm→start→complete
                ├── concurrent-booking.test.ts
                └── timezone.test.ts
```

---

## 3. Dependencies

```bash
# Already installed via SPEC-01 and SPEC-02
# drizzle-orm, @neondatabase/serverless, @clerk/nextjs, zod, @upstash/redis

# New dependencies for SPEC-03
npm install date-fns                    # Date arithmetic, timezone support
npm install date-fns-tz                 # IANA timezone conversions
npm install uuid                        # UUID generation for reservations
npm install eventemitter3               # Lightweight event bus (per ADR-005)

npm install -D @types/uuid
```

### 3.1 Environment Variables

Add to `.env.local` (in addition to SPEC-01 and SPEC-02 variables):

```env
# Upstash Redis (already configured in SPEC-02 for rate limiting)
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxx...

# Booking Engine Config
BOOKING_RESERVATION_TTL_SECONDS=600     # 10 minutes
BOOKING_DEFAULT_INSTRUCTOR_ID=xxx       # Rob's instructor UUID (single-instructor phase)
BOOKING_TIMEZONE=Australia/Canberra     # IANA timezone
```

---

## 4. Type Definitions & Zod Schemas

### File: `src/lib/booking/types.ts`

```typescript
// ============================================================
// NexDrive Academy — Booking Engine Types & Validation Schemas
// Reference: System Architecture v1.1 §4.2.2
// ============================================================

import { z } from 'zod';

// ---- Constants ----

export const BOOKING_TIMEZONE = 'Australia/Canberra';

export const BOOKING_STATUS = [
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
] as const;
export type BookingStatus = (typeof BOOKING_STATUS)[number];

export const PAYMENT_STATUS = [
  'unpaid',
  'deposit_paid',
  'paid',
  'package_credit',
  'refunded',
  'waived',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const BOOKED_VIA = [
  'website',
  'phone',
  'sms',
  'voice_agent',
  'admin',
  'walk_in',
] as const;
export type BookedVia = (typeof BOOKED_VIA)[number];

export const SERVICE_CATEGORY = [
  'lesson',
  'co_lesson',
  'assessment',
  'special',
] as const;

// ---- Zod Schemas: Request Validation ----

/**
 * GET /api/v1/booking/availability
 * Public endpoint — no auth required.
 */
export const GetAvailabilitySchema = z.object({
  instructor_id: z.string().uuid(),
  service_id: z.string().uuid(),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
});
export type GetAvailabilityInput = z.infer<typeof GetAvailabilitySchema>;

/**
 * GET /api/v1/booking/services
 * Public endpoint — no auth required.
 */
export const GetServicesSchema = z.object({
  category: z.enum(SERVICE_CATEGORY).optional(),
  instructor_id: z.string().uuid().optional(),
});
export type GetServicesInput = z.infer<typeof GetServicesSchema>;

/**
 * POST /api/v1/booking/reserve
 * Public endpoint — creates a 10-minute hold on a slot.
 */
export const ReserveSlotSchema = z.object({
  instructor_id: z.string().uuid(),
  service_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Must be HH:mm format (24h)'),
  contact: z.object({
    first_name: z.string().min(1).max(100),
    last_name: z.string().min(1).max(100),
    phone: z
      .string()
      .regex(/^\+61\d{9}$/, 'Must be AU format: +61XXXXXXXXX'),
    email: z.string().email(),
  }),
  booking_notes: z.string().max(500).optional(),
  booked_via: z.enum(BOOKED_VIA).default('website'),
});
export type ReserveSlotInput = z.infer<typeof ReserveSlotSchema>;

/**
 * POST /api/v1/booking/confirm
 * Public endpoint — confirms a reserved booking.
 */
export const ConfirmBookingSchema = z.object({
  reservation_id: z.string().uuid(),
  payment_intent_id: z.string().optional(),
  voucher_code: z.string().optional(),
});
export type ConfirmBookingInput = z.infer<typeof ConfirmBookingSchema>;

/**
 * GET /api/v1/bookings
 * Authenticated — role-scoped list.
 */
export const ListBookingsSchema = z.object({
  status: z.enum(BOOKING_STATUS).optional(),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  instructor_id: z.string().uuid().optional(),
  student_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListBookingsInput = z.infer<typeof ListBookingsSchema>;

/**
 * PATCH /api/v1/bookings/:id (reschedule)
 * Authenticated — student, instructor, or admin.
 */
export const RescheduleBookingSchema = z.object({
  new_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  new_start_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Must be HH:mm format (24h)'),
  reason: z.string().min(1).max(500),
});
export type RescheduleBookingInput = z.infer<typeof RescheduleBookingSchema>;

/**
 * POST /api/v1/bookings/:id/cancel
 */
export const CancelBookingSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type CancelBookingInput = z.infer<typeof CancelBookingSchema>;

/**
 * GET /api/v1/bookings/upcoming
 */
export const UpcomingBookingsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type UpcomingBookingsInput = z.infer<typeof UpcomingBookingsSchema>;

// ---- Response Shapes ----

export interface TimeSlot {
  start: string; // "09:00" (local time HH:mm)
  end: string;   // "10:00"
  available: boolean;
}

export interface DayAvailability {
  date: string; // "2026-03-01" (YYYY-MM-DD)
  day_of_week: number; // 0=Sun, 6=Sat
  times: TimeSlot[];
}

export interface AvailabilityResponse {
  instructor_id: string;
  service_id: string;
  service_name: string;
  duration_minutes: number;
  date_range: { from: string; to: string };
  slots: DayAvailability[];
  timezone: string; // "Australia/Canberra"
}

export interface ServiceResponse {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  duration_minutes: number;
  price_cents: number;
  category: string;
  is_bookable_online: boolean;
  min_notice_hours: number;
  color: string | null;
  sort_order: number;
}

export interface ReservationResponse {
  reservation_id: string;
  expires_at: string; // ISO 8601
  booking_summary: {
    instructor_name: string;
    service_name: string;
    date: string;
    start_time: string;
    end_time: string;
    duration_minutes: number;
    price_cents: number;
    currency: string;
  };
}

export interface BookingResponse {
  id: string;
  instructor_id: string;
  student_id: string | null;
  contact_id: string;
  service_id: string;
  scheduled_date: string;
  start_time: string; // ISO 8601
  end_time: string;   // ISO 8601
  duration_minutes: number;
  pickup_address: string | null;
  suburb: string | null;
  status: BookingStatus;
  payment_status: PaymentStatus;
  amount_cents: number;
  booked_via: string;
  booking_notes: string | null;
  // admin_notes EXCLUDED from student/parent responses
  lesson_id: string | null;
  created_at: string;
  updated_at: string;
  // Expanded relations (included when fetching single booking)
  service?: ServiceResponse;
  instructor?: { id: string; name: string };
  student?: { id: string; name: string } | null;
  contact?: { id: string; name: string; phone: string; email: string };
}

// ---- Reservation Redis Data ----

export interface ReservationData {
  reservation_id: string;
  instructor_id: string;
  service_id: string;
  date: string; // YYYY-MM-DD
  start_time: string; // HH:mm (local)
  end_time: string;   // HH:mm (local)
  duration_minutes: number;
  price_cents: number;
  contact: {
    first_name: string;
    last_name: string;
    phone: string;
    email: string;
  };
  booking_notes?: string;
  booked_via: string;
  created_at: string; // ISO 8601
  expires_at: string; // ISO 8601
}
```

---

## 5. Booking-Specific Error Classes

### File: `src/lib/booking/errors.ts`

```typescript
// ============================================================
// NexDrive Academy — Booking Error Types
// Reference: System Architecture v1.1 §4.3
// ============================================================

import { ApiError } from '@/lib/auth/errors';

/**
 * 409 — Slot is no longer available (booked by someone else, or reservation expired).
 * Arch doc error code: BOOKING_CONFLICT
 */
export class BookingConflictError extends ApiError {
  constructor(
    message = 'This time slot is no longer available.',
    details?: {
      conflicting_booking_id?: string;
      suggested_alternatives?: Array<{ date: string; start_time: string }>;
    }
  ) {
    super('BOOKING_CONFLICT', message, 409, details);
    this.name = 'BookingConflictError';
  }
}

/**
 * 422 — Insufficient notice for booking or cancellation.
 * Arch doc error code: BOOKING_TOO_LATE
 */
export class BookingTooLateError extends ApiError {
  constructor(
    message = 'Insufficient notice for this action.',
    details?: {
      required_notice_hours?: number;
      actual_notice_hours?: number;
      cancellation_fee_cents?: number;
    }
  ) {
    super('BOOKING_TOO_LATE', message, 422, details);
    this.name = 'BookingTooLateError';
  }
}

/**
 * 422 — Invalid booking status transition.
 */
export class InvalidTransitionError extends ApiError {
  constructor(from: string, to: string) {
    super(
      'INVALID_TRANSITION',
      `Cannot transition booking from '${from}' to '${to}'.`,
      422,
      { from, to }
    );
    this.name = 'InvalidTransitionError';
  }
}

/**
 * 404 — Reservation not found or expired.
 */
export class ReservationExpiredError extends ApiError {
  constructor() {
    super(
      'RESERVATION_EXPIRED',
      'This reservation has expired. Please select a new time slot.',
      404
    );
    this.name = 'ReservationExpiredError';
  }
}

/**
 * 422 — Max lessons per day exceeded.
 */
export class MaxLessonsExceededError extends ApiError {
  constructor(max: number) {
    super(
      'MAX_LESSONS_EXCEEDED',
      `Instructor has reached the maximum of ${max} lessons for this day.`,
      422,
      { max_lessons_per_day: max }
    );
    this.name = 'MaxLessonsExceededError';
  }
}

/**
 * 422 — Service not found or not bookable online.
 */
export class ServiceNotBookableError extends ApiError {
  constructor(serviceId: string) {
    super(
      'SERVICE_NOT_BOOKABLE',
      'This service is not available for online booking.',
      422,
      { service_id: serviceId }
    );
    this.name = 'ServiceNotBookableError';
  }
}
```

---

## 6. Booking Constants

### File: `src/lib/booking/constants.ts`

```typescript
// ============================================================
// NexDrive Academy — Booking Engine Constants
// ============================================================

export const BOOKING_TIMEZONE = 'Australia/Canberra';

/** Default slot granularity for availability display (minutes). */
export const SLOT_GRANULARITY_MINUTES = 15;

/** Redis key prefix for slot reservations. */
export const REDIS_RESERVATION_PREFIX = 'booking:reservation:';

/** Redis key prefix for slot locks (instructor+date+time). */
export const REDIS_SLOT_LOCK_PREFIX = 'booking:slot:';

/** Default reservation TTL (seconds). Override via env. */
export const DEFAULT_RESERVATION_TTL = 600; // 10 minutes

/** Maximum date range for availability query (days). */
export const MAX_AVAILABILITY_RANGE_DAYS = 60;

/** Minimum booking notice for most services (hours). Uses service.min_notice_hours when set. */
export const DEFAULT_MIN_NOTICE_HOURS = 24;

/** Cancellation policy: notice threshold (hours before lesson). */
export const CANCELLATION_NOTICE_HOURS = 24;

/** Cancellation fee when insufficient notice (cents). 0 = no fee, implement later. */
export const LATE_CANCELLATION_FEE_CENTS = 0;

/** Maximum results for upcoming bookings endpoint. */
export const MAX_UPCOMING_LIMIT = 20;

/**
 * Terminal booking statuses — no further transitions allowed.
 */
export const TERMINAL_STATUSES = [
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
] as const;
```

---

## 7. Booking Status State Machine

### File: `src/lib/booking/state-machine.ts`

```typescript
// ============================================================
// NexDrive Academy — Booking Status State Machine
// Reference: SPEC-03 §1.2
// ============================================================

import type { BookingStatus } from './types';
import type { Role } from '@/lib/auth/types';
import { InvalidTransitionError } from './errors';
import { ForbiddenError } from '@/lib/auth/errors';

/**
 * Defines valid transitions and who can trigger them.
 * Key = "from:to", value = array of roles allowed.
 */
const TRANSITIONS: Record<string, Role[]> = {
  'pending:confirmed': ['admin', 'instructor'], // System-triggered on payment, but role check is instructor/admin
  'pending:cancelled': ['admin', 'instructor', 'student'],
  'confirmed:in_progress': ['admin', 'instructor'],
  'confirmed:cancelled': ['admin', 'instructor', 'student'],
  'confirmed:no_show': ['admin', 'instructor'],
  'confirmed:rescheduled': ['admin', 'instructor', 'student'],
  'in_progress:completed': ['admin', 'instructor'],
  'in_progress:cancelled': ['admin', 'instructor'], // Emergency only
};

/**
 * Validates whether a status transition is allowed and whether the
 * given role has permission to perform it.
 * 
 * @throws InvalidTransitionError if transition is not in the state machine
 * @throws ForbiddenError if the role cannot trigger this transition
 */
export function validateTransition(
  from: BookingStatus,
  to: BookingStatus,
  role: Role
): void {
  const key = `${from}:${to}`;
  const allowedRoles = TRANSITIONS[key];

  if (!allowedRoles) {
    throw new InvalidTransitionError(from, to);
  }

  if (!allowedRoles.includes(role)) {
    throw new ForbiddenError(
      `Role '${role}' cannot transition a booking from '${from}' to '${to}'.`
    );
  }
}

/**
 * Returns all valid next statuses for a given current status and role.
 * Useful for UI: show only actionable buttons.
 */
export function getValidNextStatuses(
  current: BookingStatus,
  role: Role
): BookingStatus[] {
  const results: BookingStatus[] = [];
  for (const [key, allowedRoles] of Object.entries(TRANSITIONS)) {
    const [from, to] = key.split(':') as [BookingStatus, BookingStatus];
    if (from === current && allowedRoles.includes(role)) {
      results.push(to);
    }
  }
  return results;
}

/**
 * Check if a booking status is terminal (no further transitions).
 */
export function isTerminalStatus(status: BookingStatus): boolean {
  return ['completed', 'cancelled', 'no_show', 'rescheduled'].includes(status);
}
```

---

## 8. Event Emissions

### File: `src/lib/events/types.ts`

```typescript
// ============================================================
// NexDrive Academy — Application Event Types
// Reference: System Architecture v1.1 §5.2
// ============================================================

import type { BookingResponse } from '@/lib/booking/types';

export type AppEvent =
  | { type: 'BOOKING_CREATED'; data: BookingResponse }
  | { type: 'BOOKING_CONFIRMED'; data: BookingResponse }
  | { type: 'BOOKING_CANCELLED'; data: BookingResponse & { cancelled_by: string; reason: string } }
  | { type: 'BOOKING_RESCHEDULED'; data: { old_booking: BookingResponse; new_booking: BookingResponse } }
  | { type: 'BOOKING_STARTED'; data: BookingResponse }
  | { type: 'BOOKING_COMPLETED'; data: BookingResponse }
  | { type: 'BOOKING_NO_SHOW'; data: BookingResponse }
  | { type: 'CONTACT_CREATED'; data: { id: string; phone: string; email: string; source: string } }
  // Future events (defined here for type completeness, implemented in later specs)
  | { type: 'LESSON_COMPLETED'; data: unknown }
  | { type: 'COMPETENCY_ACHIEVED'; data: unknown }
  | { type: 'PAYMENT_RECEIVED'; data: unknown }
  | { type: 'CERTIFICATE_ISSUED'; data: unknown }
  | { type: 'CALLBACK_REQUESTED'; data: unknown };
```

### File: `src/lib/events/index.ts`

```typescript
// ============================================================
// NexDrive Academy — In-Process Event Bus
// Reference: ADR-005 (internal event bus over message queue)
// Can be replaced with BullMQ/SQS when scaling beyond ~100 events/day.
// ============================================================

import EventEmitter from 'eventemitter3';
import type { AppEvent } from './types';

class EventBus {
  private emitter = new EventEmitter();

  emit(event: AppEvent): void {
    console.log(`[EVENT] ${event.type}`, JSON.stringify(event.data).slice(0, 200));
    this.emitter.emit(event.type, event.data);
  }

  on<T extends AppEvent['type']>(
    eventType: T,
    handler: (data: Extract<AppEvent, { type: T }>['data']) => void | Promise<void>
  ): void {
    this.emitter.on(eventType, async (data) => {
      try {
        await handler(data);
      } catch (error) {
        // Event handlers must not crash the main flow.
        // Log and continue. Sentry will capture.
        console.error(`[EVENT] Handler error for ${eventType}:`, error);
      }
    });
  }

  off<T extends AppEvent['type']>(
    eventType: T,
    handler: (...args: unknown[]) => void
  ): void {
    this.emitter.off(eventType, handler);
  }
}

/** Singleton event bus instance. */
export const eventBus = new EventBus();
```

### File: `src/lib/booking/events.ts`

```typescript
// ============================================================
// NexDrive Academy — Booking Event Registration
// Subscribers: Notification Engine (C18), CRM (C09), Waitlist (C22)
// ============================================================

import { eventBus } from '@/lib/events';

/**
 * Register all booking-related event listeners.
 * Called once at application startup (e.g., in instrumentation.ts or layout).
 *
 * Phase 1 listeners are stubs that log — real implementations come when
 * C09 (CRM) and C18 (Notification Engine) are built.
 */
export function registerBookingEventListeners(): void {
  // BOOKING_CREATED → C18: send confirmation SMS + email, C09: update contact last_contact_at
  eventBus.on('BOOKING_CREATED', async (data) => {
    console.log(`[BOOKING_EVENT] BOOKING_CREATED → booking ${data.id}`);
    // TODO Phase 1: Call notificationService.sendBookingConfirmation(data)
    // TODO Phase 1: Call crmService.updateLastContact(data.contact_id)
  });

  // BOOKING_CANCELLED → C18: notify, C22: check waitlist for freed slot
  eventBus.on('BOOKING_CANCELLED', async (data) => {
    console.log(`[BOOKING_EVENT] BOOKING_CANCELLED → booking ${data.id}`);
    // TODO Phase 1: Call notificationService.sendBookingCancelled(data)
    // TODO Phase 1: Call waitlistService.checkFreedSlot(data)
  });

  // BOOKING_RESCHEDULED → C18: notify both parties
  eventBus.on('BOOKING_RESCHEDULED', async (data) => {
    console.log(`[BOOKING_EVENT] BOOKING_RESCHEDULED → old: ${data.old_booking.id}, new: ${data.new_booking.id}`);
    // TODO Phase 1: Call notificationService.sendBookingRescheduled(data)
  });

  // BOOKING_COMPLETED → C11: trigger lesson recording prompt
  eventBus.on('BOOKING_COMPLETED', async (data) => {
    console.log(`[BOOKING_EVENT] BOOKING_COMPLETED → booking ${data.id}`);
    // TODO Phase 3: Trigger lesson creation in instructor workstation
  });
}
```

---

## 9. Core Algorithm: Availability Computation

### File: `src/lib/booking/availability.service.ts`

This is the most complex piece of the booking engine. The algorithm computes available time slots for a given instructor, service, and date range.

```typescript
// ============================================================
// NexDrive Academy — Availability Computation Service
// Reference: System Architecture v1.1 §4.2.2
//
// Algorithm Overview:
//   For each date in the requested range:
//     1. Get base availability from recurring rules for that day-of-week
//     2. Subtract blocked overrides (holidays, sick days)
//     3. Add available overrides (extra hours)
//     4. Subtract existing confirmed bookings + their buffer time
//     5. Subtract active Redis reservations (10-min holds)
//     6. Apply max_lessons_per_day cap
//     7. Slice remaining windows into service-duration-sized slots
//     8. Filter out slots with insufficient advance notice
//     9. Return available slots
// ============================================================

import { db } from '@/db';
import {
  availabilityRules,
  availabilityOverrides,
  bookings,
  services,
  instructors,
} from '@/db/schema';
import { and, eq, gte, lte, between, inArray, not, isNull, or, sql } from 'drizzle-orm';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import {
  startOfDay,
  endOfDay,
  addDays,
  addMinutes,
  isBefore,
  isAfter,
  differenceInMinutes,
  getDay,
  parseISO,
  format,
  max as dateMax,
  min as dateMin,
  differenceInHours,
} from 'date-fns';
import {
  BOOKING_TIMEZONE,
  SLOT_GRANULARITY_MINUTES,
  MAX_AVAILABILITY_RANGE_DAYS,
  REDIS_SLOT_LOCK_PREFIX,
} from './constants';
import type {
  GetAvailabilityInput,
  DayAvailability,
  TimeSlot,
  AvailabilityResponse,
} from './types';
import { NotFoundError, ValidationError } from '@/lib/auth/errors';
import { redis } from '@/lib/rate-limit'; // Upstash Redis client from SPEC-02

// ---- Internal Types ----

/** A continuous block of time where the instructor is potentially available. */
interface TimeWindow {
  start: Date; // UTC Date object
  end: Date;   // UTC Date object
}

// ---- Main Entry Point ----

/**
 * Computes available booking slots for a given instructor + service + date range.
 *
 * @param input - Validated query params from GetAvailabilitySchema
 * @returns AvailabilityResponse with per-day slot arrays
 */
export async function computeAvailability(
  input: GetAvailabilityInput
): Promise<AvailabilityResponse> {
  const { instructor_id, service_id, date_from, date_to } = input;

  // 1. Validate date range
  const fromDate = parseISO(date_from);
  const toDate = parseISO(date_to);

  if (isAfter(fromDate, toDate)) {
    throw new ValidationError('date_from must be before date_to');
  }

  const daySpan = Math.ceil(
    (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)
  ) + 1;
  if (daySpan > MAX_AVAILABILITY_RANGE_DAYS) {
    throw new ValidationError(
      `Date range cannot exceed ${MAX_AVAILABILITY_RANGE_DAYS} days.`
    );
  }

  // 2. Load instructor configuration
  const instructor = await db
    .select({
      id: instructors.id,
      default_buffer_minutes: instructors.default_buffer_minutes,
      max_lessons_per_day: instructors.max_lessons_per_day,
      first_name: sql<string>`(SELECT first_name FROM profiles WHERE id = ${instructors.profile_id})`,
      last_name: sql<string>`(SELECT last_name FROM profiles WHERE id = ${instructors.profile_id})`,
    })
    .from(instructors)
    .where(and(eq(instructors.id, instructor_id), eq(instructors.status, 'active')))
    .limit(1);

  if (instructor.length === 0) {
    throw new NotFoundError('Instructor');
  }

  const inst = instructor[0];

  // 3. Load service
  const service = await db
    .select()
    .from(services)
    .where(
      and(
        eq(services.id, service_id),
        eq(services.is_active, true),
        eq(services.is_bookable_online, true)
      )
    )
    .limit(1);

  if (service.length === 0) {
    throw new NotFoundError('Service');
  }

  const svc = service[0];

  // 4. Load recurring availability rules for this instructor
  //    (active rules whose effective period overlaps with our date range)
  const rules = await db
    .select()
    .from(availabilityRules)
    .where(
      and(
        eq(availabilityRules.instructor_id, instructor_id),
        eq(availabilityRules.is_active, true),
        lte(availabilityRules.effective_from, toDate),
        or(
          isNull(availabilityRules.effective_until),
          gte(availabilityRules.effective_until, fromDate)
        )
      )
    );

  // 5. Load overrides for the date range
  const overrides = await db
    .select()
    .from(availabilityOverrides)
    .where(
      and(
        eq(availabilityOverrides.instructor_id, instructor_id),
        gte(availabilityOverrides.date, fromDate),
        lte(availabilityOverrides.date, toDate)
      )
    );

  // 6. Load existing bookings that could conflict
  //    (non-cancelled/non-rescheduled bookings in the date range)
  const existingBookings = await db
    .select({
      id: bookings.id,
      start_time: bookings.start_time,
      end_time: bookings.end_time,
      scheduled_date: bookings.scheduled_date,
      status: bookings.status,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.instructor_id, instructor_id),
        gte(bookings.scheduled_date, fromDate),
        lte(bookings.scheduled_date, toDate),
        not(inArray(bookings.status, ['cancelled', 'rescheduled']))
      )
    );

  // 7. Load active Redis reservations for this instructor+date range
  const activeReservations = await getActiveReservations(
    instructor_id,
    date_from,
    date_to
  );

  // 8. Compute day-by-day
  const slots: DayAvailability[] = [];
  const now = new Date();

  for (let dayOffset = 0; dayOffset < daySpan; dayOffset++) {
    const currentDate = addDays(fromDate, dayOffset);
    const dateStr = format(currentDate, 'yyyy-MM-dd');
    const dayOfWeek = getDay(currentDate); // 0=Sun, 6=Sat

    // Step A: Get base windows from recurring rules
    let windows = getBaseWindows(rules, currentDate, dayOfWeek);

    // Step B: Apply overrides
    windows = applyOverrides(windows, overrides, currentDate);

    // Step C: Subtract existing bookings (with buffer)
    windows = subtractBookings(
      windows,
      existingBookings,
      currentDate,
      inst.default_buffer_minutes
    );

    // Step D: Subtract active reservations (with buffer)
    windows = subtractReservations(
      windows,
      activeReservations,
      currentDate,
      inst.default_buffer_minutes
    );

    // Step E: Count confirmed bookings for max_lessons_per_day
    const confirmedCountForDay = existingBookings.filter(
      (b) => format(b.scheduled_date, 'yyyy-MM-dd') === dateStr
    ).length;
    const remainingSlots = inst.max_lessons_per_day - confirmedCountForDay;

    // Step F: Slice windows into service-duration slots
    const daySlots = sliceIntoSlots(
      windows,
      svc.duration_minutes,
      SLOT_GRANULARITY_MINUTES,
      remainingSlots,
      now,
      currentDate,
      svc.min_notice_hours
    );

    slots.push({
      date: dateStr,
      day_of_week: dayOfWeek,
      times: daySlots,
    });
  }

  return {
    instructor_id,
    service_id,
    service_name: svc.name,
    duration_minutes: svc.duration_minutes,
    date_range: { from: date_from, to: date_to },
    slots,
    timezone: BOOKING_TIMEZONE,
  };
}

// ---- Step A: Get Base Windows from Recurring Rules ----

/**
 * For a given date, find all active recurring rules that match the day-of-week
 * and whose effective_from/effective_until bracket this date.
 * Returns an array of UTC time windows.
 */
function getBaseWindows(
  rules: Array<{
    day_of_week: number;
    start_time: string; // TIME as "HH:mm:ss" from Postgres
    end_time: string;
    effective_from: Date;
    effective_until: Date | null;
  }>,
  date: Date,
  dayOfWeek: number
): TimeWindow[] {
  const windows: TimeWindow[] = [];
  const dateStr = format(date, 'yyyy-MM-dd');

  for (const rule of rules) {
    // Match day of week
    if (rule.day_of_week !== dayOfWeek) continue;

    // Check effective period
    if (isAfter(rule.effective_from, date)) continue;
    if (rule.effective_until && isBefore(rule.effective_until, date)) continue;

    // Convert local time to UTC for this specific date
    // rule.start_time is like "08:00:00", we combine with the date
    const localStart = fromZonedTime(
      parseISO(`${dateStr}T${rule.start_time}`),
      BOOKING_TIMEZONE
    );
    const localEnd = fromZonedTime(
      parseISO(`${dateStr}T${rule.end_time}`),
      BOOKING_TIMEZONE
    );

    windows.push({ start: localStart, end: localEnd });
  }

  // Merge overlapping windows (if multiple rules for same day)
  return mergeWindows(windows);
}

// ---- Step B: Apply Overrides ----

/**
 * Process overrides for a given date:
 * - 'blocked' overrides REMOVE time (subtract from windows)
 * - 'available' overrides ADD time (union with windows)
 *
 * Full-day blocks (start_time/end_time both null) remove all availability.
 */
function applyOverrides(
  windows: TimeWindow[],
  overrides: Array<{
    date: Date;
    start_time: string | null;
    end_time: string | null;
    override_type: string;
  }>,
  currentDate: Date
): TimeWindow[] {
  const dateStr = format(currentDate, 'yyyy-MM-dd');
  const dayOverrides = overrides.filter(
    (o) => format(o.date, 'yyyy-MM-dd') === dateStr
  );

  let result = [...windows];

  for (const override of dayOverrides) {
    if (override.override_type === 'blocked') {
      if (!override.start_time && !override.end_time) {
        // Full-day block — remove ALL availability
        result = [];
      } else if (override.start_time && override.end_time) {
        // Partial block — subtract this window
        const blockStart = fromZonedTime(
          parseISO(`${dateStr}T${override.start_time}`),
          BOOKING_TIMEZONE
        );
        const blockEnd = fromZonedTime(
          parseISO(`${dateStr}T${override.end_time}`),
          BOOKING_TIMEZONE
        );
        result = subtractWindow(result, { start: blockStart, end: blockEnd });
      }
    } else if (override.override_type === 'available') {
      if (override.start_time && override.end_time) {
        // Add extra availability
        const addStart = fromZonedTime(
          parseISO(`${dateStr}T${override.start_time}`),
          BOOKING_TIMEZONE
        );
        const addEnd = fromZonedTime(
          parseISO(`${dateStr}T${override.end_time}`),
          BOOKING_TIMEZONE
        );
        result.push({ start: addStart, end: addEnd });
        result = mergeWindows(result);
      }
    }
  }

  return result;
}

// ---- Step C: Subtract Existing Bookings ----

/**
 * For each confirmed/in-progress booking on this date, subtract the booking's
 * time window PLUS the instructor's buffer time from available windows.
 */
function subtractBookings(
  windows: TimeWindow[],
  allBookings: Array<{
    start_time: Date;
    end_time: Date;
    scheduled_date: Date;
    status: string;
  }>,
  currentDate: Date,
  bufferMinutes: number
): TimeWindow[] {
  const dateStr = format(currentDate, 'yyyy-MM-dd');
  const dayBookings = allBookings.filter(
    (b) => format(b.scheduled_date, 'yyyy-MM-dd') === dateStr
  );

  let result = [...windows];

  for (const booking of dayBookings) {
    // The "occupied" window is booking start → booking end + buffer
    const occupiedEnd = addMinutes(booking.end_time, bufferMinutes);
    result = subtractWindow(result, {
      start: booking.start_time,
      end: occupiedEnd,
    });
  }

  return result;
}

// ---- Step D: Subtract Active Reservations ----

/**
 * Same as subtracting bookings, but for temporary Redis holds.
 */
function subtractReservations(
  windows: TimeWindow[],
  reservations: Array<{
    start: Date;
    end: Date;
    date: string;
  }>,
  currentDate: Date,
  bufferMinutes: number
): TimeWindow[] {
  const dateStr = format(currentDate, 'yyyy-MM-dd');
  const dayReservations = reservations.filter((r) => r.date === dateStr);

  let result = [...windows];

  for (const res of dayReservations) {
    const occupiedEnd = addMinutes(res.end, bufferMinutes);
    result = subtractWindow(result, { start: res.start, end: occupiedEnd });
  }

  return result;
}

// ---- Step F: Slice Windows into Slots ----

/**
 * Takes available time windows and slices them into bookable slots.
 *
 * @param windows - Available time windows after all subtractions
 * @param durationMinutes - Service duration (e.g., 60 min)
 * @param granularity - Slot start alignment (e.g., every 15 min)
 * @param remainingLessons - How many more lessons allowed today
 * @param now - Current UTC time (for min_notice filtering)
 * @param currentDate - The date being computed
 * @param minNoticeHours - Minimum hours notice required
 */
function sliceIntoSlots(
  windows: TimeWindow[],
  durationMinutes: number,
  granularity: number,
  remainingLessons: number,
  now: Date,
  currentDate: Date,
  minNoticeHours: number
): TimeSlot[] {
  if (remainingLessons <= 0) return [];

  const slots: TimeSlot[] = [];
  const minStartTime = addMinutes(now, minNoticeHours * 60);
  let slotsAdded = 0;

  for (const window of windows) {
    // Align to granularity boundaries
    let cursor = alignToGranularity(window.start, granularity);

    // If alignment pushed before window start, jump forward
    if (isBefore(cursor, window.start)) {
      cursor = addMinutes(cursor, granularity);
    }

    while (slotsAdded < remainingLessons) {
      const slotEnd = addMinutes(cursor, durationMinutes);

      // Slot must fit within the window
      if (isAfter(slotEnd, window.end)) break;

      // Convert to local time for display
      const localStart = toZonedTime(cursor, BOOKING_TIMEZONE);
      const localEnd = toZonedTime(slotEnd, BOOKING_TIMEZONE);

      const available = !isBefore(cursor, minStartTime);

      slots.push({
        start: format(localStart, 'HH:mm'),
        end: format(localEnd, 'HH:mm'),
        available,
      });

      if (available) slotsAdded++;
      cursor = addMinutes(cursor, granularity);
    }
  }

  return slots;
}

// ---- Utility Functions ----

/**
 * Merge overlapping or adjacent time windows into minimal set.
 */
function mergeWindows(windows: TimeWindow[]): TimeWindow[] {
  if (windows.length <= 1) return windows;

  // Sort by start time
  const sorted = [...windows].sort(
    (a, b) => a.start.getTime() - b.start.getTime()
  );
  const merged: TimeWindow[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.start.getTime() <= last.end.getTime()) {
      // Overlapping or adjacent — extend
      last.end = dateMax([last.end, current.end]);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Subtract a time block from a set of windows.
 * Returns new windows with the block removed (may split windows).
 */
function subtractWindow(
  windows: TimeWindow[],
  block: TimeWindow
): TimeWindow[] {
  const result: TimeWindow[] = [];

  for (const window of windows) {
    // No overlap — keep window as is
    if (
      block.end.getTime() <= window.start.getTime() ||
      block.start.getTime() >= window.end.getTime()
    ) {
      result.push(window);
      continue;
    }

    // Partial overlap — may produce 0, 1, or 2 fragments
    if (isBefore(window.start, block.start)) {
      // Left fragment: window.start → block.start
      result.push({ start: window.start, end: block.start });
    }

    if (isBefore(block.end, window.end)) {
      // Right fragment: block.end → window.end
      result.push({ start: block.end, end: window.end });
    }
  }

  return result;
}

/**
 * Align a time to the nearest granularity boundary (rounding up).
 */
function alignToGranularity(time: Date, granularity: number): Date {
  const minutes = time.getMinutes();
  const remainder = minutes % granularity;
  if (remainder === 0) return time;
  return addMinutes(time, granularity - remainder);
}

/**
 * Get all active Redis reservations for an instructor in a date range.
 * Scans REDIS_SLOT_LOCK_PREFIX keys.
 */
async function getActiveReservations(
  instructorId: string,
  dateFrom: string,
  dateTo: string
): Promise<Array<{ start: Date; end: Date; date: string }>> {
  // Pattern: booking:slot:{instructor_id}:{date}:{start_time}
  // Redis SCAN is expensive — but reservation count is low (< 50 at any time).
  // We use a sorted set per instructor instead of key scanning.
  const setKey = `${REDIS_SLOT_LOCK_PREFIX}${instructorId}:active`;

  try {
    const members = await redis.zrange(setKey, 0, -1);
    const results: Array<{ start: Date; end: Date; date: string }> = [];

    for (const member of members) {
      // Member format: "{date}|{startHHmm}|{endHHmm}|{reservationId}"
      const parts = (member as string).split('|');
      if (parts.length < 3) continue;

      const [date, startTime, endTime] = parts;
      if (date < dateFrom || date > dateTo) continue;

      const start = fromZonedTime(
        parseISO(`${date}T${startTime}:00`),
        BOOKING_TIMEZONE
      );
      const end = fromZonedTime(
        parseISO(`${date}T${endTime}:00`),
        BOOKING_TIMEZONE
      );
      results.push({ start, end, date });
    }

    return results;
  } catch {
    // Redis failure should not break availability checks — degrade gracefully
    console.error('[AVAILABILITY] Redis unavailable, skipping reservation check');
    return [];
  }
}
```

---

## 10. Slot Reservation System (Redis)

### File: `src/lib/booking/reservation.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Slot Reservation Service
// Implements 10-minute temporary holds to prevent race conditions.
//
// Redis Key Structure:
//   booking:reservation:{reservation_id}  →  JSON ReservationData (TTL: 600s)
//   booking:slot:{instructor_id}:active   →  Sorted Set of active slot holds
//                                             Score = expiry timestamp
//                                             Member = "{date}|{start}|{end}|{resId}"
//
// Race Condition Handling:
//   1. SETNX on slot lock key → if already exists, slot is taken
//   2. Store reservation data with TTL
//   3. Add to instructor's active set with expiry score
//   4. Cleanup: expired members pruned on every read (lazy cleanup)
//      + periodic cleanup via Vercel cron (every 5 min)
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { addMinutes, parseISO, format } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { redis } from '@/lib/rate-limit'; // Upstash Redis client
import {
  REDIS_RESERVATION_PREFIX,
  REDIS_SLOT_LOCK_PREFIX,
  DEFAULT_RESERVATION_TTL,
  BOOKING_TIMEZONE,
} from './constants';
import type { ReserveSlotInput, ReservationData } from './types';
import { BookingConflictError } from './errors';

const RESERVATION_TTL =
  parseInt(process.env.BOOKING_RESERVATION_TTL_SECONDS || '', 10) ||
  DEFAULT_RESERVATION_TTL;

/**
 * Attempt to reserve a slot for 10 minutes.
 *
 * Uses Redis SETNX (set-if-not-exists) for atomic lock acquisition.
 * If the slot is already held, throws BookingConflictError.
 *
 * @returns ReservationData with reservation_id and expiry
 */
export async function reserveSlot(
  input: ReserveSlotInput,
  service: { name: string; duration_minutes: number; price_cents: number },
  instructorName: string
): Promise<ReservationData> {
  const reservationId = uuidv4();
  const now = new Date();
  const expiresAt = addMinutes(now, RESERVATION_TTL / 60);

  // Compute end time from start + duration
  const startLocal = parseISO(`${input.date}T${input.start_time}:00`);
  const endLocal = addMinutes(startLocal, service.duration_minutes);
  const endTime = format(endLocal, 'HH:mm');

  // Slot lock key: unique per instructor+date+time
  const slotLockKey = `${REDIS_SLOT_LOCK_PREFIX}${input.instructor_id}:lock:${input.date}:${input.start_time}`;

  // Atomic: only set if not exists (SETNX equivalent)
  const acquired = await redis.set(slotLockKey, reservationId, {
    nx: true, // Only set if not exists
    ex: RESERVATION_TTL, // Auto-expire
  });

  if (!acquired) {
    throw new BookingConflictError(
      'This time slot is currently held by another customer. Please try a different time.',
      { suggested_alternatives: [] } // TODO: compute nearby alternatives
    );
  }

  // Build reservation data
  const reservationData: ReservationData = {
    reservation_id: reservationId,
    instructor_id: input.instructor_id,
    service_id: input.service_id,
    date: input.date,
    start_time: input.start_time,
    end_time: endTime,
    duration_minutes: service.duration_minutes,
    price_cents: service.price_cents,
    contact: input.contact,
    booking_notes: input.booking_notes,
    booked_via: input.booked_via,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  // Store full reservation data with TTL
  const reservationKey = `${REDIS_RESERVATION_PREFIX}${reservationId}`;
  await redis.set(reservationKey, JSON.stringify(reservationData), {
    ex: RESERVATION_TTL,
  });

  // Add to instructor's active reservations sorted set (for availability computation)
  // Score = expiry timestamp (for easy pruning)
  const activeSetKey = `${REDIS_SLOT_LOCK_PREFIX}${input.instructor_id}:active`;
  const member = `${input.date}|${input.start_time}|${endTime}|${reservationId}`;
  await redis.zadd(activeSetKey, {
    score: expiresAt.getTime(),
    member,
  });

  return reservationData;
}

/**
 * Retrieve a reservation by ID.
 *
 * @returns ReservationData or null if expired/not found
 */
export async function getReservation(
  reservationId: string
): Promise<ReservationData | null> {
  const key = `${REDIS_RESERVATION_PREFIX}${reservationId}`;
  const data = await redis.get(key);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) : (data as ReservationData);
}

/**
 * Consume (delete) a reservation after successful booking confirmation.
 * Also removes the slot lock and active set member.
 */
export async function consumeReservation(
  reservationId: string
): Promise<ReservationData | null> {
  const reservation = await getReservation(reservationId);
  if (!reservation) return null;

  // Delete reservation data
  const reservationKey = `${REDIS_RESERVATION_PREFIX}${reservationId}`;
  await redis.del(reservationKey);

  // Delete slot lock
  const slotLockKey = `${REDIS_SLOT_LOCK_PREFIX}${reservation.instructor_id}:lock:${reservation.date}:${reservation.start_time}`;
  await redis.del(slotLockKey);

  // Remove from active set
  const activeSetKey = `${REDIS_SLOT_LOCK_PREFIX}${reservation.instructor_id}:active`;
  const member = `${reservation.date}|${reservation.start_time}|${reservation.end_time}|${reservationId}`;
  await redis.zrem(activeSetKey, member);

  return reservation;
}

/**
 * Cleanup expired reservations from active sets.
 * Called by Vercel cron job every 5 minutes AND lazily before availability queries.
 */
export async function cleanupExpiredReservations(
  instructorId?: string
): Promise<number> {
  const now = Date.now();
  let cleaned = 0;

  if (instructorId) {
    const key = `${REDIS_SLOT_LOCK_PREFIX}${instructorId}:active`;
    cleaned = await redis.zremrangebyscore(key, 0, now);
  } else {
    // Global cleanup: scan all active sets
    // For a 1-2 instructor operation, this is fine.
    // At scale, use a Vercel cron with instructor list.
    // TODO: iterate instructors from DB
  }

  if (cleaned > 0) {
    console.log(`[RESERVATION] Cleaned ${cleaned} expired reservations`);
  }

  return cleaned;
}
```

---

## 11. Cancellation Policy

### File: `src/lib/booking/cancellation-policy.ts`

```typescript
// ============================================================
// NexDrive Academy — Cancellation Policy Enforcement
// Business Rule: 24-hour notice required for free cancellation.
// ============================================================

import { differenceInHours, parseISO } from 'date-fns';
import {
  CANCELLATION_NOTICE_HOURS,
  LATE_CANCELLATION_FEE_CENTS,
} from './constants';
import { BookingTooLateError } from './errors';

export interface CancellationResult {
  allowed: boolean;
  is_late_cancellation: boolean;
  notice_hours: number;
  cancellation_fee_cents: number;
  refund_eligible: boolean;
  refund_amount_cents: number;
}

/**
 * Evaluate whether a cancellation is allowed and compute any fee/refund.
 *
 * @param startTime - The booking's scheduled start time (ISO 8601)
 * @param amountPaidCents - How much has been paid for this booking
 * @param role - Who is cancelling (admin gets override)
 * @returns CancellationResult with fee/refund details
 */
export function evaluateCancellation(
  startTime: string | Date,
  amountPaidCents: number,
  role: string
): CancellationResult {
  const start = typeof startTime === 'string' ? parseISO(startTime) : startTime;
  const now = new Date();
  const hoursUntilLesson = differenceInHours(start, now);

  // Admin can always cancel with no fee
  if (role === 'admin') {
    return {
      allowed: true,
      is_late_cancellation: false,
      notice_hours: hoursUntilLesson,
      cancellation_fee_cents: 0,
      refund_eligible: amountPaidCents > 0,
      refund_amount_cents: amountPaidCents,
    };
  }

  const isLate = hoursUntilLesson < CANCELLATION_NOTICE_HOURS;

  // If lesson is in the past, cannot cancel (should be marked no_show instead)
  if (hoursUntilLesson < 0) {
    return {
      allowed: false,
      is_late_cancellation: true,
      notice_hours: hoursUntilLesson,
      cancellation_fee_cents: 0,
      refund_eligible: false,
      refund_amount_cents: 0,
    };
  }

  const fee = isLate ? LATE_CANCELLATION_FEE_CENTS : 0;
  const refundAmount = Math.max(0, amountPaidCents - fee);

  return {
    allowed: true,
    is_late_cancellation: isLate,
    notice_hours: hoursUntilLesson,
    cancellation_fee_cents: fee,
    refund_eligible: refundAmount > 0,
    refund_amount_cents: refundAmount,
  };
}

/**
 * Enforce cancellation policy — throws if not allowed.
 */
export function enforceCancellationPolicy(
  startTime: string | Date,
  amountPaidCents: number,
  role: string
): CancellationResult {
  const result = evaluateCancellation(startTime, amountPaidCents, role);

  if (!result.allowed) {
    throw new BookingTooLateError(
      'This booking cannot be cancelled because it is in the past.',
      {
        required_notice_hours: CANCELLATION_NOTICE_HOURS,
        actual_notice_hours: result.notice_hours,
      }
    );
  }

  return result;
}
```

---

## 12. Booking Service Layer

### File: `src/lib/booking/booking.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Booking Service (CRUD + Lifecycle)
// Reference: System Architecture v1.1 §4.2.2
// ============================================================

import { db } from '@/db';
import { bookings, contacts, services, instructors, profiles } from '@/db/schema';
import { and, eq, gte, lte, desc, asc, not, inArray, sql } from 'drizzle-orm';
import { parseISO, format, addMinutes } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { BOOKING_TIMEZONE } from './constants';
import type {
  BookingResponse,
  BookingStatus,
  ListBookingsInput,
  RescheduleBookingInput,
  CancelBookingInput,
  ReservationData,
} from './types';
import type { AuthContext } from '@/lib/auth/types';
import { NotFoundError, ForbiddenError } from '@/lib/auth/errors';
import { BookingConflictError } from './errors';
import { validateTransition } from './state-machine';
import { enforceCancellationPolicy } from './cancellation-policy';
import { consumeReservation } from './reservation.service';
import { eventBus } from '@/lib/events';

// ---- Confirm Booking (from Reservation) ----

/**
 * Confirms a reservation, creating a persistent booking record.
 *
 * Flow:
 * 1. Consume reservation from Redis (atomic — if expired, throws)
 * 2. Upsert contact (CRM record)
 * 3. Insert booking row (the unique index prevents double-booking)
 * 4. Emit BOOKING_CREATED event
 */
export async function confirmBooking(
  reservationId: string,
  paymentIntentId?: string,
  voucherCode?: string
): Promise<BookingResponse> {
  // 1. Consume reservation (deletes from Redis)
  const reservation = await consumeReservation(reservationId);
  if (!reservation) {
    // Import here to avoid circular dependency
    const { ReservationExpiredError } = await import('./errors');
    throw new ReservationExpiredError();
  }

  // 2. Upsert contact in CRM
  const contactId = await upsertContact(reservation);

  // 3. Compute UTC timestamps from local date + time
  const startUtc = fromZonedTime(
    parseISO(`${reservation.date}T${reservation.start_time}:00`),
    BOOKING_TIMEZONE
  );
  const endUtc = fromZonedTime(
    parseISO(`${reservation.date}T${reservation.end_time}:00`),
    BOOKING_TIMEZONE
  );

  // 4. Insert booking
  const paymentStatus = paymentIntentId ? 'paid' : 'unpaid';
  const bookingStatus = paymentIntentId ? 'confirmed' : 'pending';

  try {
    const [booking] = await db
      .insert(bookings)
      .values({
        instructor_id: reservation.instructor_id,
        contact_id: contactId,
        service_id: reservation.service_id,
        scheduled_date: parseISO(reservation.date),
        start_time: startUtc,
        end_time: endUtc,
        duration_minutes: reservation.duration_minutes,
        status: bookingStatus,
        payment_status: paymentStatus,
        amount_cents: reservation.price_cents,
        booked_via: reservation.booked_via,
        booking_notes: reservation.booking_notes || null,
      })
      .returning();

    const response = mapToResponse(booking);

    // 5. Emit event
    eventBus.emit({ type: 'BOOKING_CREATED', data: response });

    return response;
  } catch (error: unknown) {
    // Unique constraint violation on idx_bookings_no_overlap
    if (
      error instanceof Error &&
      error.message.includes('idx_bookings_no_overlap')
    ) {
      throw new BookingConflictError(
        'This slot was booked by someone else. Please select a different time.'
      );
    }
    throw error;
  }
}

// ---- Get Booking by ID ----

export async function getBookingById(
  bookingId: string,
  auth: AuthContext
): Promise<BookingResponse> {
  const booking = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (booking.length === 0) {
    throw new NotFoundError('Booking');
  }

  const b = booking[0];

  // RBAC: scope check
  enforceBookingAccess(b, auth);

  return mapToResponse(b);
}

// ---- List Bookings (Role-Scoped) ----

export async function listBookings(
  input: ListBookingsInput,
  auth: AuthContext
): Promise<{ bookings: BookingResponse[]; cursor: string | null; has_more: boolean }> {
  const conditions = [];

  // Role scoping
  if (auth.role === 'instructor') {
    conditions.push(eq(bookings.instructor_id, auth.instructor_id!));
  } else if (auth.role === 'student') {
    conditions.push(eq(bookings.student_id, auth.student_id!));
  } else if (auth.role === 'parent') {
    // Parents see bookings for their linked students
    // This requires a join through parent_student_links — handled in access control
    throw new ForbiddenError('Parent booking list requires linked student context');
  }
  // Admin sees all

  // Filters
  if (input.status) {
    conditions.push(eq(bookings.status, input.status));
  }
  if (input.date_from) {
    conditions.push(gte(bookings.scheduled_date, parseISO(input.date_from)));
  }
  if (input.date_to) {
    conditions.push(lte(bookings.scheduled_date, parseISO(input.date_to)));
  }
  if (input.instructor_id && auth.role === 'admin') {
    conditions.push(eq(bookings.instructor_id, input.instructor_id));
  }
  if (input.student_id && (auth.role === 'admin' || auth.role === 'instructor')) {
    conditions.push(eq(bookings.student_id, input.student_id));
  }

  // Cursor-based pagination (cursor = created_at ISO string)
  if (input.cursor) {
    conditions.push(lte(bookings.created_at, parseISO(input.cursor)));
  }

  const results = await db
    .select()
    .from(bookings)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(bookings.start_time))
    .limit(input.limit + 1); // Fetch one extra to determine has_more

  const hasMore = results.length > input.limit;
  const page = hasMore ? results.slice(0, input.limit) : results;
  const nextCursor = hasMore
    ? page[page.length - 1].created_at.toISOString()
    : null;

  return {
    bookings: page.map(mapToResponse),
    cursor: nextCursor,
    has_more: hasMore,
  };
}

// ---- Upcoming Bookings ----

export async function getUpcomingBookings(
  limit: number,
  auth: AuthContext
): Promise<BookingResponse[]> {
  const now = new Date();
  const conditions = [
    gte(bookings.start_time, now),
    inArray(bookings.status, ['confirmed', 'pending']),
  ];

  if (auth.role === 'instructor') {
    conditions.push(eq(bookings.instructor_id, auth.instructor_id!));
  } else if (auth.role === 'student') {
    conditions.push(eq(bookings.student_id, auth.student_id!));
  }

  const results = await db
    .select()
    .from(bookings)
    .where(and(...conditions))
    .orderBy(asc(bookings.start_time))
    .limit(limit);

  return results.map(mapToResponse);
}

// ---- Cancel Booking ----

export async function cancelBooking(
  bookingId: string,
  input: CancelBookingInput,
  auth: AuthContext
): Promise<BookingResponse> {
  const booking = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (booking.length === 0) throw new NotFoundError('Booking');
  const b = booking[0];

  enforceBookingAccess(b, auth);
  validateTransition(b.status as BookingStatus, 'cancelled', auth.role);

  // Enforce cancellation policy
  const policyResult = enforceCancellationPolicy(
    b.start_time,
    b.amount_cents,
    auth.role
  );

  const [updated] = await db
    .update(bookings)
    .set({
      status: 'cancelled',
      cancelled_at: new Date(),
      cancelled_by: auth.userId,
      cancellation_reason: input.reason,
    })
    .where(eq(bookings.id, bookingId))
    .returning();

  const response = mapToResponse(updated);

  eventBus.emit({
    type: 'BOOKING_CANCELLED',
    data: {
      ...response,
      cancelled_by: auth.userId,
      reason: input.reason,
    },
  });

  return response;
}

// ---- Reschedule Booking ----

export async function rescheduleBooking(
  bookingId: string,
  input: RescheduleBookingInput,
  auth: AuthContext
): Promise<{ old_booking: BookingResponse; new_booking: BookingResponse }> {
  const booking = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (booking.length === 0) throw new NotFoundError('Booking');
  const b = booking[0];

  enforceBookingAccess(b, auth);
  validateTransition(b.status as BookingStatus, 'rescheduled', auth.role);

  // Compute new UTC times
  const newStartUtc = fromZonedTime(
    parseISO(`${input.new_date}T${input.new_start_time}:00`),
    BOOKING_TIMEZONE
  );
  const newEndUtc = addMinutes(newStartUtc, b.duration_minutes);

  // Mark old booking as rescheduled
  const [oldUpdated] = await db
    .update(bookings)
    .set({
      status: 'rescheduled',
      cancellation_reason: input.reason,
    })
    .where(eq(bookings.id, bookingId))
    .returning();

  // Create new booking
  try {
    const [newBooking] = await db
      .insert(bookings)
      .values({
        instructor_id: b.instructor_id,
        student_id: b.student_id,
        contact_id: b.contact_id,
        service_id: b.service_id,
        scheduled_date: parseISO(input.new_date),
        start_time: newStartUtc,
        end_time: newEndUtc,
        duration_minutes: b.duration_minutes,
        status: 'confirmed',
        payment_status: b.payment_status,
        amount_cents: b.amount_cents,
        booked_via: b.booked_via,
        booking_notes: b.booking_notes,
      })
      .returning();

    const oldResponse = mapToResponse(oldUpdated);
    const newResponse = mapToResponse(newBooking);

    eventBus.emit({
      type: 'BOOKING_RESCHEDULED',
      data: { old_booking: oldResponse, new_booking: newResponse },
    });

    return { old_booking: oldResponse, new_booking: newResponse };
  } catch (error: unknown) {
    // If new slot conflicts, revert the old booking status
    if (
      error instanceof Error &&
      error.message.includes('idx_bookings_no_overlap')
    ) {
      await db
        .update(bookings)
        .set({ status: b.status })
        .where(eq(bookings.id, bookingId));

      throw new BookingConflictError(
        'The new time slot is not available. The original booking has been preserved.'
      );
    }
    throw error;
  }
}

// ---- Start Booking (Instructor) ----

export async function startBooking(
  bookingId: string,
  auth: AuthContext
): Promise<BookingResponse> {
  if (auth.role !== 'instructor' && auth.role !== 'admin') {
    throw new ForbiddenError('Only instructors can start a booking.');
  }

  const booking = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (booking.length === 0) throw new NotFoundError('Booking');
  const b = booking[0];

  enforceBookingAccess(b, auth);
  validateTransition(b.status as BookingStatus, 'in_progress', auth.role);

  const [updated] = await db
    .update(bookings)
    .set({ status: 'in_progress' })
    .where(eq(bookings.id, bookingId))
    .returning();

  const response = mapToResponse(updated);
  eventBus.emit({ type: 'BOOKING_STARTED', data: response });

  return response;
}

// ---- Complete Booking (Instructor) ----

export async function completeBooking(
  bookingId: string,
  auth: AuthContext
): Promise<BookingResponse> {
  if (auth.role !== 'instructor' && auth.role !== 'admin') {
    throw new ForbiddenError('Only instructors can complete a booking.');
  }

  const booking = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (booking.length === 0) throw new NotFoundError('Booking');
  const b = booking[0];

  enforceBookingAccess(b, auth);
  validateTransition(b.status as BookingStatus, 'completed', auth.role);

  const [updated] = await db
    .update(bookings)
    .set({ status: 'completed' })
    .where(eq(bookings.id, bookingId))
    .returning();

  const response = mapToResponse(updated);
  eventBus.emit({ type: 'BOOKING_COMPLETED', data: response });

  return response;
}

// ---- Helper: Upsert CRM Contact ----

async function upsertContact(reservation: ReservationData): Promise<string> {
  // Check if contact exists by phone
  const existing = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.phone, reservation.contact.phone))
    .limit(1);

  if (existing.length > 0) {
    // Update last contact time
    await db
      .update(contacts)
      .set({
        last_contact_at: new Date(),
        total_interactions: sql`${contacts.total_interactions} + 1`,
      })
      .where(eq(contacts.id, existing[0].id));

    return existing[0].id;
  }

  // Create new contact
  const [newContact] = await db
    .insert(contacts)
    .values({
      first_name: reservation.contact.first_name,
      last_name: reservation.contact.last_name,
      phone: reservation.contact.phone,
      email: reservation.contact.email,
      instructor_id: reservation.instructor_id,
      lifecycle_stage: 'lead',
      source: reservation.booked_via === 'website' ? 'website' : reservation.booked_via,
    })
    .returning({ id: contacts.id });

  eventBus.emit({
    type: 'CONTACT_CREATED',
    data: {
      id: newContact.id,
      phone: reservation.contact.phone,
      email: reservation.contact.email,
      source: reservation.booked_via,
    },
  });

  return newContact.id;
}

// ---- Helper: RBAC Access Check ----

function enforceBookingAccess(
  booking: { instructor_id: string; student_id: string | null },
  auth: AuthContext
): void {
  if (auth.role === 'admin') return; // Admin sees all

  if (auth.role === 'instructor') {
    if (booking.instructor_id !== auth.instructor_id) {
      throw new ForbiddenError('You can only access your own bookings.');
    }
    return;
  }

  if (auth.role === 'student') {
    if (booking.student_id !== auth.student_id) {
      throw new ForbiddenError('You can only access your own bookings.');
    }
    return;
  }

  throw new ForbiddenError();
}

// ---- Helper: Map DB Row to Response ----

function mapToResponse(row: Record<string, unknown>): BookingResponse {
  return {
    id: row.id as string,
    instructor_id: row.instructor_id as string,
    student_id: (row.student_id as string) || null,
    contact_id: row.contact_id as string,
    service_id: row.service_id as string,
    scheduled_date: format(row.scheduled_date as Date, 'yyyy-MM-dd'),
    start_time: (row.start_time as Date).toISOString(),
    end_time: (row.end_time as Date).toISOString(),
    duration_minutes: row.duration_minutes as number,
    pickup_address: (row.pickup_address as string) || null,
    suburb: (row.suburb as string) || null,
    status: row.status as BookingStatus,
    payment_status: row.payment_status as string,
    amount_cents: row.amount_cents as number,
    booked_via: row.booked_via as string,
    booking_notes: (row.booking_notes as string) || null,
    // NOTE: admin_notes intentionally excluded from all responses
    // admin_notes is only visible in the admin panel's internal queries
    lesson_id: (row.lesson_id as string) || null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}
```

---

## 13. Services Service

### File: `src/lib/booking/services.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Services Query Service
// ============================================================

import { db } from '@/db';
import { services } from '@/db/schema';
import { eq, asc, and } from 'drizzle-orm';
import type { ServiceResponse, GetServicesInput } from './types';

/**
 * List all active, online-bookable services.
 */
export async function getBookableServices(
  input?: GetServicesInput
): Promise<ServiceResponse[]> {
  const conditions = [
    eq(services.is_active, true),
    eq(services.is_bookable_online, true),
  ];

  if (input?.category) {
    conditions.push(eq(services.category, input.category));
  }

  const results = await db
    .select({
      id: services.id,
      name: services.name,
      slug: services.slug,
      description: services.description,
      duration_minutes: services.duration_minutes,
      price_cents: services.price_cents,
      category: services.category,
      is_bookable_online: services.is_bookable_online,
      min_notice_hours: services.min_notice_hours,
      color: services.color,
      sort_order: services.sort_order,
    })
    .from(services)
    .where(and(...conditions))
    .orderBy(asc(services.sort_order));

  return results;
}
```

---

## 14. API Route Handlers

### 14.1 GET /api/v1/booking/availability

```typescript
// File: src/app/api/v1/booking/availability/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { GetAvailabilitySchema } from '@/lib/booking/types';
import { computeAvailability } from '@/lib/booking/availability.service';
import { cleanupExpiredReservations } from '@/lib/booking/reservation.service';
import { ApiError } from '@/lib/auth/errors';

export async function GET(request: NextRequest) {
  try {
    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const input = GetAvailabilitySchema.parse(searchParams);

    // Lazy cleanup of expired reservations before computing
    await cleanupExpiredReservations(input.instructor_id).catch(() => {});

    const availability = await computeAvailability(input);

    return NextResponse.json({ data: availability });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[AVAILABILITY] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 14.2 GET /api/v1/booking/services

```typescript
// File: src/app/api/v1/booking/services/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { GetServicesSchema } from '@/lib/booking/types';
import { getBookableServices } from '@/lib/booking/services.service';

export async function GET(request: NextRequest) {
  try {
    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const input = GetServicesSchema.parse(searchParams);
    const result = await getBookableServices(input);
    return NextResponse.json({ data: { services: result } });
  } catch (error) {
    console.error('[SERVICES] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 14.3 POST /api/v1/booking/reserve

```typescript
// File: src/app/api/v1/booking/reserve/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { ReserveSlotSchema } from '@/lib/booking/types';
import { reserveSlot } from '@/lib/booking/reservation.service';
import { db } from '@/db';
import { services, instructors, profiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { ApiError, NotFoundError } from '@/lib/auth/errors';
import { ServiceNotBookableError } from '@/lib/booking/errors';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const input = ReserveSlotSchema.parse(body);

    // Load service
    const [svc] = await db
      .select()
      .from(services)
      .where(
        and(
          eq(services.id, input.service_id),
          eq(services.is_active, true)
        )
      )
      .limit(1);

    if (!svc) throw new NotFoundError('Service');
    if (!svc.is_bookable_online) throw new ServiceNotBookableError(input.service_id);

    // Load instructor name for booking summary
    const [inst] = await db
      .select({
        first_name: profiles.first_name,
        last_name: profiles.last_name,
      })
      .from(instructors)
      .innerJoin(profiles, eq(instructors.profile_id, profiles.id))
      .where(eq(instructors.id, input.instructor_id))
      .limit(1);

    if (!inst) throw new NotFoundError('Instructor');
    const instructorName = `${inst.first_name} ${inst.last_name}`;

    // Reserve the slot in Redis
    const reservation = await reserveSlot(
      input,
      {
        name: svc.name,
        duration_minutes: svc.duration_minutes,
        price_cents: svc.price_cents,
      },
      instructorName
    );

    return NextResponse.json({
      data: {
        reservation_id: reservation.reservation_id,
        expires_at: reservation.expires_at,
        booking_summary: {
          instructor_name: instructorName,
          service_name: svc.name,
          date: reservation.date,
          start_time: reservation.start_time,
          end_time: reservation.end_time,
          duration_minutes: svc.duration_minutes,
          price_cents: svc.price_cents,
          currency: 'AUD',
        },
      },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[RESERVE] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 14.4 POST /api/v1/booking/confirm

```typescript
// File: src/app/api/v1/booking/confirm/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { ConfirmBookingSchema } from '@/lib/booking/types';
import { confirmBooking } from '@/lib/booking/booking.service';
import { ApiError } from '@/lib/auth/errors';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const input = ConfirmBookingSchema.parse(body);
    const booking = await confirmBooking(
      input.reservation_id,
      input.payment_intent_id,
      input.voucher_code
    );
    return NextResponse.json({ data: { booking } }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[CONFIRM] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 14.5 Authenticated Booking Routes

```typescript
// File: src/app/api/v1/bookings/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { ListBookingsSchema } from '@/lib/booking/types';
import { listBookings } from '@/lib/booking/booking.service';
import { ApiError } from '@/lib/auth/errors';

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(); // From SPEC-02
    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const input = ListBookingsSchema.parse(searchParams);
    const result = await listBookings(input, auth);

    return NextResponse.json({
      data: result.bookings,
      meta: {
        cursor: result.cursor,
        has_more: result.has_more,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[LIST_BOOKINGS] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

```typescript
// File: src/app/api/v1/bookings/[id]/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { getBookingById, rescheduleBooking } from '@/lib/booking/booking.service';
import { RescheduleBookingSchema } from '@/lib/booking/types';
import { ApiError } from '@/lib/auth/errors';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext();
    const booking = await getBookingById(params.id, auth);
    return NextResponse.json({ data: booking });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[GET_BOOKING] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext();
    const body = await request.json();
    const input = RescheduleBookingSchema.parse(body);
    const result = await rescheduleBooking(params.id, input, auth);

    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[RESCHEDULE] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

```typescript
// File: src/app/api/v1/bookings/[id]/cancel/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { cancelBooking } from '@/lib/booking/booking.service';
import { CancelBookingSchema } from '@/lib/booking/types';
import { ApiError } from '@/lib/auth/errors';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext();
    const body = await request.json();
    const input = CancelBookingSchema.parse(body);
    const booking = await cancelBooking(params.id, input, auth);
    return NextResponse.json({ data: booking });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[CANCEL] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

```typescript
// File: src/app/api/v1/bookings/[id]/start/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { startBooking } from '@/lib/booking/booking.service';
import { ApiError } from '@/lib/auth/errors';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext();
    const booking = await startBooking(params.id, auth);
    return NextResponse.json({ data: booking });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[START] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

```typescript
// File: src/app/api/v1/bookings/[id]/complete/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { completeBooking } from '@/lib/booking/booking.service';
import { ApiError } from '@/lib/auth/errors';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext();
    const booking = await completeBooking(params.id, auth);
    return NextResponse.json({ data: booking });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[COMPLETE] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

```typescript
// File: src/app/api/v1/bookings/upcoming/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { getUpcomingBookings } from '@/lib/booking/booking.service';
import { UpcomingBookingsSchema } from '@/lib/booking/types';
import { ApiError } from '@/lib/auth/errors';

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const input = UpcomingBookingsSchema.parse(searchParams);
    const result = await getUpcomingBookings(input.limit, auth);
    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[UPCOMING] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

---

## 15. No-Overlap Constraint: `idx_bookings_no_overlap`

The database enforces a unique index that prevents double-booking at the PostgreSQL level:

```sql
CREATE UNIQUE INDEX idx_bookings_no_overlap ON bookings(instructor_id, start_time) 
  WHERE status NOT IN ('cancelled', 'rescheduled');
```

**How it works:**

This is a partial unique index. It guarantees that for any given instructor, no two bookings with an "active" status (`pending`, `confirmed`, `in_progress`, `completed`, `no_show`) can share the same `start_time`. The `WHERE` clause excludes cancelled and rescheduled bookings from the uniqueness check, meaning a slot can be re-used after cancellation.

**Three levels of defence against double-booking:**

1. **Application level (availability service):** The availability algorithm subtracts existing bookings before returning slots. Users should never see an occupied slot as available.

2. **Redis level (reservation service):** The SETNX-based slot lock prevents two concurrent reservation attempts from succeeding. Only the first `SET ... NX` wins; the second gets `BookingConflictError`.

3. **Database level (unique index):** Even if the application and Redis layers both fail (edge case: Redis goes down, two requests process simultaneously), the unique index guarantees the database rejects the second INSERT. The service layer catches this constraint violation and converts it to `BookingConflictError`.

**Why `start_time` and not a range overlap check?**

Because our slot system uses fixed-duration services aligned to a time grid, each booking's `start_time` is unique per instructor. Two bookings with different durations starting at the same time are still a conflict. The simple unique constraint on `(instructor_id, start_time)` is sufficient and more performant than a range overlap exclusion constraint.

**Limitation:** This index does not prevent overlapping bookings where start times differ but time ranges overlap (e.g., a 120-min booking at 9:00 and a 60-min booking at 10:00). This is handled by the availability algorithm (application level) which subtracts the full duration + buffer, not just the start time. The database constraint is a last-resort safety net, not the primary enforcement mechanism.

---

## 16. Test Specifications

### 16.1 Availability Service Tests

```typescript
// File: src/__tests__/lib/booking/availability.service.test.ts

describe('computeAvailability', () => {
  // ---- Base Window Computation ----
  
  describe('recurring rules', () => {
    it('returns slots for days with matching availability rules', async () => {
      // Setup: Instructor has Mon-Fri 8:00-17:00 rule
      // Query: Monday March 2, 2026
      // Expect: Slots from 08:00 to 16:00 for a 60-min service
    });

    it('returns empty for days with no rules (e.g., Sunday)', async () => {
      // Setup: No Sunday rule
      // Query: Sunday March 1, 2026
      // Expect: Zero slots
    });

    it('respects effective_from date (rule not yet active)', async () => {
      // Setup: Rule effective_from = March 10
      // Query: March 5
      // Expect: No slots from this rule
    });

    it('respects effective_until date (rule expired)', async () => {
      // Setup: Rule effective_until = Feb 28
      // Query: March 5
      // Expect: No slots from this rule
    });

    it('merges overlapping rules for the same day', async () => {
      // Setup: Rule A = Mon 8:00-12:00, Rule B = Mon 10:00-17:00
      // Expect: Merged window 08:00-17:00
    });
  });

  // ---- Override Application ----

  describe('overrides', () => {
    it('removes all availability for a full-day block', async () => {
      // Setup: Mon 8-17 rule + override type=blocked, date=March 2, no times
      // Expect: Zero slots for March 2
    });

    it('removes partial availability for a time-range block', async () => {
      // Setup: Mon 8-17 rule + override blocked 12:00-13:00
      // Expect: Slots 08:00-12:00 and 13:00-17:00
    });

    it('adds extra availability via available override', async () => {
      // Setup: No Saturday rule + override type=available Sat 09:00-13:00
      // Expect: Slots 09:00-12:00 for 60-min service
    });
  });

  // ---- Booking Subtraction ----

  describe('existing bookings', () => {
    it('removes slots occupied by confirmed bookings', async () => {
      // Setup: Mon 8-17 + confirmed booking 10:00-11:00
      // Expect: No slot starting at 10:00
    });

    it('applies buffer time after bookings', async () => {
      // Setup: Buffer = 15 min, booking 10:00-11:00
      // Expect: Next available slot starts at 11:15, not 11:00
    });

    it('ignores cancelled bookings', async () => {
      // Setup: Cancelled booking at 10:00
      // Expect: 10:00 slot IS available
    });

    it('ignores rescheduled bookings', async () => {
      // Setup: Rescheduled booking at 10:00
      // Expect: 10:00 slot IS available
    });
  });

  // ---- Max Lessons Per Day ----

  describe('max_lessons_per_day', () => {
    it('returns zero available slots when daily cap is reached', async () => {
      // Setup: max = 3, already 3 confirmed bookings
      // Expect: All slots marked available: false
    });

    it('limits available slot count to remaining capacity', async () => {
      // Setup: max = 5, already 3 confirmed
      // Expect: Only first 2 available slots marked available: true
    });
  });

  // ---- Minimum Notice ----

  describe('minimum notice', () => {
    it('marks slots as unavailable when less than min_notice_hours away', async () => {
      // Setup: min_notice = 24h, querying for tomorrow at 8:00, now = today 10:00
      // Expect: Slot at 08:00 unavailable (only 22h notice), 10:00+ available
    });

    it('all slots unavailable for today when min_notice > remaining hours', async () => {
      // Setup: min_notice = 24h, querying for today
      // Expect: All today slots unavailable
    });
  });

  // ---- Timezone / DST ----

  describe('timezone handling', () => {
    it('computes correct slots during AEST (UTC+10)', async () => {
      // Setup: July (winter, AEST UTC+10), rule 08:00-17:00 local
      // Verify: Internal UTC times are 22:00 prev day - 07:00 UTC
    });

    it('computes correct slots during AEDT (UTC+11)', async () => {
      // Setup: January (summer, AEDT UTC+11), rule 08:00-17:00 local
      // Verify: Internal UTC times are 21:00 prev day - 06:00 UTC
    });

    it('handles AEST→AEDT transition day correctly (first Sunday of October)', async () => {
      // The clock jumps forward: 2:00 AM → 3:00 AM (1 hour lost)
      // A rule 01:00-04:00 on this day should yield 2 hours of slots, not 3
    });

    it('handles AEDT→AEST transition day correctly (first Sunday of April)', async () => {
      // The clock falls back: 3:00 AM → 2:00 AM (1 hour gained)
      // A rule 01:00-04:00 on this day should yield 4 hours of slots, not 3
    });
  });

  // ---- Edge Cases ----

  describe('edge cases', () => {
    it('returns empty when instructor not found', async () => {
      // Expect: NotFoundError
    });

    it('returns empty when service not found', async () => {
      // Expect: NotFoundError
    });

    it('rejects date range > 60 days', async () => {
      // Expect: ValidationError
    });

    it('rejects date_from > date_to', async () => {
      // Expect: ValidationError
    });

    it('handles boundary: slot exactly fills remaining window', async () => {
      // Window: 16:00-17:00, service = 60 min
      // Expect: One slot 16:00-17:00
    });

    it('handles boundary: 1 minute less than service duration remaining', async () => {
      // Window: 16:01-17:00, service = 60 min
      // Expect: Zero slots (59 min not enough)
    });
  });
});
```

### 16.2 Reservation Service Tests

```typescript
// File: src/__tests__/lib/booking/reservation.service.test.ts

describe('reserveSlot', () => {
  it('creates a reservation and returns reservation_id + expires_at', async () => {
    // Happy path: slot is free, reservation created
  });

  it('throws BookingConflictError when slot is already reserved', async () => {
    // Reserve slot A, then try to reserve same slot → conflict
  });

  it('allows reservation after previous one expires', async () => {
    // Reserve, wait for TTL, reserve same slot → success
    // (Use Redis TTL manipulation or mock time)
  });

  it('stores reservation data retrievable by ID', async () => {
    const res = await reserveSlot(input, service, 'Rob Harrison');
    const stored = await getReservation(res.reservation_id);
    expect(stored?.contact.phone).toBe('+61412345678');
  });
});

describe('consumeReservation', () => {
  it('returns reservation data and deletes all Redis keys', async () => {
    const res = await reserveSlot(input, service, 'Rob');
    const consumed = await consumeReservation(res.reservation_id);
    expect(consumed).not.toBeNull();

    // Verify cleaned up
    const afterConsume = await getReservation(res.reservation_id);
    expect(afterConsume).toBeNull();
  });

  it('returns null for non-existent reservation', async () => {
    const result = await consumeReservation('non-existent-id');
    expect(result).toBeNull();
  });
});

describe('concurrent reservations', () => {
  it('only one of two simultaneous reserves succeeds', async () => {
    // Fire two reserveSlot calls in parallel for same slot
    const results = await Promise.allSettled([
      reserveSlot(inputA, service, 'Rob'),
      reserveSlot(inputB, service, 'Rob'), // Same instructor+date+time
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
  });
});
```

### 16.3 State Machine Tests

```typescript
// File: src/__tests__/lib/booking/state-machine.test.ts

describe('validateTransition', () => {
  it('allows pending → confirmed for instructor', () => {
    expect(() => validateTransition('pending', 'confirmed', 'instructor')).not.toThrow();
  });

  it('allows confirmed → cancelled for student', () => {
    expect(() => validateTransition('confirmed', 'cancelled', 'student')).not.toThrow();
  });

  it('rejects completed → cancelled (terminal state)', () => {
    expect(() => validateTransition('completed', 'cancelled', 'admin'))
      .toThrow(InvalidTransitionError);
  });

  it('rejects student trying to start a booking', () => {
    expect(() => validateTransition('confirmed', 'in_progress', 'student'))
      .toThrow(ForbiddenError);
  });

  it('rejects parent from any transition', () => {
    expect(() => validateTransition('confirmed', 'cancelled', 'parent'))
      .toThrow(ForbiddenError);
  });

  it('admin can do anything in the state machine', () => {
    expect(() => validateTransition('pending', 'cancelled', 'admin')).not.toThrow();
    expect(() => validateTransition('confirmed', 'no_show', 'admin')).not.toThrow();
    expect(() => validateTransition('in_progress', 'completed', 'admin')).not.toThrow();
  });
});

describe('getValidNextStatuses', () => {
  it('returns [confirmed, cancelled] for pending + instructor', () => {
    const next = getValidNextStatuses('pending', 'instructor');
    expect(next).toContain('confirmed');
    expect(next).toContain('cancelled');
  });

  it('returns [] for completed (terminal)', () => {
    const next = getValidNextStatuses('completed', 'admin');
    expect(next).toHaveLength(0);
  });
});
```

### 16.4 Cancellation Policy Tests

```typescript
// File: src/__tests__/lib/booking/cancellation-policy.test.ts

describe('evaluateCancellation', () => {
  it('allows free cancellation with 48h notice', () => {
    const futureStart = addHours(new Date(), 48);
    const result = evaluateCancellation(futureStart, 10500, 'student');
    expect(result.allowed).toBe(true);
    expect(result.is_late_cancellation).toBe(false);
    expect(result.cancellation_fee_cents).toBe(0);
    expect(result.refund_amount_cents).toBe(10500);
  });

  it('flags late cancellation with <24h notice', () => {
    const futureStart = addHours(new Date(), 12);
    const result = evaluateCancellation(futureStart, 10500, 'student');
    expect(result.is_late_cancellation).toBe(true);
  });

  it('admin bypasses cancellation policy', () => {
    const futureStart = addHours(new Date(), 1);
    const result = evaluateCancellation(futureStart, 10500, 'admin');
    expect(result.cancellation_fee_cents).toBe(0);
    expect(result.refund_amount_cents).toBe(10500);
  });

  it('disallows cancellation for past bookings', () => {
    const pastStart = addHours(new Date(), -2);
    const result = evaluateCancellation(pastStart, 10500, 'student');
    expect(result.allowed).toBe(false);
  });

  it('handles unpaid bookings correctly', () => {
    const futureStart = addHours(new Date(), 48);
    const result = evaluateCancellation(futureStart, 0, 'student');
    expect(result.refund_eligible).toBe(false);
    expect(result.refund_amount_cents).toBe(0);
  });
});
```

### 16.5 Integration Tests

```typescript
// File: src/__tests__/lib/booking/integration/booking-flow.test.ts

describe('Full Booking Flow', () => {
  it('reserve → confirm → start → complete (happy path)', async () => {
    // 1. GET /booking/services → pick a service
    // 2. GET /booking/availability → pick a slot
    // 3. POST /booking/reserve → get reservation_id
    // 4. POST /booking/confirm → get booking with status=pending
    // 5. POST /bookings/:id/start → status=in_progress
    // 6. POST /bookings/:id/complete → status=completed
    // Verify events emitted at each step
  });

  it('reserve → confirm → cancel (student cancels)', async () => {
    // Steps 1-4 → then POST /bookings/:id/cancel
    // Verify: status=cancelled, event emitted, cancellation_reason stored
  });

  it('reserve → confirm → reschedule → complete', async () => {
    // Steps 1-4 → PATCH /bookings/:id → new booking created
    // Verify: old booking status=rescheduled, new booking status=confirmed
    // Verify: both events emitted
  });

  it('reserve → reservation expires → confirm fails', async () => {
    // Step 3 → wait > 10 min (mock TTL) → step 4 fails
    // Verify: ReservationExpiredError
  });

  it('slot freed after cancellation is rebookable', async () => {
    // Book slot A → cancel → book slot A again → succeeds
  });
});

describe('Concurrent Booking', () => {
  it('two users reserving same slot: only one succeeds', async () => {
    // Fire two POST /booking/reserve in parallel
    // Exactly one gets 201, other gets 409
  });

  it('database constraint prevents bypass if Redis fails', async () => {
    // Mock Redis to allow both reservations (simulating Redis outage)
    // Both try to INSERT → one gets unique constraint violation
    // Service layer converts to BookingConflictError
  });
});
```

```typescript
// File: src/__tests__/lib/booking/integration/timezone.test.ts

describe('Timezone: AEST/AEDT', () => {
  it('availability in July uses AEST (UTC+10)', async () => {
    // Rule: Mon 08:00-17:00
    // July Monday = AEST
    // Slot at 08:00 local = 22:00 UTC previous day
    // Verify returned slot times are in local format
  });

  it('availability in January uses AEDT (UTC+11)', async () => {
    // Rule: Mon 08:00-17:00
    // January Monday = AEDT
    // Slot at 08:00 local = 21:00 UTC previous day
  });

  it('booking across midnight UTC works correctly', async () => {
    // An 8:00 AM AEDT booking is 21:00 UTC the previous day
    // Verify: scheduled_date in bookings table matches the LOCAL date, not UTC date
  });
});
```

---

## 17. Cron Job: Reservation Cleanup

### File: `src/app/api/cron/cleanup-reservations/route.ts`

```typescript
// ============================================================
// Vercel Cron: Clean up expired booking reservations
// Schedule: Every 5 minutes
// Config in vercel.json: { "crons": [{ "path": "/api/cron/cleanup-reservations", "schedule": "*/5 * * * *" }] }
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredReservations } from '@/lib/booking/reservation.service';

export async function GET(request: NextRequest) {
  // Verify Vercel cron secret (prevents external calls)
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const cleaned = await cleanupExpiredReservations();
    return NextResponse.json({ cleaned });
  } catch (error) {
    console.error('[CRON] Reservation cleanup failed:', error);
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 });
  }
}
```

---

## 18. Summary of Error Codes (Booking-Specific)

| Code | HTTP | When |
|------|------|------|
| `BOOKING_CONFLICT` | 409 | Slot already booked or reserved by another user |
| `BOOKING_TOO_LATE` | 422 | Insufficient notice for booking or cancellation |
| `RESERVATION_EXPIRED` | 404 | Trying to confirm a reservation that has timed out |
| `INVALID_TRANSITION` | 422 | Invalid booking status change (e.g., completed → pending) |
| `MAX_LESSONS_EXCEEDED` | 422 | Instructor at daily lesson cap |
| `SERVICE_NOT_BOOKABLE` | 422 | Service is inactive or not available online |
| `VALIDATION_ERROR` | 422 | Zod schema validation failure |
| `NOT_FOUND` | 404 | Instructor, service, or booking not found |
| `AUTH_REQUIRED` | 401 | Missing auth on authenticated endpoints |
| `FORBIDDEN` | 403 | Role lacks permission for this action |

---

## 19. Implementation Notes

### 19.1 Execution Order

1. Create all files in `src/lib/events/` (event bus — needed by booking service)
2. Create all files in `src/lib/booking/` (types → constants → errors → state-machine → cancellation-policy → services.service → reservation.service → availability.service → booking.service → events)
3. Create API route handlers in order: services → availability → reserve → confirm → bookings CRUD
4. Create cron job for reservation cleanup
5. Write and run tests
6. Add `vercel.json` cron configuration

### 19.2 Environment Setup

Ensure the following are configured in Vercel/local `.env.local`:
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (from SPEC-02)
- `BOOKING_RESERVATION_TTL_SECONDS=600`
- `BOOKING_TIMEZONE=Australia/Canberra`
- `CRON_SECRET` (for Vercel cron authentication)

### 19.3 Seed Data Requirements

From SPEC-01, ensure these are seeded before testing:
- At least 1 instructor (Rob) with `default_buffer_minutes=15`, `max_lessons_per_day=8`
- At least 2 services (e.g., "Learner Lesson 60min" and "Extended Lesson 90min")
- Availability rules for Monday–Saturday (Rob's typical schedule)
- The 23 competency tasks (for future integration with C12)

---

*End of SPEC-03: Booking Engine API*

*Next: SPEC-04 should cover C02 (Booking Widget) — the frontend component that consumes these APIs.*
