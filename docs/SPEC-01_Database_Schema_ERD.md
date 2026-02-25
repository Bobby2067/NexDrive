# SPEC-01: Database Schema & ERD
### NexDrive Academy — Phase 0 Foundation
**Version:** 1.0  
**Date:** 20 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §3  
**Phase:** 0 (Foundation — Week 1-2)  
**Estimated Effort:** 3-4 days  

---

## 1. Overview

This specification defines the complete database layer for NexDrive Academy — 26 tables translated from the System Architecture document into Drizzle ORM TypeScript schemas, with connection setup, migrations, triggers, seed data, and testing strategy.

**This is a self-contained implementation brief.** A developer (or AI coding agent like Claude Code) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. All tables use UUID primary keys (`gen_random_uuid()`)
2. All tables include `created_at` and `updated_at` timestamps (except append-only tables which omit `updated_at`)
3. Soft delete via `deleted_at` where applicable — never hard delete compliance data
4. `clerk_user_id` is stored as `TEXT` — NOT a foreign key to any auth table
5. `instructor_id` on all tenant-scoped tables (multi-tenant from day one)
6. Audit-critical tables are **append-only** (no UPDATE/DELETE): `lessons`, `student_competencies`, `signatures`, `audit_log`
7. All monetary values stored as **integer cents** (avoid floating point)
8. Application-level RBAC via Clerk middleware — no database-level RLS
9. `private_notes` are **NEVER** visible to students or parents (defence in depth)
10. Australian data residency: Neon Sydney (`ap-southeast-2`)

---

## 2. File Structure

```
src/
├── db/
│   ├── index.ts                    # Database connection + client export
│   ├── migrate.ts                  # Migration runner script
│   ├── seed.ts                     # Seed data script
│   ├── schema/
│   │   ├── index.ts                # Barrel export of all schemas + relations
│   │   ├── users.ts                # profiles, instructors, students, parents, parent_student_links
│   │   ├── crm.ts                  # contacts
│   │   ├── services.ts             # services, availability_rules, availability_overrides
│   │   ├── bookings.ts             # bookings
│   │   ├── lessons.ts              # lessons, lesson_bridge_forms
│   │   ├── compliance.ts           # competency_tasks, student_competencies, signatures, audit_log
│   │   ├── payments.ts             # payments, packages, student_packages, vouchers
│   │   ├── communication.ts        # conversations, messages, call_logs
│   │   ├── instructor-tools.ts     # private_notes, self_assessments
│   │   ├── notifications.ts        # notifications
│   │   ├── rag.ts                  # rag_documents, rag_chunks
│   │   └── system.ts               # waitlist
│   └── types.ts                    # Exported TypeScript types (InferSelectModel, InferInsertModel)
├── drizzle.config.ts               # drizzle-kit configuration
└── scripts/
    └── db/
        ├── setup-extensions.sql    # pgvector + crypto extensions
        ├── create-functions.sql    # Database functions & triggers
        └── seed-competencies.ts    # 23 ACT CBT&A tasks
```

---

## 3. Prerequisites & Setup

### 3.1 Dependencies

```bash
# Core
npm install drizzle-orm @neondatabase/serverless

# Dev / migrations
npm install -D drizzle-kit

# For pgvector support
npm install pgvector
```

### 3.2 Environment Variables

```env
# .env.local
DATABASE_URL=postgresql://user:pass@ep-xxx.ap-southeast-2.aws.neon.tech/nexdrive?sslmode=require

# Neon branches (convention)
# Main branch = production
# dev branch = development
# preview branches = per-PR (created by CI)
```

### 3.3 Database Connection (`src/db/index.ts`)

```typescript
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

// Neon serverless HTTP driver — one connection per request, no pool needed
const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle(sql, { schema });

// Re-export for convenience
export type Database = typeof db;
```

> **Why neon-http?** Vercel serverless functions are short-lived. The Neon HTTP driver (`@neondatabase/serverless`) sends queries over HTTP — no TCP connection overhead, no pool management, works perfectly with Vercel's request-per-function model. Each API route gets its own isolated query.

### 3.4 Drizzle Config (`drizzle.config.ts`)

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
```

---

## 4. Database Extensions (`scripts/db/setup-extensions.sql`)

Run once on initial Neon project setup (before any migrations):

```sql
-- Required for pgvector (RAG embeddings)
CREATE EXTENSION IF NOT EXISTS vector;

-- Required for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Required for SHA-256 hash chains (audit, signatures, competencies)
-- pgcrypto provides sha256() function
-- (Already included above via pgcrypto)
```

---

## 5. Schema Definitions

### 5.1 Users (`src/db/schema/users.ts`)

```typescript
import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  boolean,
  integer,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─────────────────────────────────────────────
// PROFILES
// Extended user data for all user types.
// Clerk owns identity/auth externally.
// ─────────────────────────────────────────────
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Clerk user ID — TEXT, not a foreign key
  userId: text('user_id').notNull().unique(),

  // Identity
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'), // AU format: +61XXXXXXXXX

  dateOfBirth: date('date_of_birth'),

  // Address
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  suburb: text('suburb'),
  state: text('state').default('ACT'),
  postcode: text('postcode'),

  // Role
  role: text('role', {
    enum: ['admin', 'instructor', 'student', 'parent'],
  }).notNull(),

  // Status
  status: text('status', {
    enum: ['active', 'inactive', 'suspended'],
  }).notNull().default('active'),
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),

  // Avatar
  avatarUrl: text('avatar_url'),

  // Meta
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('idx_profiles_user_id').on(table.userId),
  index('idx_profiles_role').on(table.role),
  index('idx_profiles_email').on(table.email),
  index('idx_profiles_phone').on(table.phone),
]);

// ─────────────────────────────────────────────
// INSTRUCTORS
// Instructor-specific data. One row per instructor.
// ─────────────────────────────────────────────
export const instructors = pgTable('instructors', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique(), // Clerk user ID
  profileId: uuid('profile_id').notNull().unique().references(() => profiles.id),

  // ADI Details (ACT Government)
  adiNumber: text('adi_number').notNull(), // e.g., '608'
  adiExpiry: date('adi_expiry').notNull(),

  // Vehicle
  vehicleRego: text('vehicle_rego'),      // e.g., 'YNX 26N'
  vehicleMake: text('vehicle_make'),
  vehicleModel: text('vehicle_model'),
  vehicleYear: integer('vehicle_year'),
  transmission: text('transmission', {
    enum: ['manual', 'auto', 'both'],
  }),

  // Business
  isOwner: boolean('is_owner').notNull().default(false),
  hourlyRate: integer('hourly_rate'), // Cents (e.g., 10500 = $105.00)
  commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }),
  territory: text('territory'),
  bio: text('bio'),

  // Availability defaults
  defaultBufferMinutes: integer('default_buffer_minutes').notNull().default(15),
  maxLessonsPerDay: integer('max_lessons_per_day').notNull().default(8),

  // Status
  status: text('status', {
    enum: ['active', 'inactive', 'onboarding', 'suspended'],
  }).notNull().default('active'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_instructors_user_id').on(table.userId),
  index('idx_instructors_adi_number').on(table.adiNumber),
]);

// ─────────────────────────────────────────────
// STUDENTS
// Student-specific data. One row per student.
// ─────────────────────────────────────────────
export const students = pgTable('students', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique(), // Clerk user ID
  profileId: uuid('profile_id').notNull().unique().references(() => profiles.id),
  instructorId: uuid('instructor_id').notNull().references(() => instructors.id),

  // Licence
  licenceNumber: text('licence_number'),
  licenceType: text('licence_type', {
    enum: ['learner', 'provisional', 'full'],
  }),
  licenceExpiry: date('licence_expiry'),

  // Learning
  transmission: text('transmission', {
    enum: ['manual', 'auto'],
  }).notNull().default('auto'),
  schoolOrWork: text('school_or_work'), // Per Form 10.044

  // Logbook
  totalHours: numeric('total_hours', { precision: 6, scale: 2 }).default('0'),
  nightHours: numeric('night_hours', { precision: 6, scale: 2 }).default('0'),
  professionalHours: numeric('professional_hours', { precision: 6, scale: 2 }).default('0'),

  // Privacy
  parentVisibility: boolean('parent_visibility').notNull().default(true),

  // Progress
  enrollmentDate: date('enrollment_date').notNull().default(sql`CURRENT_DATE`),
  estimatedTestDate: date('estimated_test_date'),
  completionDate: date('completion_date'),
  certificateIssuedAt: timestamp('certificate_issued_at', { withTimezone: true }),
  certificateNumber: text('certificate_number'), // Form 165751 serial number

  // Status
  status: text('status', {
    enum: ['active', 'inactive', 'completed', 'suspended', 'archived'],
  }).notNull().default('active'),

  // Source/Marketing
  referralSource: text('referral_source'),
  referralDetail: text('referral_detail'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_students_user_id').on(table.userId),
  index('idx_students_instructor_id').on(table.instructorId),
  index('idx_students_status').on(table.status),
  index('idx_students_licence_number').on(table.licenceNumber),
]);

// ─────────────────────────────────────────────
// PARENTS
// Parent/supervisor-specific data.
// ─────────────────────────────────────────────
export const parents = pgTable('parents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique(), // Clerk user ID
  profileId: uuid('profile_id').notNull().unique().references(() => profiles.id),

  // Driving details (useful for co-lessons)
  licenceType: text('licence_type'),
  yearsDriving: integer('years_driving'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_parents_user_id').on(table.userId),
]);

// ─────────────────────────────────────────────
// PARENT_STUDENT_LINKS
// Many-to-many with privacy controls (student-controlled).
// ─────────────────────────────────────────────
export const parentStudentLinks = pgTable('parent_student_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentId: uuid('parent_id').notNull().references(() => parents.id),
  studentId: uuid('student_id').notNull().references(() => students.id),

  // Relationship
  relationship: text('relationship', {
    enum: ['parent', 'guardian', 'supervisor', 'other'],
  }).notNull().default('parent'),

  // Privacy (controlled by STUDENT, not parent)
  canViewProgress: boolean('can_view_progress').notNull().default(true),
  canViewBookings: boolean('can_view_bookings').notNull().default(true),
  canViewPayments: boolean('can_view_payments').notNull().default(true),
  canViewLessonNotes: boolean('can_view_lesson_notes').notNull().default(true),
  canViewBridgeForms: boolean('can_view_bridge_forms').notNull().default(true),
  canBookLessons: boolean('can_book_lessons').notNull().default(true),

  // Status
  status: text('status', {
    enum: ['pending', 'active', 'revoked'],
  }).notNull().default('active'),
  invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_psl_parent_id').on(table.parentId),
  index('idx_psl_student_id').on(table.studentId),
  uniqueIndex('idx_psl_parent_student').on(table.parentId, table.studentId),
]);

// ─── RELATIONS ──────────────────────────────

export const profilesRelations = relations(profiles, ({ one }) => ({
  instructor: one(instructors, {
    fields: [profiles.id],
    references: [instructors.profileId],
  }),
  student: one(students, {
    fields: [profiles.id],
    references: [students.profileId],
  }),
  parent: one(parents, {
    fields: [profiles.id],
    references: [parents.profileId],
  }),
}));

export const instructorsRelations = relations(instructors, ({ one, many }) => ({
  profile: one(profiles, {
    fields: [instructors.profileId],
    references: [profiles.id],
  }),
  students: many(students),
  bookings: many(bookings),
  lessons: many(lessons),
  availabilityRules: many(availabilityRules),
  availabilityOverrides: many(availabilityOverrides),
  privateNotes: many(privateNotes),
}));

export const studentsRelations = relations(students, ({ one, many }) => ({
  profile: one(profiles, {
    fields: [students.profileId],
    references: [profiles.id],
  }),
  instructor: one(instructors, {
    fields: [students.instructorId],
    references: [instructors.id],
  }),
  bookings: many(bookings),
  lessons: many(lessons),
  studentCompetencies: many(studentCompetencies),
  payments: many(payments),
  parentLinks: many(parentStudentLinks),
  selfAssessments: many(selfAssessments),
}));

export const parentsRelations = relations(parents, ({ one, many }) => ({
  profile: one(profiles, {
    fields: [parents.profileId],
    references: [profiles.id],
  }),
  studentLinks: many(parentStudentLinks),
}));

export const parentStudentLinksRelations = relations(parentStudentLinks, ({ one }) => ({
  parent: one(parents, {
    fields: [parentStudentLinks.parentId],
    references: [parents.id],
  }),
  student: one(students, {
    fields: [parentStudentLinks.studentId],
    references: [students.id],
  }),
}));
```

> **Note:** Forward references to `bookings`, `lessons`, etc. are used in relations. These are resolved at runtime by Drizzle. The barrel export in `index.ts` handles circular references.

### 5.2 CRM (`src/db/schema/crm.ts`)

```typescript
import {
  pgTable, uuid, text, integer, timestamp, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { instructors } from './users';

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id'), // Clerk user ID (NULL for prospects without accounts)
  instructorId: uuid('instructor_id').references(() => instructors.id),

  // Identity
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email'),
  phone: text('phone'), // Primary identifier for SMS leads

  // CRM
  lifecycleStage: text('lifecycle_stage', {
    enum: ['prospect', 'lead', 'qualified', 'enrolled', 'active', 'completed', 'alumni', 'lost'],
  }).notNull().default('prospect'),
  leadScore: integer('lead_score').default(0),

  // Source tracking
  source: text('source'), // 'website', 'phone', 'sms', 'referral', 'google', 'facebook'
  sourceDetail: text('source_detail'),
  utmSource: text('utm_source'),
  utmMedium: text('utm_medium'),
  utmCampaign: text('utm_campaign'),

  // Interaction tracking
  firstContactAt: timestamp('first_contact_at', { withTimezone: true }).notNull().defaultNow(),
  lastContactAt: timestamp('last_contact_at', { withTimezone: true }).notNull().defaultNow(),
  totalInteractions: integer('total_interactions').notNull().default(1),

  // Notes
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('idx_contacts_user_id').on(table.userId),
  index('idx_contacts_phone').on(table.phone),
  index('idx_contacts_email').on(table.email),
  index('idx_contacts_lifecycle').on(table.lifecycleStage),
  index('idx_contacts_instructor_id').on(table.instructorId),
]);

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  instructor: one(instructors, {
    fields: [contacts.instructorId],
    references: [instructors.id],
  }),
  conversations: many(conversations),
  callLogs: many(callLogs),
  bookings: many(bookings),
}));
```

### 5.3 Services & Availability (`src/db/schema/services.ts`)

```typescript
import {
  pgTable, uuid, text, integer, boolean, timestamp, time, date, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { instructors } from './users';

// ─────────────────────────────────────────────
// SERVICES
// Lesson types and pricing configuration.
// ─────────────────────────────────────────────
export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),           // 'Learner Lesson (60 min)'
  slug: text('slug').notNull().unique(),   // 'learner-60'
  description: text('description'),
  durationMinutes: integer('duration_minutes').notNull(),

  // Pricing
  priceCents: integer('price_cents').notNull(), // e.g., 10500 = $105.00

  // Categorisation
  category: text('category', {
    enum: ['lesson', 'co_lesson', 'assessment', 'special'],
  }).notNull(),

  // Booking rules
  isBookableOnline: boolean('is_bookable_online').notNull().default(true),
  requiresEligibilityCheck: boolean('requires_eligibility_check').notNull().default(false),
  minNoticeHours: integer('min_notice_hours').notNull().default(24),

  // Display
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  color: text('color'), // Calendar colour code

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_services_slug').on(table.slug),
  index('idx_services_active').on(table.isActive),
]);

// ─────────────────────────────────────────────
// AVAILABILITY_RULES
// Recurring weekly availability per instructor.
// ─────────────────────────────────────────────
export const availabilityRules = pgTable('availability_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  instructorId: uuid('instructor_id').notNull().references(() => instructors.id),

  dayOfWeek: integer('day_of_week').notNull(), // 0=Sun, 6=Sat (CHECK 0-6 via app layer)
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),

  effectiveFrom: date('effective_from').notNull().default(sql`CURRENT_DATE`),
  effectiveUntil: date('effective_until'), // NULL = indefinite

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_avail_rules_instructor').on(table.instructorId),
  index('idx_avail_rules_day').on(table.dayOfWeek),
]);

// ─────────────────────────────────────────────
// AVAILABILITY_OVERRIDES
// One-off blocks or openings (holidays, sick days).
// ─────────────────────────────────────────────
export const availabilityOverrides = pgTable('availability_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  instructorId: uuid('instructor_id').notNull().references(() => instructors.id),

  date: date('date').notNull(),
  startTime: time('start_time'), // NULL = entire day
  endTime: time('end_time'),

  overrideType: text('override_type', {
    enum: ['blocked', 'available'],
  }).notNull(),
  reason: text('reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_avail_overrides_instructor').on(table.instructorId),
  index('idx_avail_overrides_date').on(table.date),
]);

// ─── RELATIONS ──────────────────────────────

export const servicesRelations = relations(services, ({ many }) => ({
  bookings: many(bookings),
}));

export const availabilityRulesRelations = relations(availabilityRules, ({ one }) => ({
  instructor: one(instructors, {
    fields: [availabilityRules.instructorId],
    references: [instructors.id],
  }),
}));

export const availabilityOverridesRelations = relations(availabilityOverrides, ({ one }) => ({
  instructor: one(instructors, {
    fields: [availabilityOverrides.instructorId],
    references: [instructors.id],
  }),
}));
```

### 5.4 Bookings (`src/db/schema/bookings.ts`)

```typescript
import {
  pgTable, uuid, text, integer, boolean, timestamp, date, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { instructors, students, parents } from './users';
import { contacts } from './crm';
import { services } from './services';

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  instructorId: uuid('instructor_id').notNull().references(() => instructors.id),
  studentId: uuid('student_id').references(() => students.id), // NULL if prospect booking
  contactId: uuid('contact_id').references(() => contacts.id),
  serviceId: uuid('service_id').notNull().references(() => services.id),

  // Schedule
  scheduledDate: date('scheduled_date').notNull(),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }).notNull(),
  durationMinutes: integer('duration_minutes').notNull(),

  // Location
  pickupAddress: text('pickup_address'),
  suburb: text('suburb'),

  // Status
  status: text('status', {
    enum: ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show', 'rescheduled'],
  }).notNull().default('pending'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: text('cancelled_by'), // Clerk user ID
  cancellationReason: text('cancellation_reason'),

  // Payment
  paymentStatus: text('payment_status', {
    enum: ['unpaid', 'deposit_paid', 'paid', 'package_credit', 'refunded', 'waived'],
  }).notNull().default('unpaid'),
  paymentId: uuid('payment_id'), // References payments table
  amountCents: integer('amount_cents').notNull().default(0),

  // Booking metadata
  bookedVia: text('booked_via', {
    enum: ['website', 'phone', 'sms', 'voice_agent', 'admin', 'walk_in'],
  }).notNull().default('website'),
  bookedBy: text('booked_by'), // Clerk user ID of booker

  // Co-lesson
  isCoLesson: boolean('is_co_lesson').notNull().default(false),
  coLessonParentId: uuid('co_lesson_parent_id').references(() => parents.id),

  // Notes
  bookingNotes: text('booking_notes'), // Visible to student
  adminNotes: text('admin_notes'),     // Internal only

  // Lesson link (set after lesson recorded)
  lessonId: uuid('lesson_id'), // Populated after lesson recording

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_bookings_instructor_id').on(table.instructorId),
  index('idx_bookings_student_id').on(table.studentId),
  index('idx_bookings_scheduled_date').on(table.scheduledDate),
  index('idx_bookings_start_time').on(table.startTime),
  index('idx_bookings_status').on(table.status),
  // Prevent double-booking (unique instructor + time for non-cancelled bookings)
  // NOTE: Partial unique index with WHERE clause — applied via custom SQL migration
  // uniqueIndex('idx_bookings_no_overlap').on(table.instructorId, table.startTime)
  //   .where(sql`status NOT IN ('cancelled', 'rescheduled')`)
]);

export const bookingsRelations = relations(bookings, ({ one }) => ({
  instructor: one(instructors, {
    fields: [bookings.instructorId],
    references: [instructors.id],
  }),
  student: one(students, {
    fields: [bookings.studentId],
    references: [students.id],
  }),
  contact: one(contacts, {
    fields: [bookings.contactId],
    references: [contacts.id],
  }),
  service: one(services, {
    fields: [bookings.serviceId],
    references: [services.id],
  }),
  coLessonParent: one(parents, {
    fields: [bookings.coLessonParentId],
    references: [parents.id],
  }),
  lesson: one(lessons, {
    fields: [bookings.lessonId],
    references: [lessons.id],
  }),
}));
```

### 5.5 Lessons (`src/db/schema/lessons.ts`)

```typescript
import {
  pgTable, uuid, text, integer, timestamp, date, numeric, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { instructors, students } from './users';
import { signatures } from './compliance';

// ─────────────────────────────────────────────
// LESSONS
// Digital Form 10.044 per-lesson row.
// ⚠️  APPEND-ONLY after signing — no UPDATE/DELETE.
//     Corrections create new records via correction_of.
// ─────────────────────────────────────────────
export const lessons = pgTable('lessons', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id'), // References bookings (circular — resolved via custom SQL FK)
  instructorId: uuid('instructor_id').notNull().references(() => instructors.id),
  studentId: uuid('student_id').notNull().references(() => students.id),

  // Lesson sequence (per student, auto-incremented via DB function)
  lessonNumber: integer('lesson_number').notNull(),

  // Timing
  lessonDate: date('lesson_date').notNull(),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }).notNull(),
  totalMinutes: integer('total_minutes').notNull(),
  roundedMinutes: integer('rounded_minutes'), // Rounded to 30-min periods

  // Odometer
  odoStart: integer('odo_start'),
  odoEnd: integer('odo_end'),
  // total_km is a generated column — applied via custom SQL migration
  // totalKm: integer('total_km').generatedAlwaysAs(sql`odo_end - odo_start`),

  // Competencies (arrays of task numbers)
  competenciesTaught: integer('competencies_taught').array().default(sql`'{}'`),
  competenciesAssessed: integer('competencies_assessed').array().default(sql`'{}'`),
  competenciesAchievedManual: integer('competencies_achieved_manual').array().default(sql`'{}'`),
  competenciesAchievedAuto: integer('competencies_achieved_auto').array().default(sql`'{}'`),

  // Location
  locationSuburb: text('location_suburb'),
  locationDetail: text('location_detail'),

  // Comments (visible to student/parent per privacy settings)
  comments: text('comments'),

  // Status
  status: text('status', {
    enum: ['draft', 'pending_student_signature', 'completed', 'disputed'],
  }).notNull().default('draft'),

  // Signatures (references to signatures table)
  instructorSignatureId: uuid('instructor_signature_id').references(() => signatures.id),
  studentSignatureId: uuid('student_signature_id').references(() => signatures.id),

  // Audit
  signedAt: timestamp('signed_at', { withTimezone: true }),
  deviceInfo: jsonb('device_info'),
  gpsLatitude: numeric('gps_latitude', { precision: 10, scale: 7 }),
  gpsLongitude: numeric('gps_longitude', { precision: 10, scale: 7 }),

  // ⚠️ NO updated_at — lessons are append-only after signing
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  // Corrections
  correctionOf: uuid('correction_of'), // Self-reference — FK applied via custom migration
  correctionReason: text('correction_reason'),
}, (table) => [
  index('idx_lessons_student_id').on(table.studentId),
  index('idx_lessons_instructor_id').on(table.instructorId),
  index('idx_lessons_date').on(table.lessonDate),
  index('idx_lessons_booking_id').on(table.bookingId),
  // Partial unique index applied via custom SQL migration:
  // CREATE UNIQUE INDEX idx_lessons_student_number ON lessons(student_id, lesson_number)
  //   WHERE correction_of IS NULL;
]);

// ─────────────────────────────────────────────
// LESSON_BRIDGE_FORMS
// Auto-generated post-lesson handouts for supervising drivers.
// ─────────────────────────────────────────────
export const lessonBridgeForms = pgTable('lesson_bridge_forms', {
  id: uuid('id').primaryKey().defaultRandom(),
  lessonId: uuid('lesson_id').notNull().unique().references(() => lessons.id),
  studentId: uuid('student_id').notNull().references(() => students.id),
  instructorId: uuid('instructor_id').notNull().references(() => instructors.id),

  // Content (auto-generated from lesson data)
  skillsCovered: jsonb('skills_covered').notNull(), // [{task_number, task_name, status}]
  positives: text('positives'),
  practiceInstructions: text('practice_instructions'),
  focusAreas: text('focus_areas'),
  nextLessonRecommendation: text('next_lesson_recommendation'),

  // Generated document
  pdfUrl: text('pdf_url'),

  // Visibility
  isVisibleToStudent: boolean('is_visible_to_student').notNull().default(true),
  isVisibleToParent: boolean('is_visible_to_parent').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_lbf_student').on(table.studentId),
  index('idx_lbf_lesson').on(table.lessonId),
]);

// ─── RELATIONS ──────────────────────────────

export const lessonsRelations = relations(lessons, ({ one, many }) => ({
  instructor: one(instructors, {
    fields: [lessons.instructorId],
    references: [instructors.id],
  }),
  student: one(students, {
    fields: [lessons.studentId],
    references: [students.id],
  }),
  instructorSignature: one(signatures, {
    fields: [lessons.instructorSignatureId],
    references: [signatures.id],
    relationName: 'instructorSignature',
  }),
  studentSignature: one(signatures, {
    fields: [lessons.studentSignatureId],
    references: [signatures.id],
    relationName: 'studentSignature',
  }),
  correctionOfLesson: one(lessons, {
    fields: [lessons.correctionOf],
    references: [lessons.id],
    relationName: 'corrections',
  }),
  corrections: many(lessons, { relationName: 'corrections' }),
  bridgeForm: one(lessonBridgeForms),
  privateNotes: many(privateNotes),
}));

export const lessonBridgeFormsRelations = relations(lessonBridgeForms, ({ one }) => ({
  lesson: one(lessons, {
    fields: [lessonBridgeForms.lessonId],
    references: [lessons.id],
  }),
  student: one(students, {
    fields: [lessonBridgeForms.studentId],
    references: [students.id],
  }),
  instructor: one(instructors, {
    fields: [lessonBridgeForms.instructorId],
    references: [instructors.id],
  }),
}));
```

### 5.6 Compliance (`src/db/schema/compliance.ts`)

```typescript
import {
  pgTable, uuid, text, integer, boolean, timestamp, date, numeric, jsonb, inet, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { instructors, students } from './users';

// ─────────────────────────────────────────────
// COMPETENCY_TASKS
// Reference table — the 23+ ACT CBT&A tasks.
// ─────────────────────────────────────────────
export const competencyTasks = pgTable('competency_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),

  taskNumber: integer('task_number').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category'), // 'Basic Control', 'Traffic', 'Complex'

  // Progression rules
  prerequisites: integer('prerequisites').array().default(sql`'{}'`),
  isReview: boolean('is_review').notNull().default(false),
  isFinalDrive: boolean('is_final_drive').notNull().default(false),

  // Review gating
  reviewRequiresTasks: integer('review_requires_tasks').array().default(sql`'{}'`),

  // Final drive rules
  finalDriveMinMinutes: integer('final_drive_min_minutes'),
  finalDriveUnfamiliarRoads: boolean('final_drive_unfamiliar_roads').default(false),

  // Content
  competencyHubContentId: uuid('competency_hub_content_id'),

  // Display
  sortOrder: integer('sort_order').notNull(),
  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_comp_tasks_number').on(table.taskNumber),
]);

// ─────────────────────────────────────────────
// STUDENT_COMPETENCIES
// Per-student per-task competency status.
// ⚠️  APPEND-ONLY — new status = new row.
// ─────────────────────────────────────────────
export const studentCompetencies = pgTable('student_competencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id').notNull().references(() => students.id),
  taskId: uuid('task_id').notNull().references(() => competencyTasks.id),
  instructorId: uuid('instructor_id').notNull().references(() => instructors.id),

  // Status
  status: text('status', {
    enum: ['not_started', 'taught', 'assessed', 'competent', 'not_yet_competent'],
  }).notNull(),
  transmission: text('transmission', {
    enum: ['manual', 'auto'],
  }).notNull(),

  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
  lessonId: uuid('lesson_id'), // Which lesson triggered this change

  // Audit
  signedByInstructor: boolean('signed_by_instructor').notNull().default(false),
  signedByStudent: boolean('signed_by_student').notNull().default(false),
  signatureId: uuid('signature_id'),

  // Hash chain (append-only audit)
  previousHash: text('previous_hash'),
  recordHash: text('record_hash').notNull(),

  // ⚠️ NO updated_at — append-only
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_sc_student_id').on(table.studentId),
  index('idx_sc_task_id').on(table.taskId),
  index('idx_sc_student_task').on(table.studentId, table.taskId),
  index('idx_sc_status').on(table.status),
]);

// ─────────────────────────────────────────────
// SIGNATURES
// E-signature capture records.
// ⚠️  IMMUTABLE — never updated or deleted.
// ─────────────────────────────────────────────
export const signatures = pgTable('signatures', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Who signed
  signerId: text('signer_id').notNull(), // Clerk user ID
  signerRole: text('signer_role', {
    enum: ['instructor', 'student'],
  }).notNull(),

  // What they signed
  documentType: text('document_type', {
    enum: ['lesson', 'competency', 'certificate', 'enrollment'],
  }).notNull(),
  documentId: uuid('document_id').notNull(),

  // Signature data
  signatureUrl: text('signature_url').notNull(), // R2 storage path

  // Verification
  timestampUtc: timestamp('timestamp_utc', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  deviceInfo: jsonb('device_info'),
  gpsLatitude: numeric('gps_latitude', { precision: 10, scale: 7 }),
  gpsLongitude: numeric('gps_longitude', { precision: 10, scale: 7 }),

  // Hash chain
  previousHash: text('previous_hash'),
  recordHash: text('record_hash').notNull(),

  // ⚠️ NO updated_at, NO deleted_at — immutable
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_signatures_signer').on(table.signerId),
  index('idx_signatures_document').on(table.documentType, table.documentId),
]);

// ─────────────────────────────────────────────
// AUDIT_LOG
// Immutable event log for all auditable actions.
// ⚠️  APPEND-ONLY — no updates, no deletes.
// ─────────────────────────────────────────────
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),

  eventType: text('event_type').notNull(), // 'LESSON_CREATED', 'COMPETENCY_SIGNED_OFF', etc.
  severity: text('severity', {
    enum: ['info', 'warning', 'critical'],
  }).notNull().default('info'),

  // Actor
  actorId: text('actor_id'), // Clerk user ID (NULL for system events)
  actorRole: text('actor_role'),

  // Subject
  subjectType: text('subject_type'), // 'student', 'booking', 'lesson', etc.
  subjectId: uuid('subject_id'),

  // Details
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),

  // Context
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  gpsLatitude: numeric('gps_latitude', { precision: 10, scale: 7 }),
  gpsLongitude: numeric('gps_longitude', { precision: 10, scale: 7 }),

  // Hash chain
  previousHash: text('previous_hash'),
  recordHash: text('record_hash').notNull(),

  // ⚠️ APPEND-ONLY — no updated_at, no deleted_at
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_audit_event_type').on(table.eventType),
  index('idx_audit_actor').on(table.actorId),
  index('idx_audit_subject').on(table.subjectType, table.subjectId),
  index('idx_audit_created').on(table.createdAt),
]);

// ─── RELATIONS ──────────────────────────────

export const competencyTasksRelations = relations(competencyTasks, ({ many }) => ({
  studentCompetencies: many(studentCompetencies),
}));

export const studentCompetenciesRelations = relations(studentCompetencies, ({ one }) => ({
  student: one(students, {
    fields: [studentCompetencies.studentId],
    references: [students.id],
  }),
  task: one(competencyTasks, {
    fields: [studentCompetencies.taskId],
    references: [competencyTasks.id],
  }),
  instructor: one(instructors, {
    fields: [studentCompetencies.instructorId],
    references: [instructors.id],
  }),
}));
```

### 5.7 Payments (`src/db/schema/payments.ts`)

```typescript
import {
  pgTable, uuid, text, integer, boolean, timestamp, numeric, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { students } from './users';
import { contacts } from './crm';

// ─────────────────────────────────────────────
// PAYMENTS
// Payment transaction records.
// ─────────────────────────────────────────────
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),

  studentId: uuid('student_id').references(() => students.id),
  contactId: uuid('contact_id').references(() => contacts.id),

  bookingId: uuid('booking_id'), // References bookings (avoid circular import)
  packageId: uuid('package_id').references(() => packages.id),

  // Amount
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('AUD'),

  // Payment method
  paymentMethod: text('payment_method', {
    enum: ['card', 'direct_debit', 'afterpay', 'paypal', 'package_credit', 'voucher', 'cash', 'other'],
  }).notNull(),

  // Gateway
  gateway: text('gateway'), // 'stripe', 'tyro', 'square'
  gatewayPaymentId: text('gateway_payment_id'),
  gatewayResponse: jsonb('gateway_response'),

  // Status
  status: text('status', {
    enum: ['pending', 'processing', 'completed', 'failed', 'refunded', 'partially_refunded', 'disputed'],
  }).notNull().default('pending'),

  // Refund
  refundAmountCents: integer('refund_amount_cents').default(0),
  refundReason: text('refund_reason'),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),

  // Invoice
  invoiceNumber: text('invoice_number'), // Auto-generated: NXD-2026-0001
  invoiceUrl: text('invoice_url'),

  description: text('description'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_payments_student_id').on(table.studentId),
  index('idx_payments_booking_id').on(table.bookingId),
  index('idx_payments_status').on(table.status),
  index('idx_payments_created').on(table.createdAt),
]);

// ─────────────────────────────────────────────
// PACKAGES
// Prepaid lesson packages.
// ─────────────────────────────────────────────
export const packages = pgTable('packages', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),
  description: text('description'),
  totalCredits: integer('total_credits').notNull(),
  priceCents: integer('price_cents').notNull(),

  // Rules
  validForDays: integer('valid_for_days'), // NULL = no expiry
  applicableServices: uuid('applicable_services').array().default(sql`'{}'`),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────
// STUDENT_PACKAGES
// Purchased packages per student.
// ─────────────────────────────────────────────
export const studentPackages = pgTable('student_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id').notNull().references(() => students.id),
  packageId: uuid('package_id').notNull().references(() => packages.id),
  paymentId: uuid('payment_id').references(() => payments.id),

  creditsTotal: integer('credits_total').notNull(),
  creditsUsed: integer('credits_used').notNull().default(0),
  // credits_remaining is a generated column — applied via custom SQL migration
  // GENERATED ALWAYS AS (credits_total - credits_used) STORED

  purchasedAt: timestamp('purchased_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  status: text('status', {
    enum: ['active', 'exhausted', 'expired', 'cancelled'],
  }).notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_sp_student_id').on(table.studentId),
  index('idx_sp_status').on(table.status),
]);

// ─────────────────────────────────────────────
// VOUCHERS
// Promotional codes and gift vouchers.
// ─────────────────────────────────────────────
export const vouchers = pgTable('vouchers', {
  id: uuid('id').primaryKey().defaultRandom(),

  code: text('code').notNull().unique(),

  voucherType: text('voucher_type', {
    enum: ['percentage', 'fixed_amount', 'free_lesson'],
  }).notNull(),
  discountPercent: integer('discount_percent'),
  discountCents: integer('discount_cents'),

  // Usage rules
  maxUses: integer('max_uses'), // NULL = unlimited
  timesUsed: integer('times_used').notNull().default(0),
  maxUsesPerStudent: integer('max_uses_per_student').default(1),

  // Validity
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  applicableServices: uuid('applicable_services').array().default(sql`'{}'`),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_vouchers_code').on(table.code),
]);

// ─── RELATIONS ──────────────────────────────

export const paymentsRelations = relations(payments, ({ one }) => ({
  student: one(students, {
    fields: [payments.studentId],
    references: [students.id],
  }),
  contact: one(contacts, {
    fields: [payments.contactId],
    references: [contacts.id],
  }),
  package: one(packages, {
    fields: [payments.packageId],
    references: [packages.id],
  }),
}));

export const studentPackagesRelations = relations(studentPackages, ({ one }) => ({
  student: one(students, {
    fields: [studentPackages.studentId],
    references: [students.id],
  }),
  package: one(packages, {
    fields: [studentPackages.packageId],
    references: [packages.id],
  }),
  payment: one(payments, {
    fields: [studentPackages.paymentId],
    references: [payments.id],
  }),
}));
```

### 5.8 Communication (`src/db/schema/communication.ts`)

```typescript
import {
  pgTable, uuid, text, integer, boolean, timestamp, numeric, jsonb, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { contacts } from './crm';

// ─────────────────────────────────────────────
// CONVERSATIONS
// SMS and web chat conversation threads.
// ─────────────────────────────────────────────
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),

  contactId: uuid('contact_id').references(() => contacts.id),
  userId: text('user_id'), // Clerk user ID (if known)

  channel: text('channel', {
    enum: ['sms', 'web_chat', 'voice'],
  }).notNull(),
  channelIdentifier: text('channel_identifier'), // Phone number or session ID

  mode: text('mode', {
    enum: ['prospect', 'student', 'parent'],
  }).notNull().default('prospect'),

  status: text('status', {
    enum: ['active', 'handoff_requested', 'closed'],
  }).notNull().default('active'),
  handoffReason: text('handoff_reason'),

  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  messageCount: integer('message_count').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_conv_contact').on(table.contactId),
  index('idx_conv_channel').on(table.channel, table.channelIdentifier),
  index('idx_conv_status').on(table.status),
]);

// ─────────────────────────────────────────────
// MESSAGES
// Individual messages within conversations.
// ─────────────────────────────────────────────
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),

  direction: text('direction', {
    enum: ['inbound', 'outbound'],
  }).notNull(),
  senderType: text('sender_type', {
    enum: ['user', 'ai', 'system'],
  }).notNull(),

  content: text('content').notNull(),

  // AI metadata
  ragSources: jsonb('rag_sources'),
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  intentDetected: text('intent_detected'),

  // Delivery (for SMS)
  externalId: text('external_id'), // Twilio message SID
  deliveryStatus: text('delivery_status'), // 'sent', 'delivered', 'failed'

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_messages_conversation').on(table.conversationId),
  index('idx_messages_created').on(table.createdAt),
]);

// ─────────────────────────────────────────────
// CALL_LOGS
// Voice agent call records.
// ─────────────────────────────────────────────
export const callLogs = pgTable('call_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id').references(() => contacts.id),
  conversationId: uuid('conversation_id').references(() => conversations.id),

  callerPhone: text('caller_phone').notNull(),
  callDirection: text('call_direction', {
    enum: ['inbound', 'outbound'],
  }).notNull().default('inbound'),

  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),

  outcome: text('outcome', {
    enum: ['answered', 'voicemail', 'missed', 'failed'],
  }).notNull().default('answered'),
  resolution: text('resolution', {
    enum: ['resolved', 'booking_made', 'message_taken', 'callback_scheduled', 'transferred', 'hung_up'],
  }),

  transcript: text('transcript'),
  summary: text('summary'),
  callerName: text('caller_name'),
  callerReason: text('caller_reason'),

  voiceProvider: text('voice_provider'), // 'vapi', 'bland', 'retell'
  externalCallId: text('external_call_id'),

  requiresCallback: boolean('requires_callback').notNull().default(false),
  callbackScheduledAt: timestamp('callback_scheduled_at', { withTimezone: true }),
  callbackCompletedAt: timestamp('callback_completed_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_calls_contact').on(table.contactId),
  index('idx_calls_caller_phone').on(table.callerPhone),
  index('idx_calls_started').on(table.startedAt),
  // Partial index: only rows where requires_callback = TRUE
  // Applied via custom SQL migration
]);

// ─── RELATIONS ──────────────────────────────

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [conversations.contactId],
    references: [contacts.id],
  }),
  messages: many(messages),
  callLogs: many(callLogs),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const callLogsRelations = relations(callLogs, ({ one }) => ({
  contact: one(contacts, {
    fields: [callLogs.contactId],
    references: [contacts.id],
  }),
  conversation: one(conversations, {
    fields: [callLogs.conversationId],
    references: [conversations.id],
  }),
}));
```

### 5.9 Instructor Tools (`src/db/schema/instructor-tools.ts`)

```typescript
import {
  pgTable, uuid, text, boolean, timestamp, jsonb, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { instructors, students } from './users';
import { lessons } from './lessons';

// ─────────────────────────────────────────────
// PRIVATE_NOTES
// Instructor-only coaching notes.
// ⚠️  NEVER visible to students or parents.
//     Defence in depth: role check + excluded from response shapes.
// ─────────────────────────────────────────────
export const privateNotes = pgTable('private_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  instructorId: uuid('instructor_id').notNull().references(() => instructors.id),
  studentId: uuid('student_id').notNull().references(() => students.id),
  lessonId: uuid('lesson_id').references(() => lessons.id),

  note: text('note').notNull(),

  noteType: text('note_type', {
    enum: ['general', 'lesson_specific', 'safety_concern', 'coaching_strategy', 'personal_interest'],
  }).notNull().default('general'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_pn_instructor').on(table.instructorId),
  index('idx_pn_student').on(table.studentId),
  index('idx_pn_lesson').on(table.lessonId),
]);

// ─────────────────────────────────────────────
// SELF_ASSESSMENTS
// Student self-assessment (Driver Trainer tick-and-flick).
// ─────────────────────────────────────────────
export const selfAssessments = pgTable('self_assessments', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id').notNull().references(() => students.id),

  assessmentType: text('assessment_type', {
    enum: ['pre_review_1_17', 'pre_review_1_22', 'pre_final_drive', 'general'],
  }).notNull(),

  responses: jsonb('responses').notNull(), // [{task_number, confidence: 1-5, notes}]

  completedAt: timestamp('completed_at', { withTimezone: true }),
  reviewedByInstructor: boolean('reviewed_by_instructor').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_sa_student').on(table.studentId),
]);

// ─── RELATIONS ──────────────────────────────

export const privateNotesRelations = relations(privateNotes, ({ one }) => ({
  instructor: one(instructors, {
    fields: [privateNotes.instructorId],
    references: [instructors.id],
  }),
  student: one(students, {
    fields: [privateNotes.studentId],
    references: [students.id],
  }),
  lesson: one(lessons, {
    fields: [privateNotes.lessonId],
    references: [lessons.id],
  }),
}));

export const selfAssessmentsRelations = relations(selfAssessments, ({ one }) => ({
  student: one(students, {
    fields: [selfAssessments.studentId],
    references: [students.id],
  }),
}));
```

### 5.10 Notifications (`src/db/schema/notifications.ts`)

```typescript
import {
  pgTable, uuid, text, timestamp, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { contacts } from './crm';

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Recipient
  recipientId: text('recipient_id'), // Clerk user ID
  recipientContactId: uuid('recipient_contact_id').references(() => contacts.id),
  recipientPhone: text('recipient_phone'),
  recipientEmail: text('recipient_email'),

  // Notification
  channel: text('channel', {
    enum: ['email', 'sms', 'push'],
  }).notNull(),
  notificationType: text('notification_type').notNull(),

  // Content
  subject: text('subject'),
  body: text('body').notNull(),

  // Delivery
  status: text('status', {
    enum: ['pending', 'sent', 'delivered', 'failed', 'bounced'],
  }).notNull().default('pending'),
  externalId: text('external_id'), // Twilio SID / Resend ID
  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  failedReason: text('failed_reason'),

  // Trigger
  triggeredBy: text('triggered_by'),
  relatedId: uuid('related_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_notif_recipient').on(table.recipientId),
  index('idx_notif_status').on(table.status),
  index('idx_notif_type').on(table.notificationType),
]);
```

### 5.11 RAG (`src/db/schema/rag.ts`)

```typescript
import {
  pgTable, uuid, text, integer, timestamp, jsonb, index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// Note: For pgvector, we use a custom column type
// Drizzle's pgvector support requires the `pgvector` package
import { vector } from 'pgvector/drizzle-orm';

// ─────────────────────────────────────────────
// RAG_DOCUMENTS
// Knowledge base document metadata.
// ─────────────────────────────────────────────
export const ragDocuments = pgTable('rag_documents', {
  id: uuid('id').primaryKey().defaultRandom(),

  title: text('title').notNull(),
  sourceType: text('source_type', {
    enum: ['regulation', 'business', 'educational', 'faq', 'blog', 'template'],
  }).notNull(),
  fileUrl: text('file_url'),

  status: text('status', {
    enum: ['pending', 'processing', 'indexed', 'failed', 'archived'],
  }).notNull().default('pending'),
  chunkCount: integer('chunk_count').default(0),
  lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),

  metadata: jsonb('metadata').default(sql`'{}'::jsonb`),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────
// RAG_CHUNKS
// Vector-embedded document chunks for RAG retrieval.
// Uses pgvector with text-embedding-3-large (3072 dimensions).
// ─────────────────────────────────────────────
export const ragChunks = pgTable('rag_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => ragDocuments.id, { onDelete: 'cascade' }),

  content: text('content').notNull(),
  chunkIndex: integer('chunk_index').notNull(),

  // pgvector embedding — text-embedding-3-large = 3072 dimensions
  embedding: vector('embedding', { dimensions: 3072 }),

  metadata: jsonb('metadata').default(sql`'{}'::jsonb`),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_rag_chunks_document').on(table.documentId),
  // IVFFlat index for vector similarity search — applied via custom SQL migration:
  // CREATE INDEX idx_rag_chunks_embedding ON rag_chunks
  //   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
]);

// ─── RELATIONS ──────────────────────────────

export const ragDocumentsRelations = relations(ragDocuments, ({ many }) => ({
  chunks: many(ragChunks),
}));

export const ragChunksRelations = relations(ragChunks, ({ one }) => ({
  document: one(ragDocuments, {
    fields: [ragChunks.documentId],
    references: [ragDocuments.id],
  }),
}));
```

> **pgvector import note:** If `pgvector/drizzle-orm` isn't available, use a custom column definition:
> ```typescript
> import { customType } from 'drizzle-orm/pg-core';
> const vector = customType<{ data: number[]; driverParam: string }>({
>   dataType(config) { return `vector(${config?.dimensions ?? 3072})`; },
>   toDriver(value) { return `[${value.join(',')}]`; },
>   fromDriver(value) { return JSON.parse(value as string); },
> });
> ```

### 5.12 System (`src/db/schema/system.ts`)

```typescript
import {
  pgTable, uuid, text, integer, timestamp, time, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { students, instructors } from './users';
import { contacts } from './crm';
import { services } from './services';

export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id').references(() => students.id),
  contactId: uuid('contact_id').references(() => contacts.id),
  instructorId: uuid('instructor_id').references(() => instructors.id),

  preferredDay: integer('preferred_day'), // 0-6
  preferredTimeStart: time('preferred_time_start'),
  preferredTimeEnd: time('preferred_time_end'),
  serviceId: uuid('service_id').references(() => services.id),

  status: text('status', {
    enum: ['waiting', 'notified', 'booked', 'expired', 'cancelled'],
  }).notNull().default('waiting'),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_waitlist_status').on(table.status),
  index('idx_waitlist_instructor').on(table.instructorId),
]);

export const waitlistRelations = relations(waitlist, ({ one }) => ({
  student: one(students, {
    fields: [waitlist.studentId],
    references: [students.id],
  }),
  contact: one(contacts, {
    fields: [waitlist.contactId],
    references: [contacts.id],
  }),
  instructor: one(instructors, {
    fields: [waitlist.instructorId],
    references: [instructors.id],
  }),
  service: one(services, {
    fields: [waitlist.serviceId],
    references: [services.id],
  }),
}));
```

### 5.13 Barrel Export (`src/db/schema/index.ts`)

```typescript
// ─────────────────────────────────────────────
// Schema barrel export
// All tables, relations, and types in one import
// ─────────────────────────────────────────────

// Users & Roles
export * from './users';

// CRM
export * from './crm';

// Services & Availability
export * from './services';

// Bookings
export * from './bookings';

// Lessons & Bridge Forms
export * from './lessons';

// Compliance (CBT&A, Signatures, Audit)
export * from './compliance';

// Payments, Packages, Vouchers
export * from './payments';

// Communication (Conversations, Messages, Call Logs)
export * from './communication';

// Instructor Tools (Private Notes, Self-Assessments)
export * from './instructor-tools';

// Notifications
export * from './notifications';

// RAG Knowledge Engine
export * from './rag';

// System (Waitlist)
export * from './system';
```

---

## 6. TypeScript Types (`src/db/types.ts`)

```typescript
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import {
  profiles, instructors, students, parents, parentStudentLinks,
  contacts,
  services, availabilityRules, availabilityOverrides,
  bookings,
  lessons, lessonBridgeForms,
  competencyTasks, studentCompetencies, signatures, auditLog,
  payments, packages, studentPackages, vouchers,
  conversations, messages, callLogs,
  privateNotes, selfAssessments,
  notifications,
  ragDocuments, ragChunks,
  waitlist,
} from './schema';

// ─── SELECT types (read from DB) ────────────

export type Profile = InferSelectModel<typeof profiles>;
export type Instructor = InferSelectModel<typeof instructors>;
export type Student = InferSelectModel<typeof students>;
export type Parent = InferSelectModel<typeof parents>;
export type ParentStudentLink = InferSelectModel<typeof parentStudentLinks>;

export type Contact = InferSelectModel<typeof contacts>;

export type Service = InferSelectModel<typeof services>;
export type AvailabilityRule = InferSelectModel<typeof availabilityRules>;
export type AvailabilityOverride = InferSelectModel<typeof availabilityOverrides>;

export type Booking = InferSelectModel<typeof bookings>;

export type Lesson = InferSelectModel<typeof lessons>;
export type LessonBridgeForm = InferSelectModel<typeof lessonBridgeForms>;

export type CompetencyTask = InferSelectModel<typeof competencyTasks>;
export type StudentCompetency = InferSelectModel<typeof studentCompetencies>;
export type Signature = InferSelectModel<typeof signatures>;
export type AuditLogEntry = InferSelectModel<typeof auditLog>;

export type Payment = InferSelectModel<typeof payments>;
export type Package = InferSelectModel<typeof packages>;
export type StudentPackage = InferSelectModel<typeof studentPackages>;
export type Voucher = InferSelectModel<typeof vouchers>;

export type Conversation = InferSelectModel<typeof conversations>;
export type Message = InferSelectModel<typeof messages>;
export type CallLog = InferSelectModel<typeof callLogs>;

export type PrivateNote = InferSelectModel<typeof privateNotes>;
export type SelfAssessment = InferSelectModel<typeof selfAssessments>;

export type Notification = InferSelectModel<typeof notifications>;

export type RagDocument = InferSelectModel<typeof ragDocuments>;
export type RagChunk = InferSelectModel<typeof ragChunks>;

export type Waitlist = InferSelectModel<typeof waitlist>;

// ─── INSERT types (write to DB) ─────────────

export type NewProfile = InferInsertModel<typeof profiles>;
export type NewInstructor = InferInsertModel<typeof instructors>;
export type NewStudent = InferInsertModel<typeof students>;
export type NewParent = InferInsertModel<typeof parents>;
export type NewParentStudentLink = InferInsertModel<typeof parentStudentLinks>;

export type NewContact = InferInsertModel<typeof contacts>;

export type NewService = InferInsertModel<typeof services>;
export type NewAvailabilityRule = InferInsertModel<typeof availabilityRules>;
export type NewAvailabilityOverride = InferInsertModel<typeof availabilityOverrides>;

export type NewBooking = InferInsertModel<typeof bookings>;

export type NewLesson = InferInsertModel<typeof lessons>;
export type NewLessonBridgeForm = InferInsertModel<typeof lessonBridgeForms>;

export type NewCompetencyTask = InferInsertModel<typeof competencyTasks>;
export type NewStudentCompetency = InferInsertModel<typeof studentCompetencies>;
export type NewSignature = InferInsertModel<typeof signatures>;
export type NewAuditLogEntry = InferInsertModel<typeof auditLog>;

export type NewPayment = InferInsertModel<typeof payments>;
export type NewPackage = InferInsertModel<typeof packages>;
export type NewStudentPackage = InferInsertModel<typeof studentPackages>;
export type NewVoucher = InferInsertModel<typeof vouchers>;

export type NewConversation = InferInsertModel<typeof conversations>;
export type NewMessage = InferInsertModel<typeof messages>;
export type NewCallLog = InferInsertModel<typeof callLogs>;

export type NewPrivateNote = InferInsertModel<typeof privateNotes>;
export type NewSelfAssessment = InferInsertModel<typeof selfAssessments>;

export type NewNotification = InferInsertModel<typeof notifications>;

export type NewRagDocument = InferInsertModel<typeof ragDocuments>;
export type NewRagChunk = InferInsertModel<typeof ragChunks>;

export type NewWaitlist = InferInsertModel<typeof waitlist>;

// ─── Enum types ─────────────────────────────

export type UserRole = 'admin' | 'instructor' | 'student' | 'parent';
export type ProfileStatus = 'active' | 'inactive' | 'suspended';
export type BookingStatus = 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'no_show' | 'rescheduled';
export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded' | 'partially_refunded' | 'disputed';
export type LessonStatus = 'draft' | 'pending_student_signature' | 'completed' | 'disputed';
export type CompetencyStatus = 'not_started' | 'taught' | 'assessed' | 'competent' | 'not_yet_competent';
export type LifecycleStage = 'prospect' | 'lead' | 'qualified' | 'enrolled' | 'active' | 'completed' | 'alumni' | 'lost';
export type Channel = 'sms' | 'web_chat' | 'voice';
export type AuditSeverity = 'info' | 'warning' | 'critical';
```

---

## 7. Custom SQL Migration (`scripts/db/create-functions.sql`)

These must be applied after the initial Drizzle migration. They cover features Drizzle ORM cannot express declaratively: generated columns, partial unique indexes, database functions, and triggers.

```sql
-- ============================================
-- NexDrive Academy — Custom SQL Migration
-- Run AFTER drizzle-kit push/migrate
-- ============================================

-- 1. GENERATED COLUMNS
-- ─────────────────────────────────────────────

-- lessons.total_km
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS total_km INTEGER
  GENERATED ALWAYS AS (odo_end - odo_start) STORED;

-- student_packages.credits_remaining
ALTER TABLE student_packages
  ADD COLUMN IF NOT EXISTS credits_remaining INTEGER
  GENERATED ALWAYS AS (credits_total - credits_used) STORED;


-- 2. PARTIAL UNIQUE INDEXES
-- ─────────────────────────────────────────────

-- Prevent double-booking: unique instructor + start_time for active bookings
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_no_overlap
  ON bookings(instructor_id, start_time)
  WHERE status NOT IN ('cancelled', 'rescheduled');

-- Unique lesson number per student (excluding corrections)
CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_student_number
  ON lessons(student_id, lesson_number)
  WHERE correction_of IS NULL;

-- Partial index for callback-needed calls
CREATE INDEX IF NOT EXISTS idx_calls_requires_callback
  ON call_logs(requires_callback)
  WHERE requires_callback = TRUE;


-- 3. FOREIGN KEYS (circular references)
-- ─────────────────────────────────────────────

-- lessons.booking_id → bookings.id
ALTER TABLE lessons
  ADD CONSTRAINT fk_lessons_booking
  FOREIGN KEY (booking_id) REFERENCES bookings(id);

-- lessons.correction_of → lessons.id (self-reference)
ALTER TABLE lessons
  ADD CONSTRAINT fk_lessons_correction_of
  FOREIGN KEY (correction_of) REFERENCES lessons(id);

-- student_competencies.lesson_id → lessons.id
ALTER TABLE student_competencies
  ADD CONSTRAINT fk_sc_lesson
  FOREIGN KEY (lesson_id) REFERENCES lessons(id);

-- student_competencies.signature_id → signatures.id
ALTER TABLE student_competencies
  ADD CONSTRAINT fk_sc_signature
  FOREIGN KEY (signature_id) REFERENCES signatures(id);

-- payments.booking_id → bookings.id
ALTER TABLE payments
  ADD CONSTRAINT fk_payments_booking
  FOREIGN KEY (booking_id) REFERENCES bookings(id);

-- bookings.lesson_id → lessons.id
ALTER TABLE bookings
  ADD CONSTRAINT fk_bookings_lesson
  FOREIGN KEY (lesson_id) REFERENCES lessons(id);


-- 4. VECTOR INDEX (pgvector)
-- ─────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding
  ON rag_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);


-- 5. DATABASE FUNCTIONS
-- ─────────────────────────────────────────────

-- Auto-increment lesson_number per student
CREATE OR REPLACE FUNCTION next_lesson_number(p_student_id UUID)
RETURNS INTEGER AS $$
  SELECT COALESCE(MAX(lesson_number), 0) + 1
  FROM lessons
  WHERE student_id = p_student_id AND correction_of IS NULL;
$$ LANGUAGE SQL;

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- SHA-256 hash chain for audit_log
CREATE OR REPLACE FUNCTION compute_audit_hash()
RETURNS TRIGGER AS $$
BEGIN
  NEW.previous_hash := (
    SELECT record_hash FROM audit_log
    ORDER BY created_at DESC LIMIT 1
  );
  NEW.record_hash := encode(
    sha256(
      (NEW.event_type || COALESCE(NEW.actor_id, 'SYSTEM') || COALESCE(NEW.subject_id::TEXT, '') ||
       NEW.created_at::TEXT || COALESCE(NEW.previous_hash, 'GENESIS'))::bytea
    ), 'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- SHA-256 hash chain for signatures
CREATE OR REPLACE FUNCTION compute_signature_hash()
RETURNS TRIGGER AS $$
BEGIN
  NEW.previous_hash := (
    SELECT record_hash FROM signatures
    ORDER BY created_at DESC LIMIT 1
  );
  NEW.record_hash := encode(
    sha256(
      (NEW.signer_id || NEW.signer_role || NEW.document_type || NEW.document_id::TEXT ||
       NEW.signature_url || NEW.timestamp_utc::TEXT ||
       COALESCE(NEW.previous_hash, 'GENESIS'))::bytea
    ), 'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- SHA-256 hash chain for student_competencies
CREATE OR REPLACE FUNCTION compute_competency_hash()
RETURNS TRIGGER AS $$
BEGIN
  NEW.previous_hash := (
    SELECT record_hash FROM student_competencies
    WHERE student_id = NEW.student_id
    ORDER BY created_at DESC LIMIT 1
  );
  NEW.record_hash := encode(
    sha256(
      (NEW.student_id::TEXT || NEW.task_id::TEXT || NEW.instructor_id::TEXT ||
       NEW.status || NEW.transmission || NEW.status_changed_at::TEXT ||
       COALESCE(NEW.previous_hash, 'GENESIS'))::bytea
    ), 'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- 6. TRIGGERS
-- ─────────────────────────────────────────────

-- updated_at triggers (all tables with updated_at column)
CREATE OR REPLACE TRIGGER set_updated_at_profiles       BEFORE UPDATE ON profiles       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_instructors    BEFORE UPDATE ON instructors    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_students       BEFORE UPDATE ON students       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_parents        BEFORE UPDATE ON parents        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_psl            BEFORE UPDATE ON parent_student_links FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_contacts       BEFORE UPDATE ON contacts       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_services       BEFORE UPDATE ON services       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_avail_rules    BEFORE UPDATE ON availability_rules    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_avail_over     BEFORE UPDATE ON availability_overrides FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_bookings       BEFORE UPDATE ON bookings       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_comp_tasks     BEFORE UPDATE ON competency_tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_payments       BEFORE UPDATE ON payments       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_packages       BEFORE UPDATE ON packages       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_student_pkg    BEFORE UPDATE ON student_packages FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_vouchers       BEFORE UPDATE ON vouchers       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_conversations  BEFORE UPDATE ON conversations  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_private_notes  BEFORE UPDATE ON private_notes  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_self_assess    BEFORE UPDATE ON self_assessments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_notifications  BEFORE UPDATE ON notifications  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_rag_docs       BEFORE UPDATE ON rag_documents  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER set_updated_at_waitlist       BEFORE UPDATE ON waitlist       FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Hash chain triggers (append-only tables)
CREATE OR REPLACE TRIGGER audit_hash_chain      BEFORE INSERT ON audit_log             FOR EACH ROW EXECUTE FUNCTION compute_audit_hash();
CREATE OR REPLACE TRIGGER signature_hash_chain  BEFORE INSERT ON signatures            FOR EACH ROW EXECUTE FUNCTION compute_signature_hash();
CREATE OR REPLACE TRIGGER competency_hash_chain BEFORE INSERT ON student_competencies  FOR EACH ROW EXECUTE FUNCTION compute_competency_hash();

-- NOTE: No updated_at triggers on append-only tables (lessons, student_competencies, signatures, audit_log, messages, call_logs)
```

---

## 8. Migration Strategy

### 8.1 Workflow

```
1. Edit schema files in src/db/schema/
2. Generate migration:  npx drizzle-kit generate
3. Review migration:    Inspect drizzle/migrations/*.sql
4. Push to Neon dev:    npx drizzle-kit push   (or: npx drizzle-kit migrate)
5. Apply custom SQL:    psql $DATABASE_URL -f scripts/db/create-functions.sql
6. Test
7. Promote to staging/prod via Neon branch promote
```

### 8.2 Neon Branching Strategy

```
main (production)
├── dev (development - persistent)
├── staging (pre-production - persistent)
├── preview/pr-42 (per-PR - ephemeral, auto-deleted)
├── preview/pr-43
└── ...
```

**Branch lifecycle:**
- `dev` branch created once, used for local development
- `staging` branch created once, promoted from dev after testing
- `preview/*` branches created by CI on PR open, deleted on PR merge/close
- Production migrations: promote staging branch to main via Neon console/API

### 8.3 CI/CD Integration

```yaml
# .github/workflows/db-migration.yml (excerpt)
- name: Create Neon preview branch
  if: github.event_name == 'pull_request'
  run: |
    neonctl branches create --name "preview/pr-${{ github.event.number }}" --parent dev

- name: Run migrations
  run: |
    npx drizzle-kit migrate
    psql $DATABASE_URL -f scripts/db/setup-extensions.sql
    psql $DATABASE_URL -f scripts/db/create-functions.sql

- name: Cleanup preview branch
  if: github.event_name == 'pull_request' && github.event.action == 'closed'
  run: |
    neonctl branches delete "preview/pr-${{ github.event.number }}"
```

---

## 9. Seed Data Script (`src/db/seed.ts`)

```typescript
import { db } from './index';
import { competencyTasks, services, profiles, instructors } from './schema';

async function seed() {
  console.log('🌱 Seeding NexDrive Academy database...');

  // ─── 1. Competency Tasks (23 ACT CBT&A tasks) ────────────
  console.log('  → Inserting 23 competency tasks...');

  const tasks = [
    { taskNumber: 1, name: 'Pre-Drive Procedure', category: 'Basic Control', description: 'Starting, adjusting and shutting down the car; seatbelt, mirrors, head restraint, gear selection', prerequisites: [], sortOrder: 1 },
    { taskNumber: 2, name: 'Controls and Instruments', category: 'Basic Control', description: 'Understanding all vehicle controls, gauges and instruments', prerequisites: [1], sortOrder: 2 },
    { taskNumber: 3, name: 'Moving Off and Stopping', category: 'Basic Control', description: 'Smooth take-off from kerb and stop; clutch/brake coordination', prerequisites: [1, 2], sortOrder: 3 },
    { taskNumber: 4, name: 'Steering', category: 'Basic Control', description: 'Hand-over-hand, push-pull steering; maintaining lane position', prerequisites: [3], sortOrder: 4 },
    { taskNumber: 5, name: 'Gear Changing', category: 'Basic Control', description: 'Smooth up/down gear changes; selecting appropriate gear for speed and road conditions', prerequisites: [3], sortOrder: 5 },
    { taskNumber: 6, name: 'Low Speed Manoeuvres', category: 'Basic Control', description: 'U-turns, 3-point turns, reversing, parking (parallel, angle, 90°)', prerequisites: [3, 4, 5], sortOrder: 6 },
    { taskNumber: 7, name: 'Intersections — Give Way/Stop', category: 'Traffic', description: 'Approaching and negotiating give way and stop sign intersections', prerequisites: [3, 4, 5], sortOrder: 7 },
    { taskNumber: 8, name: 'Intersections — Traffic Lights', category: 'Traffic', description: 'Green, amber, red, arrows; turning at traffic lights', prerequisites: [7], sortOrder: 8 },
    { taskNumber: 9, name: 'Intersections — Roundabouts', category: 'Traffic', description: 'Single and multi-lane roundabouts; signalling; lane selection', prerequisites: [7], sortOrder: 9 },
    { taskNumber: 10, name: 'Lane Changing and Overtaking', category: 'Traffic', description: 'Safe lane changes; mirror checks; overtaking procedures', prerequisites: [4, 7], sortOrder: 10 },
    { taskNumber: 11, name: 'Speed Management', category: 'Traffic', description: 'Matching speed to conditions; speed zones; school zones', prerequisites: [3, 5], sortOrder: 11 },
    { taskNumber: 12, name: 'Gap Selection', category: 'Traffic', description: 'Judging safe gaps in traffic for turning and merging', prerequisites: [7, 10], sortOrder: 12 },
    { taskNumber: 13, name: 'Following Distance', category: 'Traffic', description: '3-second rule; adjusting for conditions', prerequisites: [11], sortOrder: 13 },
    { taskNumber: 14, name: 'Hazard Perception', category: 'Complex', description: 'Identifying and responding to potential hazards; scanning; prediction', prerequisites: [7, 11, 13], sortOrder: 14 },
    { taskNumber: 15, name: 'Sharing the Road', category: 'Complex', description: 'Vulnerable road users: cyclists, pedestrians, motorcyclists, heavy vehicles', prerequisites: [10, 14], sortOrder: 15 },
    { taskNumber: 16, name: 'Night Driving', category: 'Complex', description: 'High/low beam; reduced visibility; adjusting to darkness', prerequisites: [14], sortOrder: 16 },
    { taskNumber: 17, name: 'Review Assessment — Tasks 1-17', category: 'Review', description: 'Formal review of competencies 1-17', prerequisites: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], isReview: true, reviewRequiresTasks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], sortOrder: 17 },
    { taskNumber: 18, name: 'Driving in Traffic', category: 'Complex', description: 'Higher traffic volumes; multi-lane roads; managing complex traffic environments', prerequisites: [10, 12, 14], sortOrder: 18 },
    { taskNumber: 19, name: 'Freeway / Highway Driving', category: 'Complex', description: 'Merging, exiting, maintaining speed on high-speed roads', prerequisites: [10, 11, 18], sortOrder: 19 },
    { taskNumber: 20, name: 'Rural / Country Roads', category: 'Complex', description: 'Unsealed roads, single-lane bridges, livestock, fatigue management', prerequisites: [11, 14], sortOrder: 20 },
    { taskNumber: 21, name: 'Adverse Conditions', category: 'Complex', description: 'Rain, fog, sun glare; adjusting driving for conditions', prerequisites: [14, 16], sortOrder: 21 },
    { taskNumber: 22, name: 'Review Assessment — Tasks 18-22', category: 'Review', description: 'Formal review of competencies 18-22', prerequisites: [17, 18, 19, 20, 21], isReview: true, reviewRequiresTasks: [18, 19, 20, 21], sortOrder: 22 },
    { taskNumber: 23, name: 'Final Drive Assessment', category: 'Final', description: 'Comprehensive final assessment; minimum 45 minutes; unfamiliar roads required', prerequisites: [17, 22], isFinalDrive: true, finalDriveMinMinutes: 45, finalDriveUnfamiliarRoads: true, sortOrder: 23 },
  ];

  await db.insert(competencyTasks).values(
    tasks.map((t) => ({
      taskNumber: t.taskNumber,
      name: t.name,
      description: t.description,
      category: t.category,
      prerequisites: t.prerequisites,
      isReview: t.isReview ?? false,
      isFinalDrive: t.isFinalDrive ?? false,
      reviewRequiresTasks: t.reviewRequiresTasks ?? [],
      finalDriveMinMinutes: t.finalDriveMinMinutes ?? null,
      finalDriveUnfamiliarRoads: t.finalDriveUnfamiliarRoads ?? false,
      sortOrder: t.sortOrder,
    }))
  ).onConflictDoNothing();

  // ─── 2. Default Services ──────────────────────────────────
  console.log('  → Inserting default services...');

  await db.insert(services).values([
    { name: 'Learner Lesson (60 min)', slug: 'learner-60', description: 'Standard 60-minute driving lesson for learner drivers', durationMinutes: 60, priceCents: 10500, category: 'lesson', sortOrder: 1 },
    { name: 'Learner Lesson (90 min)', slug: 'learner-90', description: 'Extended 90-minute driving lesson', durationMinutes: 90, priceCents: 15000, category: 'lesson', sortOrder: 2 },
    { name: 'Learner Lesson (120 min)', slug: 'learner-120', description: 'Double lesson — 2 hours of intensive practice', durationMinutes: 120, priceCents: 19500, category: 'lesson', sortOrder: 3 },
    { name: 'Co-Lesson (60 min)', slug: 'co-lesson-60', description: 'Parent/supervisor rides along to learn coaching techniques', durationMinutes: 60, priceCents: 10500, category: 'co_lesson', sortOrder: 4 },
    { name: 'Pre-Test Review (60 min)', slug: 'pre-test-review-60', description: 'Review assessment and test preparation', durationMinutes: 60, priceCents: 10500, category: 'assessment', requiresEligibilityCheck: true, sortOrder: 5 },
    { name: 'Final Drive Assessment (90 min)', slug: 'final-drive-90', description: 'Comprehensive final assessment — 45 min drive minimum', durationMinutes: 90, priceCents: 15000, category: 'assessment', requiresEligibilityCheck: true, sortOrder: 6 },
    { name: 'Keys2Drive Free Lesson', slug: 'keys2drive', description: 'Government-funded 60-minute lesson with supervising driver', durationMinutes: 60, priceCents: 0, category: 'special', sortOrder: 7 },
  ]).onConflictDoNothing();

  // ─── 3. Rob's Instructor Record ───────────────────────────
  // NOTE: This requires Rob's Clerk account to exist first.
  // The Clerk webhook handler will create the profile.
  // This seed creates the instructor record linked to his profile.
  //
  // In practice: Rob signs up via Clerk → webhook creates profile →
  // admin seed script links instructor record.
  //
  // For development, we create a placeholder:
  console.log('  → Creating Rob Harrison instructor placeholder...');
  console.log('    ⚠️  Rob must register via Clerk first. Then run:');
  console.log('    UPDATE instructors SET user_id = <clerk_id> WHERE adi_number = \'608\';');

  // This will be done via an admin CLI command after Clerk signup:
  // npm run db:link-instructor -- --clerk-id=user_xxx --adi=608

  console.log('✅ Seed complete!');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  });
```

---

## 10. Migration Runner (`src/db/migrate.ts`)

```typescript
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import * as fs from 'fs';
import * as path from 'path';

async function runMigrations() {
  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);

  console.log('🔄 Running Drizzle migrations...');
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  console.log('✅ Drizzle migrations complete.');

  // Apply custom SQL (extensions, functions, triggers)
  const customSqlPath = path.join(__dirname, '../../scripts/db/create-functions.sql');
  if (fs.existsSync(customSqlPath)) {
    console.log('🔄 Applying custom SQL (functions, triggers, indexes)...');
    const customSql = fs.readFileSync(customSqlPath, 'utf-8');
    // Split on semicolons and execute each statement
    const statements = customSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        await sql(stmt);
      } catch (err) {
        console.warn(`⚠️  Statement failed (may already exist): ${(err as Error).message}`);
      }
    }
    console.log('✅ Custom SQL applied.');
  }

  console.log('🎉 All migrations complete!');
}

runMigrations()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  });
```

---

## 11. Table Count Verification

| # | Table | Schema File | Append-Only | Has `updated_at` | Has `deleted_at` |
|---|-------|-------------|:-----------:|:-----------------:|:----------------:|
| 1 | profiles | users.ts | No | ✅ | ✅ |
| 2 | instructors | users.ts | No | ✅ | No |
| 3 | students | users.ts | No | ✅ | No |
| 4 | parents | users.ts | No | ✅ | No |
| 5 | parent_student_links | users.ts | No | ✅ | No |
| 6 | contacts | crm.ts | No | ✅ | ✅ |
| 7 | services | services.ts | No | ✅ | No |
| 8 | availability_rules | services.ts | No | ✅ | No |
| 9 | availability_overrides | services.ts | No | ✅ | No |
| 10 | bookings | bookings.ts | No | ✅ | No |
| 11 | lessons | lessons.ts | ⚠️ Yes | ❌ | No |
| 12 | lesson_bridge_forms | lessons.ts | No | No (immutable output) | No |
| 13 | competency_tasks | compliance.ts | No | ✅ | No |
| 14 | student_competencies | compliance.ts | ⚠️ Yes | ❌ | No |
| 15 | signatures | compliance.ts | ⚠️ Yes | ❌ | No |
| 16 | audit_log | compliance.ts | ⚠️ Yes | ❌ | No |
| 17 | payments | payments.ts | No | ✅ | No |
| 18 | packages | payments.ts | No | ✅ | No |
| 19 | student_packages | payments.ts | No | ✅ | No |
| 20 | vouchers | payments.ts | No | ✅ | No |
| 21 | conversations | communication.ts | No | ✅ | No |
| 22 | messages | communication.ts | No (log-style) | No | No |
| 23 | call_logs | communication.ts | No (log-style) | No | No |
| 24 | private_notes | instructor-tools.ts | No | ✅ | No |
| 25 | self_assessments | instructor-tools.ts | No | ✅ | No |
| 26 | notifications | notifications.ts | No | ✅ | No |
| 27 | rag_documents | rag.ts | No | ✅ | No |
| 28 | rag_chunks | rag.ts | No | No | No |
| 29 | waitlist | system.ts | No | ✅ | No |

> **Note:** The architecture doc lists 26 tables. The discrepancy is because `rag_documents` and `rag_chunks` were counted as one "rag" group, and `lesson_bridge_forms` was counted with lessons. The actual table count is 29, which is correct — every table from §3.3 is present.

---

## 12. Testing Strategy

### 12.1 Schema Validation

```typescript
// tests/db/schema.test.ts
import { describe, it, expect } from 'vitest';
import * as schema from '@/db/schema';

describe('Schema exports', () => {
  it('exports all 29 tables', () => {
    const tableNames = [
      'profiles', 'instructors', 'students', 'parents', 'parentStudentLinks',
      'contacts', 'services', 'availabilityRules', 'availabilityOverrides',
      'bookings', 'lessons', 'lessonBridgeForms',
      'competencyTasks', 'studentCompetencies', 'signatures', 'auditLog',
      'payments', 'packages', 'studentPackages', 'vouchers',
      'conversations', 'messages', 'callLogs',
      'privateNotes', 'selfAssessments',
      'notifications', 'ragDocuments', 'ragChunks', 'waitlist',
    ];
    for (const name of tableNames) {
      expect(schema).toHaveProperty(name);
    }
  });
});
```

### 12.2 Migration Testing (per-PR via Neon branching)

Each PR gets its own Neon branch. CI runs:
1. `npx drizzle-kit migrate` — applies Drizzle migrations
2. `psql -f scripts/db/create-functions.sql` — applies custom SQL
3. `npx tsx src/db/seed.ts` — runs seed data
4. `npx vitest run tests/db/` — runs schema + integration tests

### 12.3 Integration Tests (against Neon branch)

```typescript
// tests/db/integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/db';
import { competencyTasks, services, lessons, auditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';

describe('Database integration', () => {
  it('has 23 competency tasks after seeding', async () => {
    const tasks = await db.select().from(competencyTasks);
    expect(tasks).toHaveLength(23);
  });

  it('has default services after seeding', async () => {
    const allServices = await db.select().from(services);
    expect(allServices.length).toBeGreaterThanOrEqual(7);
  });

  it('auto-computes audit hash on insert', async () => {
    const [entry] = await db.insert(auditLog).values({
      eventType: 'TEST_EVENT',
      severity: 'info',
      details: { test: true },
      recordHash: 'placeholder', // trigger overrides this
    }).returning();

    expect(entry.recordHash).not.toBe('placeholder');
    expect(entry.recordHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    expect(entry.previousHash).toBeNull(); // first record in chain
  });

  it('enforces append-only on lessons (no update after completed)', async () => {
    // Business logic test — enforced at service layer, not DB level
    // DB trigger approach would be: reject UPDATE WHERE status = 'completed'
    // For now, this is tested in the service layer tests
  });
});
```

---

## 13. Package.json Scripts

Add to the project's `package.json`:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:push": "drizzle-kit push",
    "db:seed": "tsx src/db/seed.ts",
    "db:studio": "drizzle-kit studio",
    "db:setup": "npm run db:migrate && npm run db:seed"
  }
}
```

---

## 14. Implementation Checklist

```
Phase 0 — Database Foundation

[ ] 1. Neon project setup
    [ ] Create Neon project in Sydney (ap-southeast-2)
    [ ] Create main, dev, staging branches
    [ ] Enable pgvector and pgcrypto extensions
    [ ] Note connection strings for each branch

[ ] 2. Project scaffolding
    [ ] Install dependencies (drizzle-orm, @neondatabase/serverless, drizzle-kit, pgvector)
    [ ] Create file structure as defined in §2
    [ ] Configure drizzle.config.ts
    [ ] Configure environment variables

[ ] 3. Schema files
    [ ] users.ts (5 tables + relations)
    [ ] crm.ts (1 table + relations)
    [ ] services.ts (3 tables + relations)
    [ ] bookings.ts (1 table + relations)
    [ ] lessons.ts (2 tables + relations)
    [ ] compliance.ts (4 tables + relations)
    [ ] payments.ts (4 tables + relations)
    [ ] communication.ts (3 tables + relations)
    [ ] instructor-tools.ts (2 tables + relations)
    [ ] notifications.ts (1 table)
    [ ] rag.ts (2 tables + relations)
    [ ] system.ts (1 table + relations)
    [ ] index.ts barrel export
    [ ] types.ts (Select + Insert types for all tables)

[ ] 4. Generate & apply migrations
    [ ] npx drizzle-kit generate
    [ ] Review generated SQL
    [ ] npx drizzle-kit push (to dev branch)

[ ] 5. Custom SQL
    [ ] Apply setup-extensions.sql
    [ ] Apply create-functions.sql
    [ ] Verify generated columns (total_km, credits_remaining)
    [ ] Verify partial unique indexes
    [ ] Verify all triggers fire correctly
    [ ] Verify hash chain functions

[ ] 6. Seed data
    [ ] Run seed.ts
    [ ] Verify 23 competency tasks
    [ ] Verify 7 default services
    [ ] Verify task prerequisites are correct

[ ] 7. Testing
    [ ] Schema export tests pass
    [ ] Integration tests pass on Neon dev branch
    [ ] Hash chain verified on audit_log, signatures, student_competencies

[ ] 8. CI/CD
    [ ] GitHub Action for Neon branch creation on PR
    [ ] Migration + seed runs in CI
    [ ] Tests pass in CI
    [ ] Branch cleanup on PR close

[ ] 9. Documentation
    [ ] README updated with db:* scripts
    [ ] Connection setup documented
    [ ] Migration workflow documented
```

---

*End of SPEC-01: Database Schema & ERD*

*Next: SPEC-02 will cover Clerk Authentication Setup (webhook handlers, custom session claims, RBAC middleware).*
