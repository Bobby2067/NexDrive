/**
 * NexDrive Academy — Drizzle ORM Schema
 * Single source of truth for all 26 database tables.
 *
 * Architecture rules enforced here:
 *  - All PKs are UUID (gen_random_uuid)
 *  - Clerk identity stored as TEXT clerk_user_id — NOT a FK
 *  - instructor_id on every tenant-scoped table (multi-instructor)
 *  - Append-only tables (lessons, student_competencies, signatures, audit_log) — NO updatedAt
 *  - Monetary values stored as integer cents
 *  - Australian data residency: Neon Sydney (ap-southeast-2)
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  date,
  time,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
// 1. USERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * profiles — Extended user data for every role.
 * Clerk owns authentication. We store business data here.
 * clerkUserId is TEXT — never a FK, never null for registered users.
 */
export const profiles = pgTable('profiles', {
  id:            uuid('id').primaryKey().defaultRandom(),
  clerkUserId:   text('clerk_user_id').notNull().unique(),

  firstName:     text('first_name').notNull(),
  lastName:      text('last_name'),
  email:         text('email').notNull(),
  phone:         text('phone'),                  // AU format: +61XXXXXXXXX

  dateOfBirth:   date('date_of_birth'),

  addressLine1:  text('address_line1'),
  addressLine2:  text('address_line2'),
  suburb:        text('suburb'),
  state:         text('state').default('ACT'),
  postcode:      text('postcode'),

  role: text('role', {
    enum: ['admin', 'instructor', 'student', 'parent'],
  }).notNull(),

  status: text('status', {
    enum: ['active', 'inactive', 'suspended'],
  }).notNull().default('active'),

  onboardedAt:   timestamp('onboarded_at', { withTimezone: true }),
  avatarUrl:     text('avatar_url'),

  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt:     timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  idx_profiles_clerk_user_id: index('idx_profiles_clerk_user_id').on(t.clerkUserId),
  idx_profiles_role: index('idx_profiles_role').on(t.role),
  idx_profiles_email: index('idx_profiles_email').on(t.email),
  idx_profiles_phone: index('idx_profiles_phone').on(t.phone),
}));


/**
 * instructors — Instructor-specific data.
 * One row per instructor, linked to profiles.
 */
export const instructors = pgTable('instructors', {
  id:              uuid('id').primaryKey().defaultRandom(),
  profileId:       uuid('profile_id').references(() => profiles.id).notNull(),

  // ADI certification
  adiNumber:       text('adi_number'),
  adiExpiresAt:    date('adi_expires_at'),

  // Business
  businessName:    text('business_name'),
  abn:             text('abn'),
  licenceNumber:   text('licence_number'),

  // Vehicle
  vehicleMake:     text('vehicle_make'),
  vehicleModel:    text('vehicle_model'),
  vehicleYear:     integer('vehicle_year'),
  vehicleColour:   text('vehicle_colour'),
  vehiclePlate:    text('vehicle_plate'),

  bio:             text('bio'),
  isActive:        boolean('is_active').notNull().default(true),

  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_instructors_profile_id: uniqueIndex('idx_instructors_profile_id').on(t.profileId),
}));


/**
 * students — Student-specific data.
 */
export const students = pgTable('students', {
  id:              uuid('id').primaryKey().defaultRandom(),
  profileId:       uuid('profile_id').references(() => profiles.id).notNull(),
  instructorId:    uuid('instructor_id').references(() => instructors.id).notNull(),

  // ACT licence
  licenceNumber:   text('licence_number'),
  licenceClass:    text('licence_class'),
  licenceExpiresAt: date('licence_expires_at'),

  // Logbook (legacy paper tracking)
  logbookHours:    integer('logbook_hours').default(0),
  nightHours:      integer('night_hours').default(0),

  // ACT learner requirements
  requiredHours:   integer('required_hours').default(100),
  isActive:        boolean('is_active').notNull().default(true),

  enrolledAt:      timestamp('enrolled_at', { withTimezone: true }),
  graduatedAt:     timestamp('graduated_at', { withTimezone: true }),

  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_students_profile_id: uniqueIndex('idx_students_profile_id').on(t.profileId),
  idx_students_instructor_id: index('idx_students_instructor_id').on(t.instructorId),
}));


/**
 * parents — Parent/guardian profile extension.
 */
export const parents = pgTable('parents', {
  id:          uuid('id').primaryKey().defaultRandom(),
  profileId:   uuid('profile_id').references(() => profiles.id).notNull(),
  relationship: text('relationship'),             // 'parent', 'guardian', 'carer'
  isActive:    boolean('is_active').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_parents_profile_id: uniqueIndex('idx_parents_profile_id').on(t.profileId),
}));


/**
 * parent_student_links — Many-to-many parents ↔ students.
 */
export const parentStudentLinks = pgTable('parent_student_links', {
  id:          uuid('id').primaryKey().defaultRandom(),
  parentId:    uuid('parent_id').references(() => parents.id).notNull(),
  studentId:   uuid('student_id').references(() => students.id).notNull(),
  canViewLessons:   boolean('can_view_lessons').notNull().default(true),
  canViewProgress:  boolean('can_view_progress').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_parent_student_unique: uniqueIndex('idx_parent_student_unique').on(t.parentId, t.studentId),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 2. CRM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * contacts — CRM leads and prospects.
 * lifecycle: prospect → lead → qualified → enrolled → active → completed
 */
export const contacts = pgTable('contacts', {
  id:            uuid('id').primaryKey().defaultRandom(),
  instructorId:  uuid('instructor_id').references(() => instructors.id),
  profileId:     uuid('profile_id').references(() => profiles.id),  // NULL until account created

  firstName:     text('first_name'),
  lastName:      text('last_name'),
  email:         text('email'),
  phone:         text('phone'),                   // Primary SMS identifier

  lifecycle: text('lifecycle', {
    enum: ['prospect', 'lead', 'qualified', 'enrolled', 'active', 'completed', 'alumni', 'lost', 'inactive'],
  }).notNull().default('prospect'),

  leadScore:     integer('lead_score').default(0),

  source:        text('source'),                  // 'website', 'phone', 'sms', 'referral', 'google', 'facebook'
  sourceDetail:  text('source_detail'),
  utmSource:     text('utm_source'),
  utmMedium:     text('utm_medium'),
  utmCampaign:   text('utm_campaign'),

  firstContactAt:    timestamp('first_contact_at', { withTimezone: true }).defaultNow(),
  lastContactAt:     timestamp('last_contact_at', { withTimezone: true }).defaultNow(),
  totalInteractions: integer('total_interactions').default(1),

  notes:         text('notes'),                   // INSTRUCTOR-visible only — NOT student/parent

  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt:     timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  idx_contacts_instructor_id: index('idx_contacts_instructor_id').on(t.instructorId),
  idx_contacts_profile_id: index('idx_contacts_profile_id').on(t.profileId),
  idx_contacts_phone: index('idx_contacts_phone').on(t.phone),
  idx_contacts_email: index('idx_contacts_email').on(t.email),
  idx_contacts_lifecycle: index('idx_contacts_lifecycle').on(t.lifecycle),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 3. SERVICES & AVAILABILITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * services — Lesson types and pricing.
 */
export const services = pgTable('services', {
  id:              uuid('id').primaryKey().defaultRandom(),
  instructorId:    uuid('instructor_id').references(() => instructors.id).notNull(),
  name:            text('name').notNull(),
  description:     text('description'),
  durationMinutes: integer('duration_minutes').notNull().default(60),
  priceCents:      integer('price_cents').notNull(),  // integer cents — no floats
  isActive:        boolean('is_active').notNull().default(true),
  isPublic:        boolean('is_public').notNull().default(true),
  sortOrder:       integer('sort_order').default(0),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_services_instructor_id: index('idx_services_instructor_id').on(t.instructorId),
  idx_services_active: index('idx_services_active').on(t.isActive),
}));


/**
 * availability_rules — Recurring weekly availability.
 * dayOfWeek: 0=Sun, 1=Mon ... 6=Sat (JS convention)
 */
export const availabilityRules = pgTable('availability_rules', {
  id:           uuid('id').primaryKey().defaultRandom(),
  instructorId: uuid('instructor_id').references(() => instructors.id).notNull(),
  dayOfWeek:    integer('day_of_week').notNull(),   // 0-6
  startTime:    text('start_time').notNull(),        // "HH:MM" 24hr
  endTime:      text('end_time').notNull(),          // "HH:MM" 24hr
  isActive:     boolean('is_active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_availability_rules_instructor: index('idx_availability_rules_instructor').on(t.instructorId),
}));


/**
 * availability_overrides — One-off exceptions to weekly rules.
 */
export const availabilityOverrides = pgTable('availability_overrides', {
  id:           uuid('id').primaryKey().defaultRandom(),
  instructorId: uuid('instructor_id').references(() => instructors.id).notNull(),
  date:         timestamp('date', { withTimezone: true }).notNull(),
  isAvailable:  boolean('is_available').notNull().default(false),
  startTime:    text('start_time'),
  endTime:      text('end_time'),
  reason:       text('reason'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_availability_overrides_instructor: index('idx_availability_overrides_instructor').on(t.instructorId),
  idx_availability_overrides_date: index('idx_availability_overrides_date').on(t.date),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 4. BOOKINGS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * bookings — Scheduled lesson appointments.
 */
export const bookings = pgTable('bookings', {
  id:              uuid('id').primaryKey().defaultRandom(),
  instructorId:    uuid('instructor_id').references(() => instructors.id).notNull(),
  studentId:       uuid('student_id').references(() => students.id).notNull(),
  serviceId:       uuid('service_id').references(() => services.id),
  contactId:       uuid('contact_id').references(() => contacts.id),

  scheduledAt:     timestamp('scheduled_at', { withTimezone: true }).notNull(),
  durationMinutes: integer('duration_minutes').notNull().default(60),

  status: text('status', {
    enum: ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show', 'rescheduled'],
  }).notNull().default('pending'),

  meetingLocation: text('meeting_location'),
  notes:           text('notes'),
  cancellationReason: text('cancellation_reason'),
  cancelledAt:     timestamp('cancelled_at', { withTimezone: true }),
  confirmedAt:     timestamp('confirmed_at', { withTimezone: true }),
  completedAt:     timestamp('completed_at', { withTimezone: true }),

  // Stripe/payment link
  paymentId:       uuid('payment_id'),

  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_bookings_instructor_id: index('idx_bookings_instructor_id').on(t.instructorId),
  idx_bookings_student_id: index('idx_bookings_student_id').on(t.studentId),
  idx_bookings_scheduled_at: index('idx_bookings_scheduled_at').on(t.scheduledAt),
  idx_bookings_status: index('idx_bookings_status').on(t.status),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 5. LESSONS (APPEND-ONLY — Form 10.044 digital records)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * lessons — The official digital lesson record. APPEND-ONLY.
 * Equivalent to ACT Form 10.044. Hash chain for tamper evidence.
 * NO updatedAt — corrections create new linked records.
 */
export const lessons = pgTable('lessons', {
  id:            uuid('id').primaryKey().defaultRandom(),
  bookingId:     uuid('booking_id').references(() => bookings.id),
  instructorId:  uuid('instructor_id').references(() => instructors.id).notNull(),
  studentId:     uuid('student_id').references(() => students.id).notNull(),

  // Lesson date/time
  lessonDate:    date('lesson_date').notNull(),
  startTime:     text('start_time').notNull(),     // "HH:MM"
  endTime:       text('end_time').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),

  // Vehicle odometer
  odoStart:      integer('odo_start'),
  odoEnd:        integer('odo_end'),
  // total_km is a GENERATED column — see create-functions.sql

  // Location
  startLocation: text('start_location'),
  endLocation:   text('end_location'),
  suburb:        text('suburb'),

  // Weather / conditions
  conditions:    text('conditions'),               // 'fine', 'rain', 'wet', 'night', 'heavy_rain'

  // Instructor observations
  instructorNotes: text('instructor_notes'),       // Shown to student on completion

  status: text('status', {
    enum: ['draft', 'pending_student_signature', 'completed', 'disputed'],
  }).notNull().default('draft'),

  // Correction chain (append-only correction pattern)
  isCorrection:   boolean('is_correction').notNull().default(false),
  correctsLessonId: uuid('corrects_lesson_id'),   // FK to the lesson being corrected

  // Hash chain (SHA-256 of this row + previous hash)
  rowHash:       text('row_hash'),
  prevHash:      text('prev_hash'),

  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_lessons_instructor_id: index('idx_lessons_instructor_id').on(t.instructorId),
  idx_lessons_student_id: index('idx_lessons_student_id').on(t.studentId),
  idx_lessons_date: index('idx_lessons_date').on(t.lessonDate),
  idx_lessons_status: index('idx_lessons_status').on(t.status),
}));


/**
 * lesson_bridge_forms — Pre/post lesson student reflection forms.
 */
export const lessonBridgeForms = pgTable('lesson_bridge_forms', {
  id:          uuid('id').primaryKey().defaultRandom(),
  lessonId:    uuid('lesson_id').references(() => lessons.id),
  studentId:   uuid('student_id').references(() => students.id).notNull(),
  formType:    text('form_type', { enum: ['pre', 'post'] }).notNull(),

  // Dynamic JSON responses (form fields vary per lesson type)
  responses:   jsonb('responses').default(sql`'{}'`),

  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_bridge_forms_lesson_id: index('idx_bridge_forms_lesson_id').on(t.lessonId),
  idx_bridge_forms_student_id: index('idx_bridge_forms_student_id').on(t.studentId),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 6. COMPLIANCE — CBT&A, SIGNATURES, AUDIT (ALL APPEND-ONLY)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * competency_tasks — ACT CBT&A 23 tasks. Seed data only.
 * Static reference table managed by system admin.
 */
export const competencyTasks = pgTable('competency_tasks', {
  id:          uuid('id').primaryKey().defaultRandom(),
  taskNumber:  integer('task_number').notNull().unique(), // 1-23
  title:       text('title').notNull(),
  description: text('description'),
  category:    text('category').notNull(),               // 'basic', 'intermediate', 'advanced', 'hazard'
  prerequisites: integer('prerequisites').array().default(sql`'{}'`), // task_numbers
  isActive:    boolean('is_active').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * student_competencies — Per-task competency records. APPEND-ONLY.
 * Each new assessment creates a new row. Hash chain for tamper evidence.
 */
export const studentCompetencies = pgTable('student_competencies', {
  id:            uuid('id').primaryKey().defaultRandom(),
  studentId:     uuid('student_id').references(() => students.id).notNull(),
  instructorId:  uuid('instructor_id').references(() => instructors.id).notNull(),
  taskId:        uuid('task_id').references(() => competencyTasks.id).notNull(),
  lessonId:      uuid('lesson_id').references(() => lessons.id),

  status: text('status', {
    enum: ['not_started', 'introduced', 'practiced', 'competent', 'not_yet_competent'],
  }).notNull(),

  attemptNumber: integer('attempt_number').notNull().default(1),
  instructorObservations: text('instructor_observations'),
  evidenceUrl:   text('evidence_url'),             // R2 signed URL to evidence doc/photo

  // Hash chain
  rowHash:       text('row_hash'),
  prevHash:      text('prev_hash'),

  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_competencies_student_id: index('idx_competencies_student_id').on(t.studentId),
  idx_competencies_task_id: index('idx_competencies_task_id').on(t.taskId),
  idx_competencies_lesson_id: index('idx_competencies_lesson_id').on(t.lessonId),
}));


/**
 * signatures — Electronic signatures. IMMUTABLE once created.
 * Used for lesson records, CBT&A sign-offs, and consent.
 */
export const signatures = pgTable('signatures', {
  id:            uuid('id').primaryKey().defaultRandom(),
  signerProfileId: uuid('signer_profile_id').references(() => profiles.id).notNull(),
  signerRole:    text('signer_role', { enum: ['instructor', 'student', 'parent'] }).notNull(),

  // What is being signed
  entityType:    text('entity_type').notNull(),    // 'lesson', 'competency', 'consent'
  entityId:      uuid('entity_id').notNull(),

  // Signature data
  signatureUrl:  text('signature_url'),            // R2 path to SVG/PNG
  signatureHash: text('signature_hash').notNull(), // SHA-256 of the signature image

  // Capture metadata (for legal non-repudiation)
  ipAddress:     text('ip_address'),
  userAgent:     text('user_agent'),
  deviceType:    text('device_type'),              // 'mobile', 'tablet', 'desktop'

  signedAt:      timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_signatures_signer: index('idx_signatures_signer').on(t.signerProfileId),
  idx_signatures_entity: index('idx_signatures_entity').on(t.entityType, t.entityId),
}));


/**
 * audit_log — Append-only event log. NEVER UPDATE OR DELETE.
 * Hash chain from first row to last. Used for compliance audits.
 */
export const auditLog = pgTable('audit_log', {
  id:            uuid('id').primaryKey().defaultRandom(),
  actorProfileId: uuid('actor_profile_id'),       // NULL for system events

  action:        text('action').notNull(),         // 'BOOKING_CREATED', 'LESSON_COMPLETED', etc.
  entityType:    text('entity_type').notNull(),
  entityId:      uuid('entity_id'),
  payload:       jsonb('payload').default(sql`'{}'`),

  severity: text('severity', {
    enum: ['info', 'warning', 'critical'],
  }).notNull().default('info'),

  ipAddress:     text('ip_address'),
  userAgent:     text('user_agent'),

  // Hash chain
  rowHash:       text('row_hash'),
  prevHash:      text('prev_hash'),

  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_audit_log_actor: index('idx_audit_log_actor').on(t.actorProfileId),
  idx_audit_log_entity: index('idx_audit_log_entity').on(t.entityType, t.entityId),
  idx_audit_log_action: index('idx_audit_log_action').on(t.action),
  idx_audit_log_created_at: index('idx_audit_log_created_at').on(t.createdAt),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 7. PAYMENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * payments — Payment records. All amounts in cents (AUD).
 */
export const payments = pgTable('payments', {
  id:            uuid('id').primaryKey().defaultRandom(),
  instructorId:  uuid('instructor_id').references(() => instructors.id).notNull(),
  studentId:     uuid('student_id').references(() => students.id),
  contactId:     uuid('contact_id').references(() => contacts.id),
  bookingId:     uuid('booking_id').references(() => bookings.id),
  packageId:     uuid('package_id'),               // FK to packages (set after insert)

  amountCents:   integer('amount_cents').notNull(),
  currency:      text('currency').notNull().default('AUD'),

  status: text('status', {
    enum: ['pending', 'processing', 'completed', 'failed', 'refunded', 'partially_refunded', 'disputed'],
  }).notNull().default('pending'),

  // Provider (adapter pattern — Stripe, Tyro, Square)
  provider:      text('provider').notNull().default('stripe'),
  providerRef:   text('provider_ref'),             // Stripe PaymentIntent ID
  providerSessionId: text('provider_session_id'),  // Stripe Checkout Session ID

  description:   text('description'),
  voucherCode:   text('voucher_code'),
  discountCents: integer('discount_cents').default(0),

  paidAt:        timestamp('paid_at', { withTimezone: true }),
  refundedAt:    timestamp('refunded_at', { withTimezone: true }),
  refundedCents: integer('refunded_cents').default(0),
  refundReason:  text('refund_reason'),

  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_payments_instructor_id: index('idx_payments_instructor_id').on(t.instructorId),
  idx_payments_student_id: index('idx_payments_student_id').on(t.studentId),
  idx_payments_status: index('idx_payments_status').on(t.status),
  idx_payments_provider_ref: index('idx_payments_provider_ref').on(t.providerRef),
}));


/**
 * packages — Lesson bundle products.
 */
export const packages = pgTable('packages', {
  id:            uuid('id').primaryKey().defaultRandom(),
  instructorId:  uuid('instructor_id').references(() => instructors.id).notNull(),
  name:          text('name').notNull(),
  description:   text('description'),
  lessonCredits: integer('lesson_credits').notNull(),
  priceCents:    integer('price_cents').notNull(),
  validityDays:  integer('validity_days').notNull().default(365),
  isActive:      boolean('is_active').notNull().default(true),
  sortOrder:     integer('sort_order').default(0),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_packages_instructor_id: index('idx_packages_instructor_id').on(t.instructorId),
}));


/**
 * student_packages — Purchased package instances.
 * credits_remaining is a GENERATED column — see create-functions.sql
 */
export const studentPackages = pgTable('student_packages', {
  id:            uuid('id').primaryKey().defaultRandom(),
  studentId:     uuid('student_id').references(() => students.id).notNull(),
  packageId:     uuid('package_id').references(() => packages.id).notNull(),
  paymentId:     uuid('payment_id').references(() => payments.id),

  creditsTotal:  integer('credits_total').notNull(),
  creditsUsed:   integer('credits_used').notNull().default(0),
  // credits_remaining is GENERATED: creditsTotal - creditsUsed

  expiresAt:     timestamp('expires_at', { withTimezone: true }),
  isActive:      boolean('is_active').notNull().default(true),

  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_student_packages_student_id: index('idx_student_packages_student_id').on(t.studentId),
  idx_student_packages_active: index('idx_student_packages_active').on(t.isActive),
}));


/**
 * vouchers — Discount codes.
 */
export const vouchers = pgTable('vouchers', {
  id:            uuid('id').primaryKey().defaultRandom(),
  code:          text('code').notNull().unique(),

  voucherType: text('voucher_type', {
    enum: ['percentage', 'fixed_amount', 'free_lesson'],
  }).notNull(),

  discountPercent: integer('discount_percent'),
  discountCents:   integer('discount_cents'),

  maxUses:        integer('max_uses'),             // NULL = unlimited
  timesUsed:      integer('times_used').notNull().default(0),
  maxUsesPerStudent: integer('max_uses_per_student').default(1),

  validFrom:      timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  validUntil:     timestamp('valid_until', { withTimezone: true }),
  applicableServices: uuid('applicable_services').array().default(sql`'{}'`),

  isActive:       boolean('is_active').notNull().default(true),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_vouchers_code: uniqueIndex('idx_vouchers_code').on(t.code),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 8. COMMUNICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * conversations — SMS / web chat threads.
 */
export const conversations = pgTable('conversations', {
  id:            uuid('id').primaryKey().defaultRandom(),
  instructorId:  uuid('instructor_id').references(() => instructors.id).notNull(),
  contactId:     uuid('contact_id').references(() => contacts.id),
  profileId:     uuid('profile_id').references(() => profiles.id),

  channel: text('channel', {
    enum: ['sms', 'web_chat', 'voice'],
  }).notNull(),

  // Phone number for SMS threads
  phoneNumber:   text('phone_number'),

  status: text('status', {
    enum: ['open', 'closed', 'pending'],
  }).notNull().default('open'),

  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  assignedTo:    uuid('assigned_to').references(() => profiles.id),

  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_conversations_instructor_id: index('idx_conversations_instructor_id').on(t.instructorId),
  idx_conversations_contact_id: index('idx_conversations_contact_id').on(t.contactId),
  idx_conversations_phone: index('idx_conversations_phone').on(t.phoneNumber),
  idx_conversations_status: index('idx_conversations_status').on(t.status),
}));


/**
 * messages — Individual messages within a conversation.
 */
export const messages = pgTable('messages', {
  id:               uuid('id').primaryKey().defaultRandom(),
  conversationId:   uuid('conversation_id').references(() => conversations.id).notNull(),

  direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
  body:      text('body').notNull(),

  // Sender (NULL for AI/automated)
  senderProfileId:  uuid('sender_profile_id').references(() => profiles.id),
  isAiGenerated:    boolean('is_ai_generated').notNull().default(false),

  // Delivery
  externalId:   text('external_id'),              // Twilio message SID
  status: text('status', {
    enum: ['queued', 'sending', 'sent', 'delivered', 'failed', 'received'],
  }).notNull().default('queued'),
  failedReason: text('failed_reason'),

  sentAt:       timestamp('sent_at', { withTimezone: true }),
  deliveredAt:  timestamp('delivered_at', { withTimezone: true }),

  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_messages_conversation_id: index('idx_messages_conversation_id').on(t.conversationId),
  idx_messages_created_at: index('idx_messages_created_at').on(t.createdAt),
}));


/**
 * call_logs — Voice call records (Retell AI).
 */
export const callLogs = pgTable('call_logs', {
  id:             uuid('id').primaryKey().defaultRandom(),
  instructorId:   uuid('instructor_id').references(() => instructors.id).notNull(),
  contactId:      uuid('contact_id').references(() => contacts.id),
  conversationId: uuid('conversation_id').references(() => conversations.id),

  // Retell AI call reference
  externalCallId: text('external_call_id').unique(),
  phoneNumber:    text('phone_number'),

  direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
  durationSeconds: integer('duration_seconds'),

  status: text('status', {
    enum: ['initiated', 'ringing', 'in_progress', 'completed', 'failed', 'voicemail'],
  }).notNull().default('initiated'),

  // Retell AI transcript and analysis
  transcript:     text('transcript'),
  summary:        text('summary'),
  sentiment:      text('sentiment'),              // 'positive', 'neutral', 'negative'
  intent:         text('intent'),                 // 'booking', 'inquiry', 'callback_request', etc.
  actionsTaken:   jsonb('actions_taken').default(sql`'[]'`),

  recordingUrl:   text('recording_url'),           // R2 path

  startedAt:      timestamp('started_at', { withTimezone: true }),
  endedAt:        timestamp('ended_at', { withTimezone: true }),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_call_logs_instructor_id: index('idx_call_logs_instructor_id').on(t.instructorId),
  idx_call_logs_contact_id: index('idx_call_logs_contact_id').on(t.contactId),
  idx_call_logs_external: index('idx_call_logs_external').on(t.externalCallId),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 9. INSTRUCTOR TOOLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * private_notes — Instructor-only notes.
 * DEFENCE IN DEPTH: NEVER visible to students or parents.
 * Enforced at: (1) service layer role check, (2) API response shape exclusion.
 */
export const privateNotes = pgTable('private_notes', {
  id:            uuid('id').primaryKey().defaultRandom(),
  instructorId:  uuid('instructor_id').references(() => instructors.id).notNull(),
  studentId:     uuid('student_id').references(() => students.id),
  contactId:     uuid('contact_id').references(() => contacts.id),
  lessonId:      uuid('lesson_id').references(() => lessons.id),

  content:       text('content').notNull(),
  tags:          text('tags').array().default(sql`'{}'`),

  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt:     timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  idx_private_notes_instructor_id: index('idx_private_notes_instructor_id').on(t.instructorId),
  idx_private_notes_student_id: index('idx_private_notes_student_id').on(t.studentId),
}));


/**
 * self_assessments — Student self-assessment results.
 */
export const selfAssessments = pgTable('self_assessments', {
  id:          uuid('id').primaryKey().defaultRandom(),
  studentId:   uuid('student_id').references(() => students.id).notNull(),
  lessonId:    uuid('lesson_id').references(() => lessons.id),

  // JSON array of { taskId, confidenceRating (1-5), comment }
  responses:   jsonb('responses').notNull().default(sql`'[]'`),

  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_self_assessments_student_id: index('idx_self_assessments_student_id').on(t.studentId),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 10. NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const notifications = pgTable('notifications', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  recipientProfileId:  text('recipient_profile_id'),     // Clerk user ID
  recipientContactId:  uuid('recipient_contact_id').references(() => contacts.id),
  recipientPhone:      text('recipient_phone'),
  recipientEmail:      text('recipient_email'),

  channel: text('channel', { enum: ['email', 'sms', 'push'] }).notNull(),
  notificationType:    text('notification_type').notNull(),

  subject:      text('subject'),
  body:         text('body').notNull(),

  status: text('status', {
    enum: ['pending', 'sent', 'delivered', 'failed', 'bounced'],
  }).notNull().default('pending'),

  externalId:   text('external_id'),              // Twilio SID / Resend ID
  sentAt:       timestamp('sent_at', { withTimezone: true }),
  deliveredAt:  timestamp('delivered_at', { withTimezone: true }),
  failedReason: text('failed_reason'),

  triggeredBy:  text('triggered_by'),
  relatedId:    uuid('related_id'),

  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_notifications_recipient: index('idx_notifications_recipient').on(t.recipientProfileId),
  idx_notifications_status: index('idx_notifications_status').on(t.status),
  idx_notifications_type: index('idx_notifications_type').on(t.notificationType),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 11. RAG KNOWLEDGE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * rag_documents — Knowledge base document metadata.
 */
export const ragDocuments = pgTable('rag_documents', {
  id:           uuid('id').primaryKey().defaultRandom(),
  instructorId: uuid('instructor_id').references(() => instructors.id),

  title:        text('title').notNull(),
  description:  text('description'),
  fileUrl:      text('file_url'),                 // R2 path
  fileType:     text('file_type'),                // 'pdf', 'txt', 'md', 'url'
  sourceUrl:    text('source_url'),               // For web-scraped docs

  category: text('category', {
    enum: ['faq', 'pricing', 'process', 'policy', 'act_regulations', 'cbta', 'general'],
  }).notNull().default('general'),

  chunkCount:   integer('chunk_count').default(0),
  tokenCount:   integer('token_count').default(0),

  isActive:     boolean('is_active').notNull().default(true),
  lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),

  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_rag_documents_category: index('idx_rag_documents_category').on(t.category),
  idx_rag_documents_instructor: index('idx_rag_documents_instructor').on(t.instructorId),
}));


/**
 * rag_chunks — Embedding chunks for vector search.
 * NOTE: The `embedding` vector(3072) column is added via raw SQL migration
 * (create-functions.sql) because Drizzle's pgvector support requires
 * the pgvector package and a custom column type.
 */
export const ragChunks = pgTable('rag_chunks', {
  id:           uuid('id').primaryKey().defaultRandom(),
  documentId:   uuid('document_id').references(() => ragDocuments.id).notNull(),

  content:      text('content').notNull(),
  chunkIndex:   integer('chunk_index').notNull(),
  tokenCount:   integer('token_count').notNull(),

  // embedding vector(3072) — added via create-functions.sql
  // Uses OpenAI text-embedding-3-large (3072 dimensions)

  metadata:     jsonb('metadata').default(sql`'{}'`),

  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_rag_chunks_document_id: index('idx_rag_chunks_document_id').on(t.documentId),
}));


// ─────────────────────────────────────────────────────────────────────────────
// 12. SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * waitlist — Students/contacts waiting for availability.
 */
export const waitlist = pgTable('waitlist', {
  id:           uuid('id').primaryKey().defaultRandom(),
  instructorId: uuid('instructor_id').references(() => instructors.id).notNull(),
  studentId:    uuid('student_id').references(() => students.id),
  contactId:    uuid('contact_id').references(() => contacts.id),
  serviceId:    uuid('service_id').references(() => services.id),

  preferredDay:       integer('preferred_day'),  // 0-6
  preferredTimeStart: time('preferred_time_start'),
  preferredTimeEnd:   time('preferred_time_end'),

  status: text('status', {
    enum: ['waiting', 'notified', 'booked', 'expired', 'cancelled'],
  }).notNull().default('waiting'),

  notifiedAt:   timestamp('notified_at', { withTimezone: true }),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idx_waitlist_instructor_id: index('idx_waitlist_instructor_id').on(t.instructorId),
  idx_waitlist_status: index('idx_waitlist_status').on(t.status),
}));


// ─────────────────────────────────────────────────────────────────────────────
// DRIZZLE RELATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const profilesRelations = relations(profiles, ({ one }) => ({
  instructor: one(instructors, { fields: [profiles.id], references: [instructors.profileId] }),
  student:    one(students,    { fields: [profiles.id], references: [students.profileId] }),
  parent:     one(parents,     { fields: [profiles.id], references: [parents.profileId] }),
}));

export const instructorsRelations = relations(instructors, ({ one, many }) => ({
  profile:              one(profiles, { fields: [instructors.profileId], references: [profiles.id] }),
  contacts:             many(contacts),
  bookings:             many(bookings),
  lessons:              many(lessons),
  services:             many(services),
  availabilityRules:    many(availabilityRules),
  availabilityOverrides: many(availabilityOverrides),
  payments:             many(payments),
  packages:             many(packages),
  conversations:        many(conversations),
  callLogs:             many(callLogs),
  privateNotes:         many(privateNotes),
  students:             many(students),
  waitlist:             many(waitlist),
}));

export const studentsRelations = relations(students, ({ one, many }) => ({
  profile:           one(profiles, { fields: [students.profileId], references: [profiles.id] }),
  instructor:        one(instructors, { fields: [students.instructorId], references: [instructors.id] }),
  bookings:          many(bookings),
  lessons:           many(lessons),
  competencies:      many(studentCompetencies),
  payments:          many(payments),
  studentPackages:   many(studentPackages),
  bridgeForms:       many(lessonBridgeForms),
  selfAssessments:   many(selfAssessments),
  privateNotes:      many(privateNotes),
  waitlist:          many(waitlist),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  instructor:    one(instructors, { fields: [contacts.instructorId], references: [instructors.id] }),
  profile:       one(profiles,   { fields: [contacts.profileId],    references: [profiles.id] }),
  conversations: many(conversations),
  callLogs:      many(callLogs),
  bookings:      many(bookings),
  notifications: many(notifications),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  instructor: one(instructors, { fields: [bookings.instructorId], references: [instructors.id] }),
  student:    one(students,    { fields: [bookings.studentId],    references: [students.id] }),
  service:    one(services,    { fields: [bookings.serviceId],    references: [services.id] }),
  contact:    one(contacts,    { fields: [bookings.contactId],    references: [contacts.id] }),
  lessons:    many(lessons),
  payments:   many(payments),
}));

export const lessonsRelations = relations(lessons, ({ one, many }) => ({
  booking:      one(bookings,    { fields: [lessons.bookingId],    references: [bookings.id] }),
  instructor:   one(instructors, { fields: [lessons.instructorId], references: [instructors.id] }),
  student:      one(students,    { fields: [lessons.studentId],    references: [students.id] }),
  competencies: many(studentCompetencies),
  bridgeForms:  many(lessonBridgeForms),
  privateNotes: many(privateNotes),
  selfAssessments: many(selfAssessments),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  instructor: one(instructors, { fields: [payments.instructorId], references: [instructors.id] }),
  student:    one(students,    { fields: [payments.studentId],    references: [students.id] }),
  contact:    one(contacts,    { fields: [payments.contactId],    references: [contacts.id] }),
  package:    one(packages,    { fields: [payments.packageId],    references: [packages.id] }),
  booking:    one(bookings,    { fields: [payments.bookingId],    references: [bookings.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  instructor: one(instructors, { fields: [conversations.instructorId], references: [instructors.id] }),
  contact:    one(contacts,    { fields: [conversations.contactId],    references: [contacts.id] }),
  messages:   many(messages),
}));
