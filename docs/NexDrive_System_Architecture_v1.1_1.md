# NexDrive Academy — System Architecture
### BMAD Phase 3 | System Architect Agent
**Version:** 1.0  
**Date:** 20 February 2026  
**Status:** In Progress  
**Depends On:** Product Brief v2.0, Component Function Map v1.0  
**Feeds Into:** Sprint Planning (Phase 4), Developer Stories (Phase 5), Component Specs

---

## 1. Architecture Principles

### 1.1 Guiding Decisions

| Principle | Decision | Rationale |
|-----------|----------|-----------|
| Multi-tenant from day one | Every table includes `instructor_id` where relevant | Avoids painful migration when adding contractors |
| API-first | All business logic exposed via REST APIs | Components are independently buildable and replaceable |
| Australian data residency | All infrastructure in `ap-southeast-2` (Sydney) | Non-negotiable for student/financial data sovereignty |
| Offline-capable | Instructor workstation works without connectivity | Rob is in a car — mobile signal isn't guaranteed |
| Audit-immutable | Append-only patterns for compliance data | ACT Government audit requires tamper-evident records |
| Channel-agnostic AI | Single RAG engine serves voice, SMS, and web chat | One knowledge base, consistent answers across all channels |
| Build for replacement | Each component behind an interface/adapter | Can swap voice API provider, payment gateway, etc. without rewiring |
| Progressive enhancement | Each phase delivers standalone value | No "big bang" — Phase 1 is useful without Phase 2 |

### 1.2 Technology Stack (Confirmed)

| Layer | Technology | Version/Service | AU Region |
|-------|-----------|----------------|-----------|
| **Runtime** | Node.js | 20 LTS | — |
| **Language** | TypeScript | 5.x | — |
| **Framework** | Next.js | 14.x (App Router) | — |
| **Styling** | TailwindCSS | 3.x | — |
| **Database** | Neon (Serverless PostgreSQL) | 16+ | ✅ Sydney (ap-southeast-2) |
| **ORM** | Drizzle ORM | Latest | — |
| **Auth** | Clerk | — | Edge (global) |
| **File Storage** | Cloudflare R2 | — | ✅ Sydney (APAC) |
| **Cache** | Upstash Redis | — | ✅ Sydney |
| **AI/LLM** | Claude API (Anthropic) | claude-sonnet-4-5 | — |
| **Embeddings** | OpenAI text-embedding-3-large | — | — |
| **Vector DB** | Neon pgvector | — | ✅ Sydney |
| **Voice Agent** | Vapi.ai / Bland.ai / Retell.ai | TBD after eval | — |
| **SMS** | Twilio | — | AU number |
| **Email** | Resend | — | — |
| **Payments** | TBD (Stripe/Tyro/Square) | — | AU |
| **Hosting (Frontend)** | Vercel | — | Edge (Sydney PoP) |
| **Hosting (API)** | Vercel Functions (Node.js runtime) | — | ✅ Sydney (iad1 or syd1) |
| **Analytics** | PostHog + GA4 | — | — |
| **Error Tracking** | Sentry | — | — |
| **CI/CD** | GitHub Actions | — | — |

---

## 2. High-Level System Architecture

```
                                    ┌─────────────┐
                                    │   INTERNET   │
                                    └──────┬───────┘
                                           │
                    ┌──────────────────────┬┼┬──────────────────────┐
                    │                      │││                      │
              ┌─────▼─────┐         ┌──────▼▼▼──────┐       ┌─────▼─────┐
              │  Twilio    │         │    Vercel      │       │ Voice API │
              │  (SMS)     │         │  (Next.js)     │       │ (Vapi.ai) │
              └─────┬──────┘         └───────┬────────┘       └─────┬─────┘
                    │                        │                      │
                    │    ┌───────────────────┼──────────────────┐   │
                    │    │          API GATEWAY / ROUTES        │   │
                    │    │  ┌──────┐ ┌──────┐ ┌──────┐ ┌─────┐│   │
                    └────┼─►│ SMS  │ │ Chat │ │ Book │ │Voice││◄──┘
                         │  │ API  │ │ API  │ │ API  │ │ API ││
                         │  └──┬───┘ └──┬───┘ └──┬───┘ └──┬──┘│
                         │     │        │        │        │    │
                         │  ┌──▼────────▼────────▼────────▼──┐│
                         │  │       SERVICE LAYER             ││
                         │  │ ┌─────────┐ ┌────────────────┐ ││
                         │  │ │   RAG   │ │ Booking Engine │ ││
                         │  │ │ Engine  │ │                │ ││
                         │  │ └────┬────┘ └───────┬────────┘ ││
                         │  │ ┌────┴────┐ ┌───────┴────────┐ ││
                         │  │ │   CRM   │ │ Payment Engine │ ││
                         │  │ │         │ │                │ ││
                         │  │ └────┬────┘ └───────┬────────┘ ││
                         │  │ ┌────┴────┐ ┌───────┴────────┐ ││
                         │  │ │ CBT&A   │ │ Notification   │ ││
                         │  │ │ Engine  │ │ Engine         │ ││
                         │  │ └────┬────┘ └───────┬────────┘ ││
                         │  │ ┌────┴────┐ ┌───────┴────────┐ ││
                         │  │ │ E-Sign  │ │ Audit Trail    │ ││
                         │  │ │ Service │ │                │ ││
                         │  │ └─────────┘ └────────────────┘ ││
                         │  └────────────────┬────────────────┘│
                         └───────────────────┼─────────────────┘
                                             │
                         ┌───────────────────┼─────────────────┐
                         │          DATA LAYER                  │
                         │  ┌──────────┐  ┌──────────────────┐ │
                         │  │PostgreSQL│  │  Cloudflare R2     │ │
                         │  │+ pgvector│  │  (Files/Sigs)    │ │
                         │  └──────────┘  └──────────────────┘ │
                         │  ┌──────────┐  ┌──────────────────┐ │
                         │  │  Redis   │  │  Clerk (Auth)    │ │
                         │  │ (Cache)  │  │  (JWT/RBAC)      │ │
                         │  └──────────┘  └──────────────────┘ │
                         └─────────────────────────────────────┘
```

---

## 3. Database Schema

### 3.1 Schema Design Principles
- All tables use UUID primary keys (`gen_random_uuid()`)
- All tables include `created_at` and `updated_at` timestamps
- Soft delete via `deleted_at` where applicable (never hard delete compliance data)
- **Application-level RBAC** via Clerk middleware (not database-level RLS)
- `clerk_user_id` (TEXT) references Clerk's external user ID — NOT a foreign key to a local auth table
- `instructor_id` on all tenant-scoped tables (multi-tenant from day one)
- Audit-critical tables are append-only (no UPDATE/DELETE)
- All monetary values stored as integers in cents (avoid floating point)
- **Neon branching** used for dev/staging database isolation

### 3.1.1 Auth Model: Clerk + Neon

Clerk owns user identity, authentication, sessions, and MFA. Our database stores business data linked to Clerk user IDs.

```
Clerk (External)                    Neon (Our Database)
┌──────────────┐                    ┌──────────────────┐
│ Users        │   clerk_user_id    │ profiles         │
│ Sessions     │──────────────────►│ instructors      │
│ MFA          │   (TEXT, not FK)   │ students         │
│ Orgs/Roles   │                    │ parents          │
│ Webhooks ────┼──────────────────►│ (sync on events) │
└──────────────┘                    └──────────────────┘

- Clerk webhook → /api/v1/webhooks/clerk → upsert profile on user.created, user.updated
- Clerk session token contains: user_id, role (custom claim), org_id
- Every API route: Clerk middleware verifies session → extracts user_id + role → queries DB
- No database-level RLS — all access control in application middleware
```

### 3.2 Entity Relationship Overview

```
users 1──────M profiles
  │
  ├── 1──────1 instructors
  ├── 1──────1 students
  └── 1──────1 parents
                  │
students M───────M parents  (via parent_student_links)
  │
  ├── 1──────M bookings
  ├── 1──────M lessons
  ├── 1──────M student_competencies
  ├── 1──────M payments
  ├── 1──────M self_assessments
  └── 1──────M conversations
  
instructors 1────M bookings
  │
  ├── 1──────M lessons
  ├── 1──────M availability_rules
  ├── 1──────M availability_overrides
  └── 1──────M private_notes

lessons 1────────M signatures
  │
  └── 1──────1 lesson_bridge_forms

services 1───────M bookings
packages 1───────M package_credits
vouchers ────────  (standalone, redeemed via payments)
```

### 3.3 Complete Table Definitions

---

#### `users`
Clerk manages identity and auth externally. This table stores business profile data linked via clerk_user_id.

```sql
```

---

#### `profiles`
Extended user data for all user types.

```sql
CREATE TABLE profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL UNIQUE,              -- Clerk user ID,
  
  -- Identity
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,                          -- AU format: +61XXXXXXXXX
  date_of_birth   DATE,
  
  -- Address
  address_line1   TEXT,
  address_line2   TEXT,
  suburb          TEXT,
  state           TEXT DEFAULT 'ACT',
  postcode        TEXT,
  
  -- Role
  role            TEXT NOT NULL CHECK (role IN ('admin', 'instructor', 'student', 'parent')),
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  onboarded_at    TIMESTAMPTZ,
  
  -- Avatar
  avatar_url      TEXT,
  
  -- Meta
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_profiles_user_id ON profiles(user_id);
CREATE INDEX idx_profiles_role ON profiles(role);
CREATE INDEX idx_profiles_email ON profiles(email);
CREATE INDEX idx_profiles_phone ON profiles(phone);
```

---

#### `instructors`
Instructor-specific data. One row per instructor.

```sql
CREATE TABLE instructors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL UNIQUE,              -- Clerk user ID,
  profile_id      UUID NOT NULL UNIQUE REFERENCES profiles(id),
  
  -- ADI Details (ACT Government)
  adi_number      TEXT NOT NULL,                 -- e.g., '608'
  adi_expiry      DATE NOT NULL,
  
  -- Vehicle
  vehicle_rego    TEXT,                          -- e.g., 'YNX 26N'
  vehicle_make    TEXT,
  vehicle_model   TEXT,
  vehicle_year    INTEGER,
  transmission    TEXT CHECK (transmission IN ('manual', 'auto', 'both')),
  
  -- Business
  is_owner        BOOLEAN NOT NULL DEFAULT FALSE, -- Platform owner (Rob) vs contractor
  hourly_rate     INTEGER,                        -- Cents (e.g., 10500 = $105.00)
  commission_rate NUMERIC(5,4),                   -- If applicable for contractors
  territory       TEXT,                           -- Service area description
  bio             TEXT,                           -- Public bio for website
  
  -- Availability defaults
  default_buffer_minutes  INTEGER NOT NULL DEFAULT 15,   -- Gap between lessons
  max_lessons_per_day     INTEGER NOT NULL DEFAULT 8,
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'onboarding', 'suspended')),
  verified_at     TIMESTAMPTZ,                   -- Admin verified credentials
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_instructors_user_id ON instructors(user_id);
CREATE INDEX idx_instructors_adi_number ON instructors(adi_number);
```

---

#### `students`
Student-specific data. One row per student.

```sql
CREATE TABLE students (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL UNIQUE,              -- Clerk user ID,
  profile_id      UUID NOT NULL UNIQUE REFERENCES profiles(id),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),  -- Assigned instructor
  
  -- Licence
  licence_number  TEXT,
  licence_type    TEXT CHECK (licence_type IN ('learner', 'provisional', 'full')),
  licence_expiry  DATE,
  
  -- Learning
  transmission    TEXT NOT NULL DEFAULT 'auto' CHECK (transmission IN ('manual', 'auto')),
  school_or_work  TEXT,                          -- School/workplace (per Form 10.044)
  
  -- Logbook
  total_hours     NUMERIC(6,2) DEFAULT 0,        -- Total logged practice hours
  night_hours     NUMERIC(6,2) DEFAULT 0,        -- Night hours logged
  professional_hours NUMERIC(6,2) DEFAULT 0,     -- Hours with ADI (3:1 credit)
  
  -- Privacy
  parent_visibility BOOLEAN NOT NULL DEFAULT TRUE, -- Student controls this
  
  -- Progress
  enrollment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  estimated_test_date DATE,
  completion_date DATE,                          -- When all competencies achieved
  certificate_issued_at TIMESTAMPTZ,
  certificate_number TEXT,                       -- Form 165751 serial number
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'completed', 'suspended', 'archived')),
  
  -- Source/Marketing
  referral_source TEXT,                          -- How they found NexDrive
  referral_detail TEXT,                          -- Specific referral info
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_students_user_id ON students(user_id);
CREATE INDEX idx_students_instructor_id ON students(instructor_id);
CREATE INDEX idx_students_status ON students(status);
CREATE INDEX idx_students_licence_number ON students(licence_number);
```

---

#### `parents`
Parent/supervisor-specific data.

```sql
CREATE TABLE parents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL UNIQUE,              -- Clerk user ID,
  profile_id      UUID NOT NULL UNIQUE REFERENCES profiles(id),
  
  -- Driving details (useful for co-lessons)
  licence_type    TEXT,
  years_driving   INTEGER,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_parents_user_id ON parents(user_id);
```

---

#### `parent_student_links`
Many-to-many relationship between parents and students with privacy controls.

```sql
CREATE TABLE parent_student_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       UUID NOT NULL REFERENCES parents(id),
  student_id      UUID NOT NULL REFERENCES students(id),
  
  -- Relationship
  relationship    TEXT NOT NULL DEFAULT 'parent' CHECK (relationship IN ('parent', 'guardian', 'supervisor', 'other')),
  
  -- Privacy (controlled by STUDENT, not parent)
  can_view_progress   BOOLEAN NOT NULL DEFAULT TRUE,
  can_view_bookings   BOOLEAN NOT NULL DEFAULT TRUE,
  can_view_payments   BOOLEAN NOT NULL DEFAULT TRUE,
  can_view_lesson_notes BOOLEAN NOT NULL DEFAULT TRUE,
  can_view_bridge_forms BOOLEAN NOT NULL DEFAULT TRUE,
  can_book_lessons    BOOLEAN NOT NULL DEFAULT TRUE,
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'revoked')),
  invited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at     TIMESTAMPTZ,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(parent_id, student_id)
);

CREATE INDEX idx_psl_parent_id ON parent_student_links(parent_id);
CREATE INDEX idx_psl_student_id ON parent_student_links(student_id);
```

---

#### `contacts`
CRM records for ALL contact types — including prospects who haven't registered.

```sql
CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT,                                        -- Clerk user ID (NULL for prospects without accounts
  instructor_id   UUID REFERENCES instructors(id),  -- Assigned instructor (if any)
  
  -- Identity
  first_name      TEXT,
  last_name       TEXT,
  email           TEXT,
  phone           TEXT,                              -- Primary identifier for SMS leads
  
  -- CRM
  lifecycle_stage TEXT NOT NULL DEFAULT 'prospect' 
    CHECK (lifecycle_stage IN ('prospect', 'lead', 'qualified', 'enrolled', 'active', 'completed', 'alumni', 'lost')),
  lead_score      INTEGER DEFAULT 0,
  
  -- Source tracking
  source          TEXT,                              -- 'website', 'phone', 'sms', 'referral', 'google', 'facebook'
  source_detail   TEXT,                              -- Campaign name, referrer name, etc.
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  
  -- Interaction tracking
  first_contact_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_contact_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_interactions  INTEGER NOT NULL DEFAULT 1,
  
  -- Notes
  notes           TEXT,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_contacts_user_id ON contacts(user_id);
CREATE INDEX idx_contacts_phone ON contacts(phone);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_lifecycle ON contacts(lifecycle_stage);
CREATE INDEX idx_contacts_instructor_id ON contacts(instructor_id);
```

---

#### `services`
Lesson types and pricing configuration.

```sql
CREATE TABLE services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Definition
  name            TEXT NOT NULL,                     -- 'Learner Lesson (60 min)'
  slug            TEXT NOT NULL UNIQUE,               -- 'learner-60'
  description     TEXT,
  duration_minutes INTEGER NOT NULL,                  -- 60, 90, 120
  
  -- Pricing
  price_cents     INTEGER NOT NULL,                   -- e.g., 10500 = $105.00
  
  -- Categorisation
  category        TEXT NOT NULL CHECK (category IN ('lesson', 'co_lesson', 'assessment', 'special')),
  
  -- Booking rules
  is_bookable_online BOOLEAN NOT NULL DEFAULT TRUE,
  requires_eligibility_check BOOLEAN NOT NULL DEFAULT FALSE, -- e.g., review needs prerequisites
  min_notice_hours INTEGER NOT NULL DEFAULT 24,       -- Minimum booking notice
  
  -- Display
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  color           TEXT,                               -- Calendar colour code
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_services_slug ON services(slug);
CREATE INDEX idx_services_active ON services(is_active);
```

---

#### `availability_rules`
Recurring weekly availability per instructor.

```sql
CREATE TABLE availability_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),
  
  -- Recurrence
  day_of_week     INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sun, 6=Sat
  start_time      TIME NOT NULL,                     -- e.g., '08:00'
  end_time        TIME NOT NULL,                     -- e.g., '17:00'
  
  -- Validity
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_until DATE,                              -- NULL = indefinite
  
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_avail_rules_instructor ON availability_rules(instructor_id);
CREATE INDEX idx_avail_rules_day ON availability_rules(day_of_week);
```

---

#### `availability_overrides`
One-off blocks or openings (holidays, sick days, extra availability).

```sql
CREATE TABLE availability_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),
  
  -- Override
  date            DATE NOT NULL,
  start_time      TIME,                              -- NULL = entire day
  end_time        TIME,
  
  override_type   TEXT NOT NULL CHECK (override_type IN ('blocked', 'available')),
  reason          TEXT,                              -- 'Holiday', 'Sick', 'Personal'
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_avail_overrides_instructor ON availability_overrides(instructor_id);
CREATE INDEX idx_avail_overrides_date ON availability_overrides(date);
```

---

#### `bookings`
All lesson bookings — the scheduling backbone.

```sql
CREATE TABLE bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),
  student_id      UUID REFERENCES students(id),      -- NULL if prospect booking
  contact_id      UUID REFERENCES contacts(id),       -- Always set (even for registered students)
  service_id      UUID NOT NULL REFERENCES services(id),
  
  -- Schedule
  scheduled_date  DATE NOT NULL,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL,
  
  -- Location
  pickup_address  TEXT,
  suburb          TEXT,
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show', 'rescheduled')),
  cancelled_at    TIMESTAMPTZ,
  cancelled_by    TEXT,
  cancellation_reason TEXT,
  
  -- Payment
  payment_status  TEXT NOT NULL DEFAULT 'unpaid' 
    CHECK (payment_status IN ('unpaid', 'deposit_paid', 'paid', 'package_credit', 'refunded', 'waived')),
  payment_id      UUID,                              -- References payments table
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  
  -- Booking metadata
  booked_via      TEXT NOT NULL DEFAULT 'website' 
    CHECK (booked_via IN ('website', 'phone', 'sms', 'voice_agent', 'admin', 'walk_in')),
  booked_by       TEXT,                              -- Clerk user ID of booker the booking
  
  -- Co-lesson
  is_co_lesson    BOOLEAN NOT NULL DEFAULT FALSE,
  co_lesson_parent_id UUID REFERENCES parents(id),
  
  -- Notes
  booking_notes   TEXT,                              -- Visible to student
  admin_notes     TEXT,                              -- Internal only
  
  -- Lesson link (set after lesson recorded)
  lesson_id       UUID,                              -- Populated after lesson recording
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bookings_instructor_id ON bookings(instructor_id);
CREATE INDEX idx_bookings_student_id ON bookings(student_id);
CREATE INDEX idx_bookings_scheduled_date ON bookings(scheduled_date);
CREATE INDEX idx_bookings_start_time ON bookings(start_time);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE UNIQUE INDEX idx_bookings_no_overlap ON bookings(instructor_id, start_time) 
  WHERE status NOT IN ('cancelled', 'rescheduled');
```

---

#### `lessons`
Core lesson recording — digital equivalent of Form 10.044 per-lesson row. **Append-only for compliance.**

```sql
CREATE TABLE lessons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID REFERENCES bookings(id),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),
  student_id      UUID NOT NULL REFERENCES students(id),
  
  -- Lesson sequence (per student, auto-incremented)
  lesson_number   INTEGER NOT NULL,                  -- Per Form 10.044
  
  -- Timing
  lesson_date     DATE NOT NULL,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  total_minutes   INTEGER NOT NULL,                  -- Actual duration
  rounded_minutes INTEGER,                           -- Rounded to 30-min periods (optional)
  
  -- Odometer
  odo_start       INTEGER,                           -- Kilometres
  odo_end         INTEGER,
  total_km        INTEGER GENERATED ALWAYS AS (odo_end - odo_start) STORED,
  
  -- Competencies (arrays of task numbers)
  competencies_taught   INTEGER[] DEFAULT '{}',      -- Task numbers taught this lesson
  competencies_assessed INTEGER[] DEFAULT '{}',      -- Task numbers assessed
  competencies_achieved_manual INTEGER[] DEFAULT '{}', -- Achieved (manual transmission)
  competencies_achieved_auto   INTEGER[] DEFAULT '{}', -- Achieved (auto transmission)
  
  -- Location
  location_suburb TEXT,
  location_detail TEXT,                              -- Free text location notes
  
  -- Comments (visible to student/parent per privacy settings)
  comments        TEXT,
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'draft' 
    CHECK (status IN ('draft', 'pending_student_signature', 'completed', 'disputed')),
  
  -- Signatures (references to signatures table)
  instructor_signature_id UUID REFERENCES signatures(id),
  student_signature_id    UUID REFERENCES signatures(id),
  
  -- Audit
  signed_at       TIMESTAMPTZ,                       -- When both signatures captured
  device_info     JSONB,                             -- User agent, screen, etc.
  gps_latitude    NUMERIC(10,7),
  gps_longitude   NUMERIC(10,7),
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NO updated_at — lessons are append-only after signing
  -- Corrections create a new record linked via correction_of
  correction_of   UUID REFERENCES lessons(id),       -- If this corrects a previous record
  correction_reason TEXT
);

CREATE INDEX idx_lessons_student_id ON lessons(student_id);
CREATE INDEX idx_lessons_instructor_id ON lessons(instructor_id);
CREATE INDEX idx_lessons_date ON lessons(lesson_date);
CREATE INDEX idx_lessons_booking_id ON lessons(booking_id);
CREATE UNIQUE INDEX idx_lessons_student_number ON lessons(student_id, lesson_number) 
  WHERE correction_of IS NULL;
```

---

#### `competency_tasks`
Reference table — the 23+ ACT CBT&A tasks. Rarely changes.

```sql
CREATE TABLE competency_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  task_number     INTEGER NOT NULL UNIQUE,           -- 1-23+
  name            TEXT NOT NULL,                      -- Official task name
  description     TEXT,                              -- What it covers
  category        TEXT,                              -- Grouping (e.g., 'Basic Control', 'Traffic', 'Complex')
  
  -- Progression rules
  prerequisites   INTEGER[] DEFAULT '{}',            -- Task numbers required before this one
  is_review       BOOLEAN NOT NULL DEFAULT FALSE,    -- True for Review Assessment tasks
  is_final_drive  BOOLEAN NOT NULL DEFAULT FALSE,    -- True for Task 23
  
  -- Review gating
  review_requires_tasks INTEGER[] DEFAULT '{}',      -- For review tasks: which tasks must be competent
  
  -- Final drive rules
  final_drive_min_minutes INTEGER,                   -- 45 min minimum
  final_drive_unfamiliar_roads BOOLEAN DEFAULT FALSE,
  
  -- Content
  competency_hub_content_id UUID,                    -- Link to Competency Hub page
  
  -- Display
  sort_order      INTEGER NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_comp_tasks_number ON competency_tasks(task_number);
```

---

#### `student_competencies`
Per-student per-task competency status. **Append-only for compliance.**

```sql
CREATE TABLE student_competencies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(id),
  task_id         UUID NOT NULL REFERENCES competency_tasks(id),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),
  
  -- Status
  status          TEXT NOT NULL CHECK (status IN ('not_started', 'taught', 'assessed', 'competent', 'not_yet_competent')),
  transmission    TEXT NOT NULL CHECK (transmission IN ('manual', 'auto')),
  
  -- When
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lesson_id       UUID REFERENCES lessons(id),       -- Which lesson triggered this change
  
  -- Audit
  signed_by_instructor BOOLEAN NOT NULL DEFAULT FALSE,
  signed_by_student    BOOLEAN NOT NULL DEFAULT FALSE,
  signature_id    UUID REFERENCES signatures(id),
  
  -- Hash chain (append-only audit)
  previous_hash   TEXT,
  record_hash     TEXT NOT NULL,                     -- SHA-256 of this record
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at — append-only. New status = new row.
);

CREATE INDEX idx_sc_student_id ON student_competencies(student_id);
CREATE INDEX idx_sc_task_id ON student_competencies(task_id);
CREATE INDEX idx_sc_student_task ON student_competencies(student_id, task_id);
CREATE INDEX idx_sc_status ON student_competencies(status);
```

---

#### `signatures`
E-signature capture records. **Immutable — never updated or deleted.**

```sql
CREATE TABLE signatures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Who signed
  signer_id       TEXT NOT NULL,
  signer_role     TEXT NOT NULL CHECK (signer_role IN ('instructor', 'student')),
  
  -- What they signed
  document_type   TEXT NOT NULL CHECK (document_type IN ('lesson', 'competency', 'certificate', 'enrollment')),
  document_id     UUID NOT NULL,                     -- ID of the lesson, competency, etc.
  
  -- Signature data
  signature_url   TEXT NOT NULL,                     -- Storage path to signature image
  
  -- Verification
  timestamp_utc   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      INET,
  user_agent      TEXT,
  device_info     JSONB,
  gps_latitude    NUMERIC(10,7),
  gps_longitude   NUMERIC(10,7),
  
  -- Hash chain
  previous_hash   TEXT,                              -- Hash of previous signature in chain
  record_hash     TEXT NOT NULL,                     -- SHA-256(signature_image + timestamp + signer + doc + previous_hash)
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at, NO deleted_at — immutable
);

CREATE INDEX idx_signatures_signer ON signatures(signer_id);
CREATE INDEX idx_signatures_document ON signatures(document_type, document_id);
```

---

#### `audit_log`
Immutable event log for all auditable actions. **Append-only.**

```sql
CREATE TABLE audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Event
  event_type      TEXT NOT NULL,                     -- e.g., 'LESSON_CREATED', 'COMPETENCY_SIGNED_OFF', 'PAYMENT_PROCESSED'
  severity        TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  
  -- Actor
  actor_id        TEXT,                              -- Clerk user ID of actor (NULL for system the action (NULL for system events)
  actor_role      TEXT,
  
  -- Subject
  subject_type    TEXT,                              -- 'student', 'booking', 'lesson', etc.
  subject_id      UUID,
  
  -- Details
  details         JSONB NOT NULL DEFAULT '{}',       -- Event-specific data
  
  -- Context
  ip_address      INET,
  user_agent      TEXT,
  gps_latitude    NUMERIC(10,7),
  gps_longitude   NUMERIC(10,7),
  
  -- Hash chain
  previous_hash   TEXT,
  record_hash     TEXT NOT NULL,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- Strictly append-only — no updates, no deletes
);

CREATE INDEX idx_audit_event_type ON audit_log(event_type);
CREATE INDEX idx_audit_actor ON audit_log(actor_id);
CREATE INDEX idx_audit_subject ON audit_log(subject_type, subject_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
```

---

#### `payments`
Payment transaction records.

```sql
CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Who
  student_id      UUID REFERENCES students(id),
  contact_id      UUID REFERENCES contacts(id),      -- For prospects paying before registration
  
  -- What
  booking_id      UUID REFERENCES bookings(id),
  package_id      UUID REFERENCES packages(id),
  
  -- Amount
  amount_cents    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'AUD',
  
  -- Payment method
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('card', 'direct_debit', 'afterpay', 'paypal', 'package_credit', 'voucher', 'cash', 'other')),
  
  -- Gateway
  gateway         TEXT,                              -- 'stripe', 'tyro', 'square', etc.
  gateway_payment_id TEXT,                           -- External payment ID
  gateway_response JSONB,                            -- Full gateway response (sanitised)
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'refunded', 'partially_refunded', 'disputed')),
  
  -- Refund
  refund_amount_cents INTEGER DEFAULT 0,
  refund_reason   TEXT,
  refunded_at     TIMESTAMPTZ,
  
  -- Invoice
  invoice_number  TEXT,                              -- Auto-generated: NXD-2026-0001
  invoice_url     TEXT,                              -- Storage path to PDF
  
  -- Meta
  description     TEXT,                              -- Line item description
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_student_id ON payments(student_id);
CREATE INDEX idx_payments_booking_id ON payments(booking_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_created ON payments(created_at);
```

---

#### `packages`
Prepaid lesson packages.

```sql
CREATE TABLE packages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Definition
  name            TEXT NOT NULL,                     -- '10-Lesson Package'
  description     TEXT,
  total_credits   INTEGER NOT NULL,                  -- Number of lesson credits
  price_cents     INTEGER NOT NULL,                  -- Package price
  
  -- Rules
  valid_for_days  INTEGER,                           -- Expiry (NULL = no expiry)
  applicable_services UUID[] DEFAULT '{}',           -- Which services can be redeemed
  
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

#### `student_packages`
Purchased packages per student.

```sql
CREATE TABLE student_packages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(id),
  package_id      UUID NOT NULL REFERENCES packages(id),
  payment_id      UUID REFERENCES payments(id),
  
  -- Balance
  credits_total   INTEGER NOT NULL,
  credits_used    INTEGER NOT NULL DEFAULT 0,
  credits_remaining INTEGER GENERATED ALWAYS AS (credits_total - credits_used) STORED,
  
  -- Validity
  purchased_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'expired', 'cancelled')),
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sp_student_id ON student_packages(student_id);
CREATE INDEX idx_sp_status ON student_packages(status);
```

---

#### `vouchers`
Promotional codes and gift vouchers.

```sql
CREATE TABLE vouchers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  code            TEXT NOT NULL UNIQUE,               -- 'WELCOME20', 'GIFT-ABC123'
  
  -- Type
  voucher_type    TEXT NOT NULL CHECK (voucher_type IN ('percentage', 'fixed_amount', 'free_lesson')),
  discount_percent INTEGER,                           -- For percentage type (0-100)
  discount_cents  INTEGER,                            -- For fixed amount type
  
  -- Usage rules
  max_uses        INTEGER,                           -- NULL = unlimited
  times_used      INTEGER NOT NULL DEFAULT 0,
  max_uses_per_student INTEGER DEFAULT 1,
  
  -- Validity
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until     TIMESTAMPTZ,
  applicable_services UUID[] DEFAULT '{}',           -- Empty = all services
  
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_vouchers_code ON vouchers(code);
```

---

#### `conversations`
SMS and web chat conversation threads.

```sql
CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Participants
  contact_id      UUID REFERENCES contacts(id),
  user_id         TEXT,                              -- Clerk user ID (if authenticated user (if known)
  
  -- Channel
  channel         TEXT NOT NULL CHECK (channel IN ('sms', 'web_chat', 'voice')),
  channel_identifier TEXT,                           -- Phone number (SMS), session ID (web)
  
  -- Context
  mode            TEXT NOT NULL DEFAULT 'prospect' CHECK (mode IN ('prospect', 'student', 'parent')),
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'handoff_requested', 'closed')),
  handoff_reason  TEXT,
  
  -- Metadata
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_count   INTEGER NOT NULL DEFAULT 0,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conv_contact ON conversations(contact_id);
CREATE INDEX idx_conv_channel ON conversations(channel, channel_identifier);
CREATE INDEX idx_conv_status ON conversations(status);
```

---

#### `messages`
Individual messages within conversations.

```sql
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  
  -- Direction
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_type     TEXT NOT NULL CHECK (sender_type IN ('user', 'ai', 'system')),
  
  -- Content
  content         TEXT NOT NULL,
  
  -- AI metadata
  rag_sources     JSONB,                             -- Sources used for AI response
  confidence      NUMERIC(3,2),                      -- AI confidence score (0.00-1.00)
  intent_detected TEXT,                              -- 'booking', 'question', 'complaint', etc.
  
  -- Delivery (for SMS)
  external_id     TEXT,                              -- Twilio message SID
  delivery_status TEXT,                              -- 'sent', 'delivered', 'failed'
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created ON messages(created_at);
```

---

#### `call_logs`
Voice agent call records.

```sql
CREATE TABLE call_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID REFERENCES contacts(id),
  conversation_id UUID REFERENCES conversations(id),
  
  -- Call details
  caller_phone    TEXT NOT NULL,
  call_direction  TEXT NOT NULL DEFAULT 'inbound' CHECK (call_direction IN ('inbound', 'outbound')),
  
  -- Timing
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  duration_seconds INTEGER,
  
  -- Outcome
  outcome         TEXT NOT NULL DEFAULT 'answered' 
    CHECK (outcome IN ('answered', 'voicemail', 'missed', 'failed')),
  resolution      TEXT CHECK (resolution IN ('resolved', 'booking_made', 'message_taken', 'callback_scheduled', 'transferred', 'hung_up')),
  
  -- Content
  transcript      TEXT,                              -- Full call transcript
  summary         TEXT,                              -- AI-generated summary
  caller_name     TEXT,                              -- Captured during call
  caller_reason   TEXT,                              -- Why they called
  
  -- AI metadata
  voice_provider  TEXT,                              -- 'vapi', 'bland', 'retell'
  external_call_id TEXT,                             -- Provider's call ID
  
  -- Follow-up
  requires_callback BOOLEAN NOT NULL DEFAULT FALSE,
  callback_scheduled_at TIMESTAMPTZ,
  callback_completed_at TIMESTAMPTZ,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_calls_contact ON call_logs(contact_id);
CREATE INDEX idx_calls_caller_phone ON call_logs(caller_phone);
CREATE INDEX idx_calls_started ON call_logs(started_at);
CREATE INDEX idx_calls_requires_callback ON call_logs(requires_callback) WHERE requires_callback = TRUE;
```

---

#### `private_notes`
Instructor-only coaching notes. **Never visible to students or parents.**

```sql
CREATE TABLE private_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),
  student_id      UUID NOT NULL REFERENCES students(id),
  lesson_id       UUID REFERENCES lessons(id),       -- NULL for general student notes
  
  -- Content
  note            TEXT NOT NULL,
  
  -- Categorisation
  note_type       TEXT NOT NULL DEFAULT 'general' 
    CHECK (note_type IN ('general', 'lesson_specific', 'safety_concern', 'coaching_strategy', 'personal_interest')),
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pn_instructor ON private_notes(instructor_id);
CREATE INDEX idx_pn_student ON private_notes(student_id);
CREATE INDEX idx_pn_lesson ON private_notes(lesson_id);

-- RLS: Only the authoring instructor and admins can see these
```

---

#### `lesson_bridge_forms`
Auto-generated post-lesson handouts for supervising drivers.

```sql
CREATE TABLE lesson_bridge_forms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id       UUID NOT NULL UNIQUE REFERENCES lessons(id),
  student_id      UUID NOT NULL REFERENCES students(id),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),
  
  -- Content (auto-generated from lesson data)
  skills_covered  JSONB NOT NULL,                    -- Array of {task_number, task_name, status}
  positives       TEXT,                              -- What went well
  practice_instructions TEXT,                        -- What to practice at home
  focus_areas     TEXT,                              -- Areas needing attention
  next_lesson_recommendation TEXT,                   -- Suggested focus for next lesson
  
  -- Generated document
  pdf_url         TEXT,                              -- Storage path to generated PDF
  
  -- Visibility
  is_visible_to_student BOOLEAN NOT NULL DEFAULT TRUE,
  is_visible_to_parent  BOOLEAN NOT NULL DEFAULT TRUE, -- Subject to parent_student_link permissions
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lbf_student ON lesson_bridge_forms(student_id);
CREATE INDEX idx_lbf_lesson ON lesson_bridge_forms(lesson_id);
```

---

#### `self_assessments`
Student self-assessment (Driver Trainer tick-and-flick giveaway).

```sql
CREATE TABLE self_assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(id),
  
  -- Context
  assessment_type TEXT NOT NULL CHECK (assessment_type IN ('pre_review_1_17', 'pre_review_1_22', 'pre_final_drive', 'general')),
  
  -- Responses
  responses       JSONB NOT NULL,                    -- Array of {task_number, confidence: 1-5, notes: text}
  
  -- Status
  completed_at    TIMESTAMPTZ,
  reviewed_by_instructor BOOLEAN NOT NULL DEFAULT FALSE,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sa_student ON self_assessments(student_id);
```

---

#### `notifications`
Outbound notification tracking.

```sql
CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Recipient
  recipient_id    TEXT,
  recipient_contact_id UUID REFERENCES contacts(id),
  recipient_phone TEXT,
  recipient_email TEXT,
  
  -- Notification
  channel         TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  notification_type TEXT NOT NULL,                   -- 'booking_confirmation', 'lesson_reminder', etc.
  
  -- Content
  subject         TEXT,                              -- Email subject
  body            TEXT NOT NULL,
  
  -- Delivery
  status          TEXT NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'bounced')),
  external_id     TEXT,                              -- Twilio SID / Resend ID
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  failed_reason   TEXT,
  
  -- Trigger
  triggered_by    TEXT,                              -- Which component/event triggered this
  related_id      UUID,                              -- booking_id, lesson_id, etc.
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notif_recipient ON notifications(recipient_id);
CREATE INDEX idx_notif_status ON notifications(status);
CREATE INDEX idx_notif_type ON notifications(notification_type);
```

---

#### `rag_documents`
Knowledge base document metadata.

```sql
CREATE TABLE rag_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Document
  title           TEXT NOT NULL,
  source_type     TEXT NOT NULL CHECK (source_type IN ('regulation', 'business', 'educational', 'faq', 'blog', 'template')),
  file_url        TEXT,                              -- Original file in storage
  
  -- Processing
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'indexed', 'failed', 'archived')),
  chunk_count     INTEGER DEFAULT 0,
  last_indexed_at TIMESTAMPTZ,
  
  -- Metadata
  metadata        JSONB DEFAULT '{}',                -- Tags, categories, etc.
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

#### `rag_chunks`
Vector-embedded document chunks for RAG retrieval. Uses pgvector.

```sql
CREATE TABLE rag_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  
  -- Content
  content         TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,                  -- Order within document
  
  -- Embedding
  embedding       vector(3072),                      -- text-embedding-3-large dimension
  
  -- Metadata for filtering
  metadata        JSONB DEFAULT '{}',                -- source_type, task_number, etc.
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rag_chunks_document ON rag_chunks(document_id);
CREATE INDEX idx_rag_chunks_embedding ON rag_chunks 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

---

#### `waitlist`
Students waiting for preferred time slots.

```sql
CREATE TABLE waitlist (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID REFERENCES students(id),
  contact_id      UUID REFERENCES contacts(id),
  instructor_id   UUID REFERENCES instructors(id),
  
  -- Preferences
  preferred_day   INTEGER,                           -- Day of week (0-6)
  preferred_time_start TIME,
  preferred_time_end   TIME,
  service_id      UUID REFERENCES services(id),
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'booked', 'expired', 'cancelled')),
  notified_at     TIMESTAMPTZ,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_waitlist_status ON waitlist(status);
CREATE INDEX idx_waitlist_instructor ON waitlist(instructor_id);
```

---

### 3.4 Application-Level Access Control (RBAC via Clerk Middleware)

With Clerk, access control is enforced in application middleware — not at the database level. Every API route runs through Clerk's `auth()` middleware which provides the authenticated user's `clerk_user_id` and custom claims (role, instructor_id, etc.). Service functions then scope queries accordingly.

**Access Matrix (enforced in service layer):**

| Table | Admin | Instructor | Student | Parent |
|-------|-------|-----------|---------|--------|
| profiles | All | Own only | Own only | Own only |
| instructors | All | Own only | Read assigned | — |
| students | All | Own students | Own only | Linked (if permitted) |
| bookings | All | Own bookings | Own bookings | Linked student's (if permitted) |
| lessons | All | Own lessons | Own lessons | Linked student's (if permitted) |
| student_competencies | All | Own students | Own only | Linked (if permitted) |
| signatures | All | Own + own students | Own only | — |
| private_notes | All | **Own only** | **NEVER** | **NEVER** |
| payments | All | — | Own only | Own receipts (if permitted) |
| conversations | All | — | Own only | — |
| call_logs | All | — | — | — |
| audit_log | All (read only) | — | — | — |

**Implementation pattern:**

```typescript
// Clerk middleware extracts auth context
import { auth } from '@clerk/nextjs/server';

async function getStudentLessons(studentId: string) {
  const { userId, sessionClaims } = await auth();
  const role = sessionClaims?.role as string;
  const instructorId = sessionClaims?.instructor_id as string;
  
  // Admin: sees all
  if (role === 'admin') {
    return db.select().from(lessons).where(eq(lessons.student_id, studentId));
  }
  
  // Instructor: only their own students' lessons
  if (role === 'instructor') {
    return db.select().from(lessons)
      .where(and(
        eq(lessons.student_id, studentId),
        eq(lessons.instructor_id, instructorId)
      ));
  }
  
  // Student: only their own lessons
  if (role === 'student') {
    const student = await getStudentByClerkId(userId);
    if (student.id !== studentId) throw new ForbiddenError();
    return db.select().from(lessons).where(eq(lessons.student_id, studentId));
  }
  
  // Parent: linked student only, if permitted
  if (role === 'parent') {
    const link = await getParentStudentLink(userId, studentId);
    if (!link || !link.can_view_lesson_notes) throw new ForbiddenError();
    return db.select().from(lessons).where(eq(lessons.student_id, studentId));
  }
  
  throw new ForbiddenError();
}
```

**Critical rule for private_notes — defence in depth:**
```typescript
// Service layer: NEVER returns private notes to students or parents
async function getPrivateNotes(studentId: string) {
  const { sessionClaims } = await auth();
  const role = sessionClaims?.role as string;
  
  // Only instructors and admins can EVER access private notes
  if (role !== 'instructor' && role !== 'admin') {
    throw new ForbiddenError('Private notes are instructor-only');
  }
  
  // Instructors can only see their own notes (admin sees all)
  if (role === 'instructor') {
    const instructorId = sessionClaims?.instructor_id as string;
    return db.select().from(privateNotes)
      .where(and(
        eq(privateNotes.student_id, studentId),
        eq(privateNotes.instructor_id, instructorId)
      ));
  }
  
  return db.select().from(privateNotes)
    .where(eq(privateNotes.student_id, studentId));
}

// Additionally: private_notes columns are NEVER included in any 
// student-facing or parent-facing query, even by accident.
// The lessons API response shape simply doesn't include them.
```

---

### 3.5 Database Functions & Triggers

```sql
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

-- Apply to all tables with updated_at
CREATE TRIGGER set_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
-- (repeat for all tables with updated_at column)

-- SHA-256 hash chain for audit_log
CREATE OR REPLACE FUNCTION compute_audit_hash()
RETURNS TRIGGER AS $$
BEGIN
  NEW.previous_hash := (SELECT record_hash FROM audit_log ORDER BY created_at DESC LIMIT 1);
  NEW.record_hash := encode(
    sha256(
      (NEW.event_type || NEW.actor_id::TEXT || NEW.subject_id::TEXT || 
       NEW.created_at::TEXT || COALESCE(NEW.previous_hash, 'GENESIS'))::bytea
    ), 'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_hash_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION compute_audit_hash();

-- Similar hash chain trigger for signatures and student_competencies
```

---

*End of Part 1 — Database Schema*

*Part 2 continues with: API Contracts, Integration Architecture, Security Architecture, Infrastructure Topology, Deployment Pipeline*

---

# NexDrive Academy — System Architecture (Part 2)
### API Contracts, Integration Architecture, Security, Infrastructure, Deployment
**Continues from:** system-architecture-part1.md (Database Schema)

---

## 4. API Contracts

### 4.1 API Design Standards

| Standard | Decision |
|----------|----------|
| Protocol | REST over HTTPS |
| Format | JSON |
| Versioning | URL path: `/api/v1/` |
| Auth | Clerk session cookie (web) / Bearer token (API) |
| Pagination | Cursor-based (`?cursor=xxx&limit=20`) |
| Filtering | Query params (`?status=active&instructor_id=xxx`) |
| Sorting | `?sort=created_at&order=desc` |
| Error format | `{ "error": { "code": "BOOKING_CONFLICT", "message": "...", "details": {} } }` |
| Rate limiting | Per-IP + per-user, 100 req/min general, 10 req/min for mutations |
| Timestamps | ISO 8601 UTC (`2026-02-20T10:30:00Z`) |
| Money | Integer cents + currency code (`{ "amount": 10500, "currency": "AUD" }`) |

### 4.2 API Route Map

All routes are Next.js API routes under `/api/v1/`. Auth level indicates minimum required role.

```
Auth Levels:
  🌍 = Public (no auth)
  🔑 = Authenticated (any role)
  👤 = Student
  👨‍👩‍👦 = Parent  
  🎓 = Instructor
  👑 = Admin (platform owner)
```

---

#### 4.2.1 Auth & Profiles

```
POST   /api/v1/auth/register              🌍  Create account
POST   /api/v1/auth/login                 🌍  Email/password login
POST   /api/v1/auth/magic-link            🌍  Passwordless login
POST   /api/v1/auth/refresh               🔑  Refresh JWT
POST   /api/v1/auth/logout                🔑  Invalidate session

GET    /api/v1/me                          🔑  Current user profile + role data
PATCH  /api/v1/me                          🔑  Update own profile
PATCH  /api/v1/me/avatar                   🔑  Upload avatar

GET    /api/v1/me/notifications            🔑  My notifications
PATCH  /api/v1/me/notifications/:id        🔑  Mark read/dismissed
GET    /api/v1/me/notification-preferences 🔑  Get preferences
PATCH  /api/v1/me/notification-preferences 🔑  Update preferences
```

---

#### 4.2.2 Booking Engine

```
GET    /api/v1/booking/availability         🌍  Available slots (public widget)
  Query: ?instructor_id=&service_id=&date_from=&date_to=
  Response: { "slots": [{ "date": "2026-03-01", "times": [{ "start": "09:00", "end": "10:00", "available": true }] }] }

GET    /api/v1/booking/services             🌍  List bookable services
  Response: { "services": [{ "id", "name", "slug", "duration_minutes", "price_cents", "category" }] }

POST   /api/v1/booking/reserve              🌍  Reserve a slot (10-min hold)
  Body: { "instructor_id", "service_id", "date", "start_time", "contact": { "name", "phone", "email" } }
  Response: { "reservation_id", "expires_at", "booking_summary" }

POST   /api/v1/booking/confirm              🌍  Confirm booking (after payment intent)
  Body: { "reservation_id", "payment_intent_id"? }
  Response: { "booking": { full booking object } }

GET    /api/v1/bookings                     🔑  List my bookings (student/instructor/admin)
  Query: ?status=&date_from=&date_to=&page_cursor=
  
GET    /api/v1/bookings/:id                 🔑  Booking detail
PATCH  /api/v1/bookings/:id                 🔑  Update booking (reschedule)
POST   /api/v1/bookings/:id/cancel          🔑  Cancel booking
  Body: { "reason" }

POST   /api/v1/bookings/:id/start           🎓  Mark lesson in progress
POST   /api/v1/bookings/:id/complete        🎓  Mark lesson complete (triggers lesson creation)

GET    /api/v1/bookings/upcoming             🔑  Next N bookings (widget data)
```

---

#### 4.2.3 Student Management

```
GET    /api/v1/students                     🎓👑  List students (instructor sees own, admin sees all)
  Query: ?status=&instructor_id=&search=
GET    /api/v1/students/:id                 🎓👑  Student detail
PATCH  /api/v1/students/:id                 🎓👑  Update student record
GET    /api/v1/students/:id/progress        🔑   Competency progress summary
GET    /api/v1/students/:id/lessons         🔑   Lesson history
GET    /api/v1/students/:id/bookings        🔑   Booking history
GET    /api/v1/students/:id/payments        🔑   Payment history
GET    /api/v1/students/:id/bridge-forms    🔑   Lesson bridge forms
GET    /api/v1/students/:id/self-assessments 🔑  Self-assessment history

PATCH  /api/v1/students/:id/privacy         👤   Update privacy settings
  Body: { "parent_visibility": true/false }

POST   /api/v1/students/:id/invite-parent    👤🎓  Send parent invitation
  Body: { "email", "phone", "relationship" }
```

---

#### 4.2.4 Lesson Recording (Instructor Workstation)

```
POST   /api/v1/lessons                      🎓  Create lesson record (from booking or standalone)
  Body: {
    "booking_id"?,
    "student_id",
    "lesson_date",
    "start_time", "end_time",
    "odo_start"?, "odo_end"?,
    "location_suburb",
    "competencies_taught": [1, 5, 7],
    "competencies_assessed": [1, 5],
    "competencies_achieved_auto": [1],
    "competencies_achieved_manual": [],
    "comments": "Great progress on lane changes"
  }
  Response: { "lesson": { ...full record with lesson_number assigned } }

GET    /api/v1/lessons/:id                  🔑  Lesson detail
PATCH  /api/v1/lessons/:id                  🎓  Update draft lesson (before signing only)

POST   /api/v1/lessons/:id/sign             🔑  Submit signature
  Body: { "signature_image": base64, "gps_latitude"?, "gps_longitude"? }
  Response: { "signature_id", "lesson_status" }

POST   /api/v1/lessons/:id/bridge-form      🎓  Generate bridge form
  Response: { "bridge_form": { ...auto-generated from lesson data }, "pdf_url" }

POST   /api/v1/lessons/:id/correction       🎓  Create correction record
  Body: { "reason", ...corrected fields }
```

---

#### 4.2.5 CBT&A Compliance Engine

```
GET    /api/v1/competency-tasks             🔑  List all CBT&A tasks
  Response: { "tasks": [{ "task_number", "name", "category", "prerequisites", "is_review" }] }

GET    /api/v1/students/:id/competencies    🔑  Student competency matrix
  Response: { 
    "competencies": [{ 
      "task_number", "task_name", "status", "transmission",
      "taught_at"?, "assessed_at"?, "achieved_at"?,
      "lesson_id"?, "can_assess": true/false, "blocked_by": []
    }],
    "summary": { "total": 23, "competent": 12, "in_progress": 4, "not_started": 7 }
  }

POST   /api/v1/students/:id/competencies    🎓  Record competency status change
  Body: { "task_number", "status", "transmission", "lesson_id" }
  
GET    /api/v1/students/:id/certificate-eligibility  🎓  Check certificate readiness
  Response: { "eligible": true/false, "missing_tasks": [], "total_hours": 42.5 }

POST   /api/v1/students/:id/certificate     🎓👑  Generate Certificate of Competency
  Response: { "certificate_number", "pdf_url", "issued_at" }
```

---

#### 4.2.6 CRM & Contacts

```
GET    /api/v1/contacts                     🎓👑  List contacts
  Query: ?lifecycle_stage=&source=&search=&instructor_id=
POST   /api/v1/contacts                     🎓👑  Create contact (manual entry)
GET    /api/v1/contacts/:id                 🎓👑  Contact detail
PATCH  /api/v1/contacts/:id                 🎓👑  Update contact
GET    /api/v1/contacts/:id/interactions    🎓👑  Contact interaction history (calls, messages, bookings)

POST   /api/v1/contacts/:id/convert         🎓👑  Convert prospect to enrolled student
  Body: { "instructor_id", "transmission", "referral_source" }
```

---

#### 4.2.7 Payments

```
POST   /api/v1/payments/create-intent       🔑  Create payment intent (gateway-specific)
  Body: { "amount_cents", "booking_id"?, "package_id"? }
  Response: { "client_secret", "payment_intent_id" }

POST   /api/v1/payments/webhook             🌍  Payment gateway webhook (Stripe/etc)
  (Verified by gateway signature)

GET    /api/v1/payments                      🔑  Payment history
GET    /api/v1/payments/:id                  🔑  Payment detail
GET    /api/v1/payments/:id/invoice          🔑  Download invoice PDF

POST   /api/v1/packages/:id/purchase         🔑  Purchase a package
GET    /api/v1/me/packages                    👤  My active packages + credits

POST   /api/v1/vouchers/validate             🌍  Validate voucher code
  Body: { "code", "service_id"? }
  Response: { "valid": true, "discount_type", "discount_amount", "message" }
```

---

#### 4.2.8 AI Communication Channels

```
POST   /api/v1/chat/message                 🌍  Web chat message
  Body: { "session_id"?, "message", "context"?: { "page_url", "user_id"? } }
  Response: { "reply", "session_id", "sources"?: [], "suggested_actions"?: [] }

POST   /api/v1/sms/inbound                  🌍  Twilio SMS webhook
  (Verified by Twilio signature)
  
POST   /api/v1/sms/status                   🌍  Twilio delivery status webhook

POST   /api/v1/voice/inbound                🌍  Voice agent webhook (from Vapi/Bland/Retell)
POST   /api/v1/voice/event                  🌍  Voice agent event webhook (call ended, etc.)
POST   /api/v1/voice/function-call          🌍  Voice agent function call (check availability, book)
```

---

#### 4.2.9 RAG Knowledge Engine

These are internal-only APIs — not exposed publicly. Called by C04, C05, C06.

```
POST   /api/internal/rag/query              🔒  Query knowledge base
  Body: { 
    "query": "How many lessons do I need?",
    "context"?: { "user_id"?, "channel": "sms", "student_id"? },
    "filters"?: { "source_types": ["faq", "business"] },
    "max_results": 5
  }
  Response: { 
    "answer": "Most learners need between 30-60 hours...",
    "sources": [{ "document_id", "title", "chunk_content", "score" }],
    "confidence": 0.92,
    "suggested_actions": ["book_lesson", "view_pricing"]
  }

POST   /api/internal/rag/index               🔒  Index a document
  Body: { "title", "source_type", "content" OR "file_url" }

DELETE /api/internal/rag/documents/:id        🔒  Remove document from index
GET    /api/internal/rag/documents            🔒  List indexed documents
POST   /api/internal/rag/reindex              🔒  Reindex all documents
```

---

#### 4.2.10 Admin Panel

```
GET    /api/v1/admin/dashboard              👑  KPI dashboard data
  Response: { 
    "today": { "lessons_scheduled", "revenue_cents", "new_leads" },
    "week": { "total_lessons", "total_revenue", "conversion_rate" },
    "students": { "active", "total", "completed_this_month" },
    "pending_callbacks": 3
  }

GET    /api/v1/admin/instructors            👑  List all instructors
POST   /api/v1/admin/instructors            👑  Onboard new instructor
PATCH  /api/v1/admin/instructors/:id        👑  Update instructor
GET    /api/v1/admin/instructors/:id/stats  👑  Instructor performance stats

GET    /api/v1/admin/audit-log              👑  Query audit trail
  Query: ?event_type=&actor_id=&subject_type=&date_from=&date_to=

PATCH  /api/v1/admin/services/:id           👑  Update service pricing/details
PATCH  /api/v1/admin/packages/:id           👑  Update package details
POST   /api/v1/admin/vouchers               👑  Create voucher
PATCH  /api/v1/admin/vouchers/:id           👑  Update voucher

GET    /api/v1/admin/reports/revenue         👑  Revenue report
GET    /api/v1/admin/reports/competency      👑  Competency progress report (all students)
GET    /api/v1/admin/reports/instructor      👑  Instructor utilisation report
GET    /api/v1/admin/reports/export          👑  Export data (CSV/PDF)
```

---

#### 4.2.11 Public Website & Content

```
GET    /api/v1/content/pages/:slug          🌍  CMS page content
GET    /api/v1/content/blog                 🌍  Blog listing
GET    /api/v1/content/blog/:slug           🌍  Blog post
GET    /api/v1/content/competency-hub       🌍  Competency Hub listing
GET    /api/v1/content/competency-hub/:task 🌍  Competency task detail page
GET    /api/v1/content/faq                  🌍  FAQ listing
GET    /api/v1/content/testimonials         🌍  Testimonials
```

---

#### 4.2.12 Notifications

```
POST   /api/internal/notifications/send      🔒  Send notification
  Body: { 
    "recipient_id"?, "recipient_phone"?, "recipient_email"?,
    "channel": "sms" | "email" | "push",
    "type": "booking_confirmation",
    "data": { template-specific data }
  }
```

Notification types and their channels:

| Type | SMS | Email | Push | Trigger |
|------|-----|-------|------|---------|
| `booking_confirmation` | ✅ | ✅ | — | Booking confirmed |
| `booking_reminder_24h` | ✅ | — | — | 24h before lesson |
| `booking_reminder_2h` | ✅ | — | — | 2h before lesson |
| `booking_cancelled` | ✅ | ✅ | — | Booking cancelled |
| `booking_rescheduled` | ✅ | ✅ | — | Booking rescheduled |
| `lesson_completed` | — | ✅ | — | Lesson signed off |
| `bridge_form_ready` | ✅ | ✅ | — | Bridge form generated |
| `payment_received` | — | ✅ | — | Payment processed |
| `payment_failed` | ✅ | ✅ | — | Payment failed |
| `package_purchased` | — | ✅ | — | Package bought |
| `package_low_credits` | ✅ | ✅ | — | ≤2 credits remaining |
| `parent_invitation` | ✅ | ✅ | — | Student invites parent |
| `callback_scheduled` | ✅ | — | — | Voice agent takes message |
| `competency_achieved` | — | ✅ | — | New competency signed off |
| `certificate_ready` | ✅ | ✅ | — | All tasks competent |
| `waitlist_available` | ✅ | ✅ | — | Preferred slot opened up |

---

### 4.3 Standard Response Envelopes

**Success:**
```json
{
  "data": { ... },
  "meta": {
    "cursor": "eyJ...",
    "has_more": true,
    "total_count": 47
  }
}
```

**Error:**
```json
{
  "error": {
    "code": "BOOKING_CONFLICT",
    "message": "This time slot is no longer available.",
    "details": {
      "conflicting_booking_id": "uuid",
      "suggested_alternatives": [...]
    }
  }
}
```

**Common error codes:**

| Code | HTTP | Meaning |
|------|------|---------|
| `AUTH_REQUIRED` | 401 | Missing or invalid token |
| `FORBIDDEN` | 403 | Valid auth but insufficient permissions |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `VALIDATION_ERROR` | 422 | Invalid request body |
| `BOOKING_CONFLICT` | 409 | Slot no longer available |
| `BOOKING_TOO_LATE` | 422 | Insufficient notice for booking |
| `PAYMENT_FAILED` | 402 | Payment processing failed |
| `COMPETENCY_LOCKED` | 422 | Prerequisites not met |
| `LESSON_ALREADY_SIGNED` | 409 | Cannot modify signed lesson |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |

---

## 5. Integration Architecture

### 5.1 Component Communication Map

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL SERVICES                             │
│                                                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Twilio   │  │ Vapi.ai / │  │ Stripe / │  │  Resend       │  │
│  │ (SMS)    │  │ Voice API │  │ TBD Pay  │  │  (Email)      │  │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │              │              │                │           │
└───────┼──────────────┼──────────────┼────────────────┼───────────┘
        │              │              │                │
   ┌────▼──┐      ┌────▼──┐     ┌────▼──┐        ┌────▼──┐
   │ C06   │      │ C05   │     │ C10   │        │ C18   │
   │ SMS   │      │ Voice │     │ Pay   │        │ Notif │
   │ Chat  │      │ Agent │     │Engine │        │Engine │
   └───┬───┘      └───┬───┘     └───┬───┘        └───┬───┘
       │              │              │                │
       │    ┌─────────▼─────────┐   │                │
       └───►│ C07: RAG Engine   │◄──┘                │
            │ (AI Brain)        │                     │
            └────────┬──────────┘                     │
                     │                                │
       ┌─────────────┼────────────────────────────────┤
       │             │                                │
  ┌────▼──┐    ┌─────▼────┐    ┌──────┐    ┌─────────▼──┐
  │ C08   │    │ C09      │    │ C12  │    │ C11        │
  │Booking│◄──►│ CRM      │◄──►│CBT&A │◄──►│ Instructor │
  │Engine │    │ Contacts  │    │Engine│    │ Workstation│
  └───┬───┘    └──────────┘    └──┬───┘    └────────────┘
      │                           │
      │                      ┌────▼──┐
      │                      │ C13   │
      │                      │E-Sign │
      │                      └───┬───┘
      │                          │
      └──────────────────────────┤
                                 │
                          ┌──────▼──────┐
                          │ C21: DB     │
                          │ + C20: Auth │
                          │ + C14: Audit│
                          └─────────────┘
```

### 5.2 Integration Patterns

#### Pattern 1: Synchronous (request-response)
Used for: All API routes, real-time queries.

```
Client → API Route → Service → Database → Response
```

Example: Student views their competency progress.

#### Pattern 2: Webhook (external → internal)
Used for: Twilio SMS delivery, payment webhooks, voice agent events.

```
External Service → Webhook endpoint → Verify signature → Process → Store → Trigger notifications
```

All webhooks:
- Verify provider signature before processing
- Return 200 immediately, process async
- Store raw webhook payload in audit_log
- Idempotent (safe to receive duplicate webhooks)

#### Pattern 3: Internal Event (service → service)
Used for: Cross-component triggers (lesson completed → generate bridge form → notify parent).

```typescript
// Event bus (lightweight, in-process for v1)
// Can be replaced with external queue (BullMQ/SQS) when scaling
type AppEvent = 
  | { type: 'BOOKING_CREATED'; data: Booking }
  | { type: 'BOOKING_CANCELLED'; data: Booking }
  | { type: 'LESSON_COMPLETED'; data: Lesson }
  | { type: 'COMPETENCY_ACHIEVED'; data: StudentCompetency }
  | { type: 'PAYMENT_RECEIVED'; data: Payment }
  | { type: 'CONTACT_CREATED'; data: Contact }
  | { type: 'CERTIFICATE_ISSUED'; data: { student_id: string; certificate_number: string } }
  | { type: 'CALLBACK_REQUESTED'; data: CallLog }
```

Event subscriptions:

| Event | Subscribers |
|-------|------------|
| `BOOKING_CREATED` | Notification Engine (confirmation SMS/email), CRM (update last contact) |
| `BOOKING_CANCELLED` | Notification Engine, Waitlist (check for interested students), CRM |
| `LESSON_COMPLETED` | Bridge Form Generator, Competency Engine (update progress), Notification Engine, Student (update hours) |
| `COMPETENCY_ACHIEVED` | Notification Engine, Certificate Engine (check eligibility) |
| `PAYMENT_RECEIVED` | Notification Engine (receipt), CRM (update lifecycle), Booking (update payment status) |
| `CONTACT_CREATED` | CRM (auto-assign instructor if solo), Notification Engine (welcome) |
| `CERTIFICATE_ISSUED` | Notification Engine, Audit Trail |
| `CALLBACK_REQUESTED` | Notification Engine (alert Rob), Admin Panel (callback queue) |

#### Pattern 4: RAG Query (AI channels → knowledge base)
Used for: All AI interactions (voice, SMS, web chat).

```
User message → Channel adapter → RAG Engine query:
  1. Classify intent (booking, question, complaint, etc.)
  2. If booking intent → extract entities → Booking Engine API
  3. If question → embed query → vector search → retrieve chunks → LLM generate answer
  4. If authenticated → inject student context (name, progress, upcoming bookings)
  5. Return answer + sources + suggested actions
```

### 5.3 External Service Integration Details

#### Twilio (SMS)

```typescript
// Configuration
{
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  fromNumber: '+61XXXXXXXXX',  // Australian number
  webhookUrl: 'https://nexdriveacademy.com.au/api/v1/sms/inbound',
  statusCallbackUrl: 'https://nexdriveacademy.com.au/api/v1/sms/status'
}

// Inbound flow:
// 1. Twilio receives SMS → POSTs to webhook
// 2. Verify X-Twilio-Signature header
// 3. Upsert contact by phone number
// 4. Route to RAG Engine with SMS context
// 5. Send reply via Twilio API
// 6. Store in conversations/messages tables
```

#### Voice Agent (Vapi.ai — primary evaluation target)

```typescript
// Configuration
{
  apiKey: process.env.VAPI_API_KEY,
  assistantId: 'nexdrive-receptionist',
  phoneNumber: '+61XXXXXXXXX',  // Forwarded NexDrive business number
  
  // Functions the voice agent can call
  functions: [
    {
      name: 'check_availability',
      description: 'Check available lesson slots',
      parameters: { date_range, service_type, time_preference }
    },
    {
      name: 'create_booking',
      description: 'Book a lesson for a caller',
      parameters: { name, phone, email, service_id, date, time }
    },
    {
      name: 'answer_question',
      description: 'Answer a question about NexDrive services',
      parameters: { question }
    },
    {
      name: 'take_message',
      description: 'Take a message for Rob when unable to help',
      parameters: { caller_name, reason, callback_preferred_time }
    }
  ],
  
  // Function endpoints
  functionCallUrl: 'https://nexdriveacademy.com.au/api/v1/voice/function-call',
  eventUrl: 'https://nexdriveacademy.com.au/api/v1/voice/event'
}
```

#### Payment Gateway (TBD — Stripe as reference design)

```typescript
// All payment integrations go through PaymentAdapter interface
interface PaymentAdapter {
  createPaymentIntent(params: {
    amount_cents: number;
    currency: 'AUD';
    customer_id?: string;
    metadata: Record<string, string>;
  }): Promise<{ client_secret: string; intent_id: string }>;
  
  confirmPayment(intent_id: string): Promise<PaymentResult>;
  refund(payment_id: string, amount_cents?: number): Promise<RefundResult>;
  
  createCustomer(params: { email: string; name: string; phone: string }): Promise<{ customer_id: string }>;
  
  verifyWebhook(payload: string, signature: string): boolean;
}

// Webhook flow:
// 1. Gateway sends webhook → verify signature
// 2. Match to internal payment record
// 3. Update payment status
// 4. Emit PAYMENT_RECEIVED event
// 5. Update booking payment_status
// 6. Send receipt notification
```

#### Resend (Email)

```typescript
// Templated transactional emails
{
  apiKey: process.env.RESEND_API_KEY,
  fromAddress: 'lessons@nexdriveacademy.com.au',
  replyTo: 'rob@nexdriveacademy.com.au',
  
  templates: {
    booking_confirmation: 'tmpl_booking_confirm',
    lesson_completed: 'tmpl_lesson_complete',
    bridge_form: 'tmpl_bridge_form',
    payment_receipt: 'tmpl_payment_receipt',
    parent_invitation: 'tmpl_parent_invite',
    certificate_ready: 'tmpl_certificate'
  }
}
```

---

## 6. Security Architecture

### 6.1 Authentication Flow

```
┌──────┐     ┌────────┐     ┌──────────────┐     ┌──────────┐
│Client│────►│Next.js │────►│   Clerk      │────►│  Neon    │
│      │◄────│Middleware│◄────│(JWT verify)  │◄────│PostgreSQL│
└──────┘     └────────┘     └──────────────┘     └──────────┘

1. Client sends request with Clerk session cookie / Bearer token
2. Next.js middleware calls Clerk auth() to verify session
3. Clerk returns: clerk_user_id, role (custom claim), instructor_id, etc.
4. Service layer scopes database queries using clerk_user_id + role
5. Neon executes scoped query and returns results
```

### 6.2 Clerk Session Claims (Custom)

```typescript
// Set via Clerk Dashboard → Sessions → Customize session token
// Or via Clerk Backend API on user.created webhook
interface ClerkSessionClaims {
  sub: string;            // clerk_user_id (e.g., 'user_2abc123')
  email: string;
  role: 'admin' | 'instructor' | 'student' | 'parent';
  instructor_id?: string; // UUID from our instructors table
  student_id?: string;    // UUID from our students table
  parent_id?: string;     // UUID from our parents table
  is_owner?: boolean;     // Platform owner flag
  profile_id: string;     // UUID from our profiles table
}

// Custom claims are set via Clerk's session customization:
// Clerk Dashboard → Sessions → Edit session token template:
// {
//   "role": "{{user.public_metadata.role}}",
//   "instructor_id": "{{user.public_metadata.instructor_id}}",
//   "student_id": "{{user.public_metadata.student_id}}",
//   "is_owner": "{{user.public_metadata.is_owner}}",
//   "profile_id": "{{user.public_metadata.profile_id}}"
// }
```

### 6.3 Role-Based Access Control (RBAC)

```typescript
// Clerk middleware applied to all API routes
import { auth } from '@clerk/nextjs/server';

function requireRole(...roles: Role[]) {
  return async () => {
    const { userId, sessionClaims } = await auth();
    if (!userId) throw new UnauthorizedError();
    
    const role = sessionClaims?.role as Role;
    if (!roles.includes(role)) throw new ForbiddenError();
    
    return {
      clerkUserId: userId,
      role,
      instructorId: sessionClaims?.instructor_id as string | undefined,
      studentId: sessionClaims?.student_id as string | undefined,
      parentId: sessionClaims?.parent_id as string | undefined,
      isOwner: sessionClaims?.is_owner === true,
      profileId: sessionClaims?.profile_id as string,
    };
  };
}

// Usage in API route
export async function GET(req: NextRequest) {
  const user = await requireRole('instructor', 'admin')();
  // user.role is guaranteed to be instructor or admin
  // user.clerkUserId, user.instructorId etc. available for scoping
}
```

### 6.3.1 Clerk Webhook Sync

```typescript
// /api/v1/webhooks/clerk — receives Clerk webhook events
// Verified via Clerk webhook signing secret (svix)

// user.created → Create profile in our DB, set initial role
// user.updated → Sync email, name, phone changes
// user.deleted → Soft delete profile
// session.created → (optional) log for audit
// organization.membership.created → (future) multi-instructor org

import { Webhook } from 'svix';

export async function POST(req: Request) {
  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);
  
  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET!);
  const event = wh.verify(payload, headers);
  
  switch (event.type) {
    case 'user.created':
      await createProfile(event.data);
      break;
    case 'user.updated':
      await syncProfile(event.data);
      break;
    // ...
  }
}
```

### 6.4 Data Isolation Rules

| Rule | Implementation |
|------|---------------|
| Instructor sees only their students | Service layer: `WHERE instructor_id = currentUser.instructorId` |
| Student sees only their own data | Service layer: `WHERE student_id = currentUser.studentId` |
| Parent sees linked student data only if permitted | Service layer joins `parent_student_links` + checks permission columns |
| Private notes are instructor-only | Service layer: role check + `WHERE instructor_id = currentUser.instructorId`. **Never included in student/parent response shapes.** |
| Admin (owner) sees everything | Service layer: `if (currentUser.isOwner)` skips scoping filters |
| Audit log is read-only for admin | Service layer: admin read-only endpoint, no update/delete functions exist |
| Prospects (no account) data is scoped | CRM contacts without clerk_user_id visible to instructors/admin only |

### 6.5 Encryption & Data Protection

| Data | At Rest | In Transit | Notes |
|------|---------|------------|-------|
| Passwords | Clerk (bcrypt + salt) | HTTPS/TLS 1.3 | Never stored in our database |
| Personal data | AES-256 (Neon default) | HTTPS/TLS 1.3 | |
| Signature images | AES-256 in Cloudflare R2 | HTTPS/TLS 1.3 | Signed URLs for time-limited access |
| Payment data | Never stored locally | HTTPS/TLS 1.3 | Gateway tokenisation only |
| Private notes | AES-256 | HTTPS/TLS 1.3 | Additional RBAC isolation in service layer |
| Audit hashes | SHA-256 chain | — | Tamper-evident |
| Session tokens | — | HTTPS/TLS 1.3 | Clerk manages session lifecycle (configurable expiry) |

### 6.6 API Security

| Measure | Implementation |
|---------|---------------|
| Rate limiting | Upstash Redis: 100 req/min general, 10 req/min mutations |
| Webhook verification | Provider-specific signature validation (Twilio, Stripe, Vapi) |
| CORS | Whitelist: `nexdriveacademy.com.au`, `localhost:3000` (dev) |
| CSP | Strict Content Security Policy headers |
| Input validation | Zod schemas on all API inputs |
| SQL injection | Parameterised queries via Drizzle ORM (never raw SQL) |
| XSS | React (auto-escapes), CSP headers, sanitize user content |
| CSRF | Clerk handles via session cookies with SameSite=Lax + CSRF token rotation |

---

## 7. Infrastructure Topology

### 7.1 Production Environment

```
┌─────────────────────────────────────────────────────────────┐
│                     Cloudflare (DNS + CDN)                    │
│              nexdriveacademy.com.au                           │
│              ┌──────────────────────┐                        │
│              │ DDoS Protection      │                        │
│              │ Edge Caching         │                        │
│              │ SSL Termination      │                        │
│              └──────────┬───────────┘                        │
└─────────────────────────┼────────────────────────────────────┘
                          │
              ┌───────────▼───────────┐
              │       Vercel          │
              │  (Next.js Frontend    │
              │   + API Routes)       │
              │  Sydney Edge PoP      │
              │                       │
              │  ┌─────────────────┐  │
              │  │ Server Routes   │  │
              │  │ (API + SSR)     │  │
              │  └────────┬────────┘  │
              │  ┌────────┴────────┐  │
              │  │ Static Assets   │  │
              │  │ (ISR + CDN)     │  │
              │  └─────────────────┘  │
              └───────────┬───────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
┌────────▼────────┐ ┌────▼──────────┐ ┌───▼────────────┐
│ Neon (Sydney)   │ │ Clerk (Edge)  │ │ Cloudflare R2  │
│                 │ │               │ │ (Sydney)       │
│ ┌─────────────┐ │ │ ┌───────────┐│ │                │
│ │PostgreSQL 16│ │ │ │ User Auth ││ │ Signatures     │
│ │+ pgvector   │ │ │ │ MFA       ││ │ PDFs           │
│ │+ branching  │ │ │ │ Sessions  ││ │ Avatars        │
│ │             │ │ │ │ Webhooks  ││ │ Documents      │
│ │ Scale to    │ │ │ │ UI Comps  ││ │                │
│ │ zero (idle) │ │ │ └───────────┘│ │ Zero egress    │
│ └─────────────┘ │ └──────────────┘ │ fees           │
└─────────────────┘                  └────────────────┘
         │
┌────────▼────────┐
│ Upstash (Sydney)│
│ ┌─────────────┐ │
│ │ Redis       │ │
│ │ Rate limit  │ │
│ │ Session     │ │
│ │ cache       │ │
│ │ Slot locks  │ │
│ └─────────────┘ │
└─────────────────┘
```

### 7.2 Environment Strategy

| Environment | Purpose | URL | Database |
|------------|---------|-----|----------|
| **Production** | Live | `nexdriveacademy.com.au` | Neon `main` branch |
| **Staging** | Pre-release testing | `staging.nexdriveacademy.com.au` | Neon `staging` branch |
| **Preview** | Per-PR deployments | `pr-123.nexdriveacademy.vercel.app` | Neon auto-branch per PR (instant, zero-cost copy-on-write) |
| **Local** | Development | `localhost:3000` | Neon `dev` branch or local Docker PostgreSQL |

### 7.3 Scheduled Jobs (Cron)

Implemented via Vercel Cron Jobs (configured in `vercel.json`).

| Job | Schedule | Purpose |
|-----|----------|---------|
| `booking-reminder-24h` | Every hour | Send reminders for lessons in ~24h |
| `booking-reminder-2h` | Every 30 min | Send reminders for lessons in ~2h |
| `package-expiry-check` | Daily 00:00 AEST | Mark expired packages, notify students |
| `callback-followup` | Every 2 hours | Alert admin of outstanding callbacks |
| `waitlist-matcher` | On cancellation + daily | Match cancellations to waitlist entries |
| `analytics-digest` | Daily 06:00 AEST | Generate daily business summary |
| `db-backup-verify` | Daily 03:00 AEST | Verify Neon backup integrity + point-in-time recovery test |

---

## 8. Deployment Pipeline

### 8.1 CI/CD Flow

```
Developer push
     │
     ▼
┌─────────────┐
│ GitHub       │
│ Actions      │
│              │
│ 1. Lint      │
│ 2. Type check│
│ 3. Unit tests│
│ 4. Build     │
└──────┬───────┘
       │
       ├── PR → Preview deploy (Vercel)
       │        + Run integration tests
       │        + Run Playwright E2E
       │
       ├── Merge to main → Staging deploy
       │                   + Full test suite
       │                   + Webhook smoke tests
       │
       └── Release tag → Production deploy
                         + DB migration (if any)
                         + Smoke tests
                         + Monitoring check
```

### 8.2 Database Migration Strategy

```
Drizzle ORM migrations:
  /drizzle/
    migrations/
      0000_initial_schema.sql
      0001_add_waitlist.sql
      ...
    schema.ts          ← Source of truth for DB schema
    
Migration workflow:
  1. Developer modifies schema.ts
  2. Run: drizzle-kit generate → creates SQL migration
  3. Review migration SQL
  4. Run on staging: drizzle-kit push
  5. Test thoroughly
  6. Run on production during deploy window
  
Rules:
  - Additive changes only (new tables, new columns with defaults)
  - Never drop columns in production
  - Backward-compatible changes (old code works with new schema)
  - Migration timeout: 10 seconds max (no long-running locks)
```

### 8.3 Rollback Strategy

| Component | Rollback Method |
|-----------|----------------|
| Frontend (Vercel) | Instant rollback to previous deployment |
| API routes | Deployed with frontend, same rollback |
| Database schema | Forward-only migrations (backward-compatible) |
| Edge Functions | Redeploy previous version |
| Voice agent config | Rollback in Vapi dashboard |
| SMS routing | Rollback in Twilio dashboard |
| RAG knowledge | Reindex from document store |

---

## 9. Monitoring & Observability

### 9.1 Stack

| Tool | Purpose | Data |
|------|---------|------|
| **Sentry** | Error tracking | Exceptions, stack traces, breadcrumbs |
| **PostHog** | Product analytics | Events, funnels, feature flags |
| **Vercel Analytics** | Web vitals | TTFB, LCP, CLS, FID |
| **Neon Dashboard** | DB monitoring | Query performance, connections, branching, storage |
| **Upstash Dashboard** | Cache monitoring | Hit rates, memory usage |
| **Twilio Console** | SMS monitoring | Delivery rates, failures |
| **Vapi Dashboard** | Voice monitoring | Call quality, latency, success rates |

### 9.2 Key Alerts

| Alert | Trigger | Channel |
|-------|---------|---------|
| Payment webhook failure | > 2 failures in 10 min | SMS to Rob |
| Voice agent down | No successful calls in 30 min | SMS to Rob |
| Error rate spike | > 5% error rate for 5 min | Email + Sentry |
| DB connection saturation | > 80% connections used | Email |
| Booking conflict detected | Race condition in booking | Audit log + email |
| Signature chain break | Hash chain verification failure | SMS to Rob + audit log |

---

## 10. Offline & Mobile Considerations

### 10.1 Instructor Workstation (Mobile-First)

The instructor workstation (C11) operates in a car with unreliable connectivity.

**Offline Strategy:**

```
┌──────────────────────────────────────────────┐
│ Instructor Phone/Tablet                       │
│                                               │
│  ┌─────────────────┐   ┌──────────────────┐  │
│  │ Local State      │   │ Service Worker   │  │
│  │ (IndexedDB)      │   │ (Background Sync)│  │
│  │                  │   │                  │  │
│  │ - Today's        │   │ - Queue lesson   │  │
│  │   schedule       │   │   records        │  │
│  │ - Student list   │   │ - Sync when      │  │
│  │ - Draft lessons  │   │   connected      │  │
│  │ - Competency     │   │ - Retry failed   │  │
│  │   snapshots      │   │   submissions    │  │
│  └─────────────────┘   └──────────────────┘  │
│                                               │
│  Write lesson offline → Queue → Auto-sync     │
│  Signatures captured offline → Queued upload  │
│  Target: < 90 seconds per lesson recording    │
└──────────────────────────────────────────────┘
```

**Conflict Resolution:**
- Optimistic writes (offline changes applied locally immediately)
- Server is source of truth on sync
- Signature timestamps use device clock + server verification
- GPS captured at time of signing (even if queued for upload)

---

## 11. Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Public page load (LCP) | < 2.5s | Vercel Analytics |
| Booking widget interaction | < 1s response | PostHog timing |
| API response (p95) | < 500ms | Sentry performance |
| RAG query response | < 3s | Custom timing |
| Voice agent response latency | < 2s | Vapi analytics |
| SMS response time | < 5s | Custom timing |
| Lesson recording flow | < 90s total | User testing |
| Signature upload | < 3s | Custom timing |
| Search (vector) | < 500ms | Custom timing |
| Database query (p95) | < 100ms | Neon dashboard |

---

## 12. Phase Build Order (Architecture-Informed)

Based on dependency analysis from this architecture:

### Phase 0: Foundation (Week 1-2)
**Must exist before anything else:**
- Database schema (all tables, RLS, functions, triggers)
- Neon project setup (Sydney region, main branch, pgvector extension)
- Clerk application setup (auth flows, webhook endpoints, custom session claims)
- Cloudflare R2 bucket setup (Sydney, CORS, signed URL config)
- Next.js project scaffold with TypeScript, Drizzle, Tailwind
- CI/CD pipeline (GitHub Actions → Vercel)
- Environment configuration (dev/staging/prod)
- Seed data (competency_tasks, default services)

### Phase 1: Revenue Engine (Weeks 3-6)
**Gets bookings and payments flowing:**
- C01: Public website (landing pages, SEO foundation)
- C08: Booking engine (availability, reserve, confirm)
- C02: Booking widget (embedded in website)
- C10: Payment engine (Stripe integration, basic invoicing)
- C09: CRM contacts (auto-create from bookings)
- C18: Notification engine (booking confirmations, reminders)

### Phase 2: Never Miss a Lead (Weeks 7-12)
**AI answers when Rob can't:**
- C07: RAG knowledge engine (index FAQ, services, road rules)
- C05: Voice agent (Vapi.ai setup, function calling)
- C06: SMS chatbot (Twilio inbound → RAG → reply)
- C04: Web chat widget (embedded on website)

### Phase 3: Digitise the Paperwork (Weeks 13-20)
**Replace all paper forms:**
- C11: Instructor workstation (lesson recording, offline)
- C12: CBT&A compliance engine (competency tracking, progression)
- C13: E-signature service (dual capture, hash chain)
- C14: Audit trail (immutable logging)
- C15: Private notes (instructor-only)
- C25: Lesson bridge form generator

### Phase 4: Student & Parent Experience (Weeks 21-28)
**Self-service portals:**
- C03: Student portal (progress, bookings, forms, payments)
- C16: Parent resource center (visibility per privacy settings)
- C24: Driver trainer self-assessment tool

### Phase 5: Content & Authority (Weeks 29-34)
**SEO and educational content:**
- C17: Competency Hub (23+ task pages)
- C01: Website content expansion (blog, testimonials, resources)

### Phase 6: Scale (Weeks 35-42)
**Multi-instructor readiness:**
- C19: Admin panel (KPI dashboard, instructor management)
- C20: Multi-tenant RBAC expansion (contractor onboarding)
- C23: Analytics & monitoring (full observability)

---

## 13. Architecture Decision Records (ADRs)

### ADR-001: Neon + Clerk + R2 over Supabase all-in-one
**Context:** Need managed PostgreSQL, auth, and file storage. Supabase bundles all three but creates vendor lock-in. Owner has existing Neon and Supabase accounts.
**Decision:** Neon (database) + Clerk (auth) + Cloudflare R2 (storage). Best-of-breed stack.
**Rationale:**
- **Neon** is a purpose-built serverless Postgres company. Scale-to-zero saves cost at low traffic (database idle overnight/weekends). Instant branching gives per-PR database copies for free. pgvector built-in. Sydney region.
- **Clerk** is a purpose-built auth company. Superior MFA, passkey support, pre-built UI components, organization management (future multi-instructor), webhook-driven sync. More robust than Supabase Auth.
- **Cloudflare R2** provides S3-compatible storage with zero egress fees and Sydney presence. Cheaper than Supabase Storage at any scale.
- **Tradeoff:** More services to wire together (3 vs 1). But each is independently replaceable — aligned with "build for replacement" principle. No single vendor lock-in.
- **Migration path:** Standard Postgres (Neon) means connection string swap to any Postgres host. Clerk's webhook model means auth can be replaced without touching the database. R2's S3 compatibility means any S3-compatible storage works.

### ADR-002: Next.js monorepo over microservices
**Context:** 25 components could be 25 separate services.
**Decision:** Single Next.js application with modular internal structure.
**Rationale:** For 1-2 instructors and 20-30 students, microservices are over-engineering. Monorepo with clear module boundaries provides the same logical separation without operational overhead. Can extract services later if needed.

### ADR-003: Drizzle ORM over Prisma
**Context:** Need TypeScript ORM with good Neon/PostgreSQL support.
**Decision:** Drizzle ORM.
**Rationale:** Better SQL transparency (you see the generated SQL), lighter weight, excellent Neon serverless driver support (`@neondatabase/serverless`), better pgvector support, schema-as-code aligns with AI-built development. Neon recommends Drizzle as primary ORM.

### ADR-004: Application-level RBAC over database-level RLS
**Context:** Need role-based access control. Supabase's approach uses PostgreSQL RLS tied to `auth.uid()`. With Clerk, auth is external.
**Decision:** Application-level RBAC enforced in Clerk middleware + service layer.
**Rationale:** 
- Clerk session claims provide role + IDs — middleware verifies before any DB query.
- Service layer scopes every query by role (instructor sees own students, student sees own data, etc.).
- Defence in depth: private_notes excluded from student/parent response shapes entirely.
- More testable: access control logic is TypeScript, not SQL policies. Unit tests cover every role path.
- More portable: not tied to any database vendor's RLS implementation.
- Tradeoff: No "last line of defence" at DB level. Mitigated by comprehensive service-layer tests and code review discipline.

### ADR-005: Internal event bus over message queue
**Context:** Components need to communicate asynchronously.
**Decision:** In-process event emitter (EventEmitter3 or similar) for v1.
**Rationale:** At current scale (< 100 events/day), an external queue (SQS, BullMQ) adds infrastructure complexity without benefit. Interface is the same — can swap implementation when scaling.

### ADR-006: Append-only compliance tables
**Context:** ACT Government may audit lesson records.
**Decision:** Lessons, competencies, signatures, and audit log are append-only (no UPDATE/DELETE).
**Rationale:** Corrections create new records linked to originals. Hash chains provide tamper evidence. Meets or exceeds paper record auditability.

### ADR-007: Custom booking engine over SaaS
**Context:** Could use BookitLive, Calendly, or similar.
**Decision:** Build custom.
**Rationale:** Deep competency integration, data sovereignty (no business data in third-party SaaS), multi-instructor ready, avoids $2K-$4K/year dependency, booking logic is core IP.

### ADR-008: Voice agent via specialised provider over custom build
**Context:** Could build voice agent from scratch with Twilio + Whisper + TTS.
**Decision:** Use Vapi.ai (or similar evaluated provider).
**Rationale:** Voice AI is rapidly evolving — specialised providers handle STT/TTS/latency/interruption/turn-taking. Custom build would take weeks and produce inferior results. Adapter pattern allows provider swap.

---

*End of System Architecture Document*

*Next: Sprint Planning (BMAD Phase 4) → Developer Stories / Component Specs (BMAD Phase 5)*
