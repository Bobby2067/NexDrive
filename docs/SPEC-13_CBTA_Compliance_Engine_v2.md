# SPEC-13: CBT&A Compliance Engine (C12)
### NexDrive Academy — Phase 3 Digitise Paperwork
**Version:** 2.0  
**Date:** 22 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.5, §5.2; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-07 (Notification Engine); SPEC-12 (E-Signature)  
**Phase:** 3 (Digitise Paperwork — Weeks 13-20)  
**Estimated Effort:** 16-18 days (up from 10-12 in v1.0)  

**Changes from v1.0:**
- Added §3.5 `logbook_scans` table
- Added §3.6 `logbook_entries` table (append-only)
- Added §3.7 `cbta_documents` table
- Added §3.8 Students table amendments (pathway, hours, credits, consent fields)
- Added §4.6 Logbook Scanner endpoints
- Added §4.7 P1 Eligibility endpoint
- Added §6 Logbook Scanner Service (server-side Claude Vision)
- Added §7 P1 Eligibility Engine
- Updated §14 implementation checklist (Phases A-F)
- Updated §15 dependencies
- Updated §16 open questions

---

## 1. Overview

The CBT&A Compliance Engine encodes the ACT Government's Competency Based Training & Assessment framework into software. It tracks student progression through 23 mandatory competency tasks, enforces prerequisite gating, manages review assessments, validates Final Drive eligibility, and generates the Certificate of Competency (Form 165751) when all requirements are met.

**Version 2.0 adds two major subsystems integrated from APEX P1 Eligibility System analysis:**

1. **Logbook Scanner** — Claude Vision-powered OCR for ACT learner logbooks. Students photograph logbook pages; the server extracts, validates, and stores supervised driving hours. Critical security adaptation: the original APEX implementation called the Anthropic API directly from the browser, exposing `ANTHROPIC_API_KEY`. NexDrive proxies all Vision API calls through a Next.js API route — the key never leaves the server.

2. **P1 Eligibility Engine** — Tracks all four gates a learner must pass before applying for a P1 licence: total hours (including ADI credit and course credits), night hours, minimum tenure, and assessments (CBT&A completion + HPT). Supports both pathways: P1_RED (under 25: 100 hours, 12-month tenure, 10 night hours) and P2_GREEN (25+: 50 hours, 6-month tenure, 5 night hours).

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **Append-only compliance.** The `student_competencies` and `logbook_entries` tables have NO `updated_at` column. Every status change or correction creates a new row. No updates, no deletes. Hash chain provides tamper evidence for `student_competencies`.
2. **`logbook_scans.status` is mutable.** The scan record itself (pending/confirmed/rejected) can be updated — it is a workflow state, not compliance data. The underlying `logbook_entries` rows are append-only.
3. **Prerequisites are enforced for assessment, not teaching.** Instructors can _teach_ any task opportunistically, but cannot mark a task as _competent_ until all prerequisites are competent.
4. **Review 1 (Task 17) gates advanced tasks.** Tasks 18-22 cannot be assessed until Review 1 is passed.
5. **Review 2 (Task 22) gates Final Drive.** Task 23 cannot be attempted until Review 2 is passed.
6. **Final Drive has hard requirements.** Minimum 45 minutes, unfamiliar roads, all 22 prior tasks competent.
7. **Transmission tracked separately.** Manual and auto achievements are independent. Certificate eligibility checks only competencies matching the student's enrolled transmission.
8. **Multi-instructor from day one.** Every query scopes by `instructor_id`.
9. **Private notes NEVER visible to students or parents.** Defence in depth — excluded from all student/parent response shapes.
10. **Hash chain integrity.** SHA-256 hash of each `student_competencies` record links to previous record. `GENESIS` for first record per student.
11. **Event-driven side effects.** Competency changes emit `COMPETENCY_ACHIEVED` events; notification/certificate listeners handle downstream effects.
12. **Claude API key never in browser.** All logbook Vision API calls proxy through `/api/v1/students/:id/logbook-scan`. `ANTHROPIC_API_KEY` is a server-side environment variable only.
13. **Australian Privacy Act compliance.** Logbook images contain PII (supervisor names, licence numbers). Consent must be recorded before collecting logbook data. Images stored in R2 (Sydney) with 7-day signed URLs.

### 1.2 Competency Status State Machine

```
                        ┌─────────────────────────────────────────────┐
                        │                                             │
  ┌─────────────┐   ┌───────┐   ┌──────────┐   ┌───────────┐        │
  │ not_started │──►│taught │──►│ assessed │──►│ competent │        │
  └─────────────┘   └───────┘   └────┬─────┘   └───────────┘        │
                                     │                                │
                                     ▼                                │
                              ┌──────────────────┐                    │
                              │ not_yet_competent │───► (reassess) ───┘
                              └──────────────────┘
```

**Valid status values:** `not_started`, `taught`, `assessed`, `competent`, `not_yet_competent`

**Transition rules:**
- `not_started` → `taught`: Instructor has introduced the skill
- `taught` → `assessed`: Instructor has formally assessed the skill
- `assessed` → `competent`: Student demonstrated competency (C marking)
- `assessed` → `not_yet_competent`: Student assessed but not yet competent (NYC marking)
- `not_yet_competent` → `assessed`: Student re-assessed (creates new row)
- Direct `not_started` → `competent` is allowed (e.g., Review tasks combine teach + assess + achieve)

**Each transition creates a NEW row** in `student_competencies`. The current status for any student+task combination is determined by the most recent row (ordered by `created_at DESC`).

---

## 2. The 23 ACT CBT&A Tasks

### 2.1 Complete Task List

| # | Name | Category | Prerequisites | Notes |
|---|------|----------|---------------|-------|
| 1 | Pre-Drive Procedure | Basic Control | — | Starting, adjusting, shutting down; seatbelt, mirrors, head restraint |
| 2 | Controls and Instruments | Basic Control | 1 | All vehicle controls, gauges, instruments |
| 3 | Moving Off and Stopping | Basic Control | 1, 2 | Smooth take-off/stop; clutch/brake coordination |
| 4 | Steering | Basic Control | 3 | Hand-over-hand, push-pull; lane position |
| 5 | Gear Changing | Basic Control | 3 | Smooth up/down changes; appropriate gear selection |
| 6 | Low Speed Manoeuvres | Basic Control | 3, 4, 5 | U-turns, 3-point turns, reversing, parking (parallel, angle, 90°) |
| 7 | Intersections — Give Way/Stop | Traffic | 3, 4, 5 | Approaching and negotiating give way and stop sign intersections |
| 8 | Intersections — Traffic Lights | Traffic | 7 | Green/amber/red/arrows; turning at traffic lights |
| 9 | Intersections — Roundabouts | Traffic | 7 | Single/multi-lane roundabouts; signalling; lane selection |
| 10 | Lane Changing and Overtaking | Traffic | 4, 7 | Safe lane changes; mirror checks; overtaking |
| 11 | Speed Management | Traffic | 3, 5 | Matching speed to conditions; speed zones; school zones |
| 12 | Gap Selection | Traffic | 7, 10 | Judging safe gaps for turning and merging |
| 13 | Following Distance | Traffic | 11 | 3-second rule; adjusting for conditions |
| 14 | Hazard Perception | Complex | 7, 11, 13 | Identifying/responding to hazards; scanning; prediction |
| 15 | Sharing the Road | Complex | 10, 14 | Vulnerable road users: cyclists, pedestrians, motorcyclists, heavy vehicles |
| 16 | Night Driving | Complex | 14 | High/low beam; reduced visibility; adjusting to darkness |
| **17** | **Review Assessment — Tasks 1-17** | **Review** | **1-16 (ALL)** | **Formal review. Gates access to Tasks 18-22.** |
| 18 | Driving in Traffic | Advanced | 10, 12, 14 | Higher volumes; multi-lane; complex environments |
| 19 | Freeway / Highway Driving | Advanced | 10, 11, 18 | Merging, exiting, high-speed roads |
| 20 | Rural / Country Roads | Advanced | 11, 14 | Unsealed roads, single-lane bridges, livestock, fatigue |
| 21 | Adverse Conditions | Advanced | 14, 16 | Rain, fog, sun glare; adjusting for conditions |
| **22** | **Review Assessment — Tasks 18-22** | **Review** | **17, 18, 19, 20, 21** | **Formal review. Gates access to Task 23.** |
| **23** | **Final Drive Assessment** | **Final** | **17, 22** | **Comprehensive final assessment. Min 45 min, unfamiliar roads.** |

### 2.2 Progression Rules

**Prerequisite Enforcement:**
- Each task has a `prerequisites` array of task numbers
- A task can be _taught_ regardless of prerequisites (opportunistic teaching)
- A task can only be _assessed_ and marked _competent_ when ALL prerequisites have `status = 'competent'`
- The API computes `can_assess: boolean` and `blocked_by: number[]` for each task

**Review Gating:**
- **Review 1 (Task 17):** Requires ALL of Tasks 1-16 to be `competent`. Uses `review_requires_tasks: [1,2,3,...,16]`.
- **Review 2 (Task 22):** Requires Task 17 to be `competent` AND ALL of Tasks 18-21 to be `competent`. Uses `prerequisites: [17,18,19,20,21]` and `review_requires_tasks: [18,19,20,21]`.
- **Advanced tasks (18-22):** Cannot be assessed until Review 1 (Task 17) is `competent`. Enforced via prerequisites — each advanced task includes direct prerequisites that chain back through Task 17.

**Final Drive Gating (Task 23):**
- Both Review 1 (Task 17) AND Review 2 (Task 22) must be `competent`
- All 22 prior tasks must be `competent` (enforced transitively through reviews)
- Minimum 45-minute duration (enforced in lesson recording, stored in `competency_tasks.final_drive_min_minutes`)
- Must be conducted on unfamiliar roads (instructor confirms via `competency_tasks.final_drive_unfamiliar_roads` flag)

### 2.3 Prerequisite Override

Admin can unlock prerequisite blocking for a specific student+task with a reason. This is logged in `audit_log` with event_type `PREREQUISITE_OVERRIDE` and must include a text reason. The override does not change the task definition — it creates a one-time bypass entry checked during `canAssessTask()`.

---

## 3. Database Tables

### 3.1 `competency_tasks` (Reference Data)

```sql
CREATE TABLE competency_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_number     INTEGER NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  category        TEXT,                              -- 'Basic Control', 'Traffic', 'Complex', 'Advanced', 'Review', 'Final'
  prerequisites   INTEGER[] DEFAULT '{}',            -- Task numbers required
  is_review       BOOLEAN NOT NULL DEFAULT FALSE,
  is_final_drive  BOOLEAN NOT NULL DEFAULT FALSE,
  review_requires_tasks INTEGER[] DEFAULT '{}',      -- For review tasks: which tasks must be competent
  final_drive_min_minutes INTEGER,                   -- 45 for Task 23
  final_drive_unfamiliar_roads BOOLEAN DEFAULT FALSE,
  competency_hub_content_id UUID,                    -- Link to educational content
  sort_order      INTEGER NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_comp_tasks_number ON competency_tasks(task_number);
```

**Seed data:** See §2.1 for all 23 tasks. Seed script in §13.

### 3.2 `student_competencies` (Append-Only)

```sql
CREATE TABLE student_competencies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(id),
  task_id         UUID NOT NULL REFERENCES competency_tasks(id),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),
  status          TEXT NOT NULL CHECK (status IN ('not_started','taught','assessed','competent','not_yet_competent')),
  transmission    TEXT NOT NULL CHECK (transmission IN ('manual', 'auto')),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lesson_id       UUID REFERENCES lessons(id),
  signed_by_instructor BOOLEAN NOT NULL DEFAULT FALSE,
  signed_by_student    BOOLEAN NOT NULL DEFAULT FALSE,
  signature_id    UUID REFERENCES signatures(id),
  previous_hash   TEXT,
  record_hash     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at — append-only
);

CREATE INDEX idx_sc_student_id ON student_competencies(student_id);
CREATE INDEX idx_sc_task_id ON student_competencies(task_id);
CREATE INDEX idx_sc_student_task ON student_competencies(student_id, task_id);
CREATE INDEX idx_sc_status ON student_competencies(status);
```

### 3.3 Hash Chain Implementation

```sql
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
       NEW.status || NEW.transmission ||
       NEW.status_changed_at::TEXT || COALESCE(NEW.previous_hash, 'GENESIS'))::bytea
    ), 'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER competency_hash_chain BEFORE INSERT ON student_competencies
  FOR EACH ROW EXECUTE FUNCTION compute_competency_hash();
```

**Hash chain is per-student.** The `previous_hash` links to the last competency record for _that student_ (not globally). First record for a student uses `'GENESIS'` as the previous hash sentinel.

### 3.4 Related Tables (Read from, Not Owned by this Spec)

- **`students`** — `transmission`, `professional_hours`, `certificate_issued_at`, `certificate_number`, `completion_date`, `status`
- **`lessons`** — `competencies_taught`, `competencies_assessed`, `competencies_achieved_manual`, `competencies_achieved_auto`, `total_minutes`, `start_time`, `end_time`
- **`signatures`** — Referenced by `student_competencies.signature_id`
- **`audit_log`** — Append competency events here

### 3.5 `logbook_scans` (NEW in v2.0)

One row per uploaded logbook page photo. Status is mutable (workflow state). Images stored in R2.

```sql
CREATE TABLE logbook_scans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(id),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),  -- Who reviewed/confirmed

  -- Image storage
  r2_object_key   TEXT NOT NULL,           -- Path in R2: logbooks/{student_id}/{uuid}.jpg
  r2_bucket       TEXT NOT NULL DEFAULT 'nexdrive-uploads',
  file_size_bytes INTEGER,
  mime_type       TEXT NOT NULL DEFAULT 'image/jpeg',

  -- Claude Vision extraction
  page_type       TEXT CHECK (page_type IN ('BLUE_DAY', 'RED_NIGHT', 'GREEN_ADI', 'ADI_STAMP')),
  page_number     INTEGER,                 -- Page number visible in logbook (if OCR-detectable)
  raw_extraction  JSONB,                   -- Full Claude Vision JSON response (for debugging)
  extraction_model TEXT,                  -- e.g. 'claude-sonnet-4-5' (for audit trail)
  extraction_confidence TEXT CHECK (extraction_confidence IN ('high', 'medium', 'low')),
  page_notes      TEXT,                    -- Claude's observations about the page quality

  -- Workflow status (MUTABLE — this is not compliance data)
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'rejected')),
  reviewed_by     UUID REFERENCES instructors(id),
  reviewed_at     TIMESTAMPTZ,
  rejection_reason TEXT,

  -- Validation summary
  entry_count     INTEGER NOT NULL DEFAULT 0,
  valid_entry_count INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  warning_count   INTEGER NOT NULL DEFAULT 0,
  total_minutes   INTEGER NOT NULL DEFAULT 0,   -- Sum of valid entries on this page

  -- Timestamps
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_logbook_scans_student ON logbook_scans(student_id);
CREATE INDEX idx_logbook_scans_status ON logbook_scans(status);
CREATE INDEX idx_logbook_scans_page_type ON logbook_scans(page_type);
```

### 3.6 `logbook_entries` (NEW in v2.0 — Append-Only)

One row per driving session extracted from a logbook scan page. **Append-only — no updates, no deletes.** If a scan is rejected, the entries are not deleted; they are simply not counted (filtered by `logbook_scans.status = 'confirmed'`).

```sql
CREATE TABLE logbook_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  logbook_scan_id UUID NOT NULL REFERENCES logbook_scans(id),
  student_id      UUID NOT NULL REFERENCES students(id),

  -- Extracted data
  row_number      INTEGER NOT NULL,              -- Row on the logbook page (1-based)
  entry_date      DATE,                          -- Parsed date (null if UNCLEAR)
  weather         TEXT,
  supervisor_name TEXT,                          -- Supervisor or ADI name
  licence_number  TEXT,                          -- Supervisor licence or ADI number
  start_time      TIME,
  finish_time     TIME,
  duration_minutes INTEGER,                      -- Calculated from start/finish
  has_signature   BOOLEAN NOT NULL DEFAULT FALSE,
  odometer_start  INTEGER,
  odometer_finish INTEGER,
  is_night        BOOLEAN NOT NULL DEFAULT FALSE, -- Derived from page_type = RED_NIGHT
  is_adi          BOOLEAN NOT NULL DEFAULT FALSE, -- Derived from page_type = GREEN_ADI or ADI_STAMP
  confidence      TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  entry_notes     TEXT,

  -- Validation
  is_valid        BOOLEAN NOT NULL DEFAULT FALSE,
  validation_errors JSONB DEFAULT '[]',          -- Array of error objects
  validation_warnings JSONB DEFAULT '[]',

  -- Credit calculation (applied at aggregate level, stored here for reference)
  -- Raw minutes: duration_minutes
  -- Credited minutes calculated at query time from cumulative ADI hours

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at — append-only
);

CREATE INDEX idx_logbook_entries_scan ON logbook_entries(logbook_scan_id);
CREATE INDEX idx_logbook_entries_student ON logbook_entries(student_id);
CREATE INDEX idx_logbook_entries_date ON logbook_entries(entry_date);
CREATE INDEX idx_logbook_entries_valid ON logbook_entries(is_valid);
```

### 3.7 `cbta_documents` (NEW in v2.0)

Stores uploaded CBT&A completion documents (e.g., signed Form 10.044 PDFs, Safer Drivers Course certificates, VRU course certificates, First Aid certificates). Separate from logbook_scans.

```sql
CREATE TABLE cbta_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(id),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),
  document_type   TEXT NOT NULL CHECK (document_type IN (
    'safer_drivers_certificate',
    'vru_certificate',
    'first_aid_certificate',
    'cbta_completion',
    'hpt_record',
    'other'
  )),
  r2_object_key   TEXT NOT NULL,
  r2_bucket       TEXT NOT NULL DEFAULT 'nexdrive-uploads',
  file_name       TEXT NOT NULL,
  file_size_bytes INTEGER,
  mime_type       TEXT,
  notes           TEXT,
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by     UUID REFERENCES instructors(id),
  verified_at     TIMESTAMPTZ,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cbta_docs_student ON cbta_documents(student_id);
CREATE INDEX idx_cbta_docs_type ON cbta_documents(document_type);
```

### 3.8 Students Table Amendments (NEW in v2.0 — SPEC-01 Amendment Required)

The following columns must be added to the existing `students` table. This amendment must be reflected in SPEC-01 v1.2.

```sql
-- P1 Eligibility: Pathway determination
ALTER TABLE students ADD COLUMN pathway TEXT CHECK (pathway IN ('P1_RED', 'P2_GREEN'));
ALTER TABLE students ADD COLUMN age_at_licence_issue INTEGER;      -- Calculated on licence issue date entry
ALTER TABLE students ADD COLUMN licence_issue_date DATE;            -- May be derived from expiry (expiry - 5 years)
ALTER TABLE students ADD COLUMN tenure_start_date DATE;             -- Date L-plates started (for 12/6 month gate)
ALTER TABLE students ADD COLUMN earliest_p1_eligible_date DATE;    -- Calculated: tenure_start + months_required

-- Hours tracking (supervised = logbook; professional = Rob's lessons)
ALTER TABLE students ADD COLUMN supervised_day_hours DECIMAL(6,2) NOT NULL DEFAULT 0;   -- From confirmed BLUE_DAY scans
ALTER TABLE students ADD COLUMN supervised_night_hours DECIMAL(6,2) NOT NULL DEFAULT 0; -- From confirmed RED_NIGHT scans
ALTER TABLE students ADD COLUMN adi_actual_hours DECIMAL(6,2) NOT NULL DEFAULT 0;       -- From confirmed GREEN_ADI/ADI_STAMP scans (raw, before credit)
-- Note: professional_hours (already exists) = hours with Rob

-- P1 Credit bonuses
ALTER TABLE students ADD COLUMN safer_driver_credit BOOLEAN NOT NULL DEFAULT FALSE;     -- +20 hours credit
ALTER TABLE students ADD COLUMN vru_credit BOOLEAN NOT NULL DEFAULT FALSE;               -- +10 hours credit
ALTER TABLE students ADD COLUMN first_aid_credit BOOLEAN NOT NULL DEFAULT FALSE;         -- +5 hours credit

-- Assessments (separate from CBT&A tasks — these are external gate checks)
ALTER TABLE students ADD COLUMN hpt_completed BOOLEAN NOT NULL DEFAULT FALSE;           -- Hazard Perception Test
ALTER TABLE students ADD COLUMN hpt_date DATE;
ALTER TABLE students ADD COLUMN hpt_reference TEXT;                                     -- ACT Government reference number if available

-- P1 Eligibility status (calculated, cached for display — source of truth is the service function)
ALTER TABLE students ADD COLUMN p1_eligibility_status TEXT DEFAULT 'not_eligible'
  CHECK (p1_eligibility_status IN ('eligible', 'pending_hours', 'pending_night_hours', 'pending_tenure', 'pending_assessments', 'not_eligible'));
ALTER TABLE students ADD COLUMN p1_eligibility_checked_at TIMESTAMPTZ;

-- Privacy Act compliance (Australian Privacy Act 1988)
ALTER TABLE students ADD COLUMN consent_given BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE students ADD COLUMN consent_timestamp TIMESTAMPTZ;
ALTER TABLE students ADD COLUMN privacy_policy_version TEXT DEFAULT '1.0';
ALTER TABLE students ADD COLUMN data_retention_until DATE;          -- 5 years after completion
ALTER TABLE students ADD COLUMN marked_for_deletion BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE students ADD COLUMN deletion_requested_at TIMESTAMPTZ;
```

---

## 4. API Endpoints

### 4.1 GET /api/v1/competency-tasks

**Purpose:** Return all 23 ACT CBT&A tasks with prerequisites and metadata.  
**Auth:** 🔑 Any authenticated user  
**Rate Limit:** 60/min  

```typescript
// src/app/api/v1/competency-tasks/route.ts
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { competencyTasks } from '@/db/schema';
import { asc, eq } from 'drizzle-orm';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const tasks = await db
    .select({
      id: competencyTasks.id,
      task_number: competencyTasks.taskNumber,
      name: competencyTasks.name,
      description: competencyTasks.description,
      category: competencyTasks.category,
      prerequisites: competencyTasks.prerequisites,
      is_review: competencyTasks.isReview,
      is_final_drive: competencyTasks.isFinalDrive,
      review_requires_tasks: competencyTasks.reviewRequiresTasks,
      final_drive_min_minutes: competencyTasks.finalDriveMinMinutes,
      final_drive_unfamiliar_roads: competencyTasks.finalDriveUnfamiliarRoads,
      sort_order: competencyTasks.sortOrder,
    })
    .from(competencyTasks)
    .where(eq(competencyTasks.isActive, true))
    .orderBy(asc(competencyTasks.sortOrder));

  return Response.json({ tasks });
}
```

**Caching:** Reference data. Cache with 1-hour TTL in Upstash Redis. Invalidate on admin update.

---

### 4.2 GET /api/v1/students/:id/competencies

**Purpose:** Full competency matrix for a student — current status per task with `can_assess` and `blocked_by` flags.  
**Auth:** 🔑 Instructor (own students), Student (own), Parent (linked, if `can_view_progress = true`), Admin (all)  
**Rate Limit:** 60/min  

**Query Parameters:**
- `transmission` (optional): Filter by `manual` or `auto`. Defaults to student's enrolled transmission.

**Response:**
```json
{
  "student_id": "uuid",
  "transmission": "auto",
  "competencies": [
    {
      "task_number": 1,
      "task_name": "Pre-Drive Procedure",
      "category": "Basic Control",
      "status": "competent",
      "transmission": "auto",
      "taught_at": "2025-06-15T10:30:00Z",
      "assessed_at": "2025-06-22T10:30:00Z",
      "achieved_at": "2025-06-22T10:30:00Z",
      "lesson_id": "uuid",
      "can_assess": true,
      "blocked_by": [],
      "is_review": false,
      "is_final_drive": false,
      "history_count": 3
    }
  ],
  "summary": {
    "total": 23,
    "competent": 6,
    "in_progress": 4,
    "not_started": 13,
    "not_yet_competent": 0
  }
}
```

**Core SQL (latest status per task):**
```sql
SELECT DISTINCT ON (sc.task_id)
  sc.*, ct.task_number, ct.name, ct.category, ct.prerequisites,
  ct.is_review, ct.is_final_drive
FROM student_competencies sc
JOIN competency_tasks ct ON sc.task_id = ct.id
WHERE sc.student_id = $1 AND sc.transmission = $2
ORDER BY sc.task_id, sc.created_at DESC;
```

For tasks with no rows, the status is `not_started`. Left join all active `competency_tasks` against the latest status subquery.

**`can_assess` computation:**
```typescript
function canAssessTask(
  taskNumber: number,
  allTasks: CompetencyTask[],
  currentStatuses: Map<number, CompetencyStatus>
): { can_assess: boolean; blocked_by: number[] } {
  const task = allTasks.find(t => t.task_number === taskNumber);
  if (!task) return { can_assess: false, blocked_by: [] };

  const blocked_by: number[] = [];
  for (const prereqNumber of task.prerequisites) {
    const prereqStatus = currentStatuses.get(prereqNumber) ?? 'not_started';
    if (prereqStatus !== 'competent') blocked_by.push(prereqNumber);
  }
  return { can_assess: blocked_by.length === 0, blocked_by };
}
```

**RBAC enforcement:**
```typescript
// Instructor: only own students
if (authContext.role === 'instructor') {
  const student = await getStudent(studentId);
  if (student.instructor_id !== authContext.instructor_id) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
}
// Student: only own
if (authContext.role === 'student') {
  if (studentId !== authContext.student_id) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
}
// Parent: only linked with permission
if (authContext.role === 'parent') {
  const link = await getParentStudentLink(authContext.parent_id, studentId);
  if (!link || !link.can_view_progress) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
}
```

---

### 4.3 POST /api/v1/students/:id/competencies

**Purpose:** Record a competency status change. Creates a new append-only row.  
**Auth:** 🎓 Instructor only (own students)  
**Rate Limit:** 30/min  

**Request Body:**
```json
{
  "task_number": 5,
  "status": "competent",
  "transmission": "auto",
  "lesson_id": "uuid",
  "signature_id": "uuid"
}
```

**Validation Rules:**
1. `status` must be valid: one of `taught`, `assessed`, `competent`, `not_yet_competent`
2. `transmission` must be `manual` or `auto`
3. Status transition must be logically valid (cannot go `not_started` → `not_yet_competent`)
4. For `competent` or `assessed` status: all prerequisites must be `competent` (409 if not)
5. For `taught` status: prerequisites NOT enforced (opportunistic teaching)
6. Review gating enforced
7. Instructor must own the student

**Error Responses:**

| Code | Condition |
|------|-----------|
| 400 | Invalid status value or transition |
| 403 | Instructor doesn't own this student |
| 409 | Prerequisites not met (returns `blocked_by` array) |
| 422 | Task number not found |

**409 Response:**
```json
{
  "error": "Prerequisites not met",
  "code": "PREREQUISITES_NOT_MET",
  "blocked_by": [3, 4],
  "blocked_by_names": ["Moving Off and Stopping", "Steering"],
  "task_number": 6,
  "task_name": "Low Speed Manoeuvres"
}
```

**Implementation:** See `recordCompetencyChange()` in §5.1.

---

### 4.4 GET /api/v1/students/:id/certificate-eligibility

**Purpose:** Check whether a student has met all CBT&A requirements for the Certificate of Competency.  
**Auth:** 🎓 Instructor (own students), Admin  
**Rate Limit:** 30/min  

**Response:**
```json
{
  "eligible": false,
  "student_id": "uuid",
  "student_name": "Jane Smith",
  "transmission": "auto",
  "total_tasks": 23,
  "competent_tasks": 19,
  "missing_tasks": [
    { "task_number": 21, "name": "Adverse Conditions", "status": "not_started" }
  ],
  "review_1_passed": true,
  "review_2_passed": false,
  "final_drive_passed": false,
  "professional_hours": 18.5,
  "minimum_hours_met": false,
  "minimum_hours_required": 20,
  "certificate_already_issued": false
}
```

---

### 4.5 POST /api/v1/students/:id/certificate

**Purpose:** Generate the Certificate of Competency PDF (Form 165751) and update student records.  
**Auth:** 🎓 Instructor (own students) + Admin  
**Rate Limit:** 5/min  

**Request Body:**
```json
{
  "confirm": true,
  "unfamiliar_roads_confirmed": true,
  "notes": "Outstanding student."
}
```

**Pre-conditions:** All 23 tasks competent, minimum professional hours met, no existing certificate, `confirm: true`, Final Drive ≥ 45 minutes.

**Response (201):**
```json
{
  "certificate_number": "CERT-2025-0042",
  "student_id": "uuid",
  "student_name": "Jane Smith",
  "pdf_url": "https://r2.nexdrive.com.au/certificates/uuid/CERT-2025-0042.pdf",
  "issued_at": "2025-09-15T14:30:00Z",
  "transmission": "auto",
  "instructor_name": "Rob Harrison",
  "instructor_adi_number": "ADI-12345"
}
```

**Certificate Number Format:** `CERT-YYYY-NNNN` (sequential per year, padded).  
**R2 Path:** `certificates/{student_id}/{certificate_number}.pdf`  
**PDF Library:** Puppeteer (HTML template → PDF) or `@react-pdf/renderer`.

**PDF Layout (Form 165751):**

| Section | Content |
|---------|---------|
| Header | NexDrive Academy logo, "Certificate of Competency", ACT reference |
| Student | Full name, DOB, licence number, address |
| Instructor | Full name, ADI number |
| Transmission | Manual / Automatic |
| Competency Table | All 23 tasks: task number, name, date achieved |
| Reviews | Review 1 date, Review 2 date, Final Drive date |
| Professional Hours | Total hours with instructor |
| Declaration | Dual declaration text |
| Signatures | Instructor + student signatures |
| Serial | Certificate number + issue date |

---

### 4.6 Logbook Scanner Endpoints (NEW in v2.0)

#### POST /api/v1/students/:id/logbook-scan

**Purpose:** Upload a logbook page photo. Server extracts data via Claude Vision. Returns scan result with validation.  
**Auth:** 🔑 Instructor (own students) or Student (own, if enabled)  
**Rate Limit:** 10/min per student (Vision API is expensive)  
**Max File Size:** 10MB  
**Accepted MIME Types:** `image/jpeg`, `image/png`, `image/webp`, `image/heic`  

**Request:** `multipart/form-data`
```
image: <file>          -- The logbook page photo
page_hint: "BLUE_DAY"  -- Optional hint to improve detection accuracy
```

**Critical Architecture Note:** The `ANTHROPIC_API_KEY` environment variable is accessed **only on the server** inside this API route. The client uploads the image to this endpoint; this endpoint calls the Anthropic API internally. The client never sees the API key.

**Processing Flow:**
1. Validate file type and size
2. Upload raw image to R2: `logbooks/{student_id}/{uuid}.jpg`
3. Convert to base64 (in memory)
4. Call Claude Vision API with structured extraction prompt (see §6.2)
5. Parse and validate extracted entries (see §6.3)
6. Insert 1 row into `logbook_scans` (status = 'pending')
7. Insert N rows into `logbook_entries` (one per extracted row)
8. Return scan result

**Response (201):**
```json
{
  "scan_id": "uuid",
  "status": "pending",
  "page_type": "BLUE_DAY",
  "page_number": 3,
  "entry_count": 8,
  "valid_entry_count": 7,
  "error_count": 1,
  "warning_count": 2,
  "total_minutes": 540,
  "total_hours": 9.0,
  "entries": [
    {
      "id": "uuid",
      "row_number": 1,
      "entry_date": "2025-08-12",
      "weather": "Fine",
      "supervisor_name": "John Smith",
      "licence_number": "ACT123456",
      "start_time": "09:00",
      "finish_time": "10:30",
      "duration_minutes": 90,
      "has_signature": true,
      "odometer_start": 45230,
      "odometer_finish": 45320,
      "is_night": false,
      "is_adi": false,
      "confidence": "high",
      "is_valid": true,
      "validation_errors": [],
      "validation_warnings": []
    }
  ],
  "errors": [],
  "warnings": [
    { "row": 4, "field": "signature", "message": "Signature appears to be missing" }
  ],
  "page_notes": "All entries clearly written. Row 4 signature unclear.",
  "image_url": "https://r2.nexdrive.com.au/logbooks/uuid/uuid.jpg",
  "action_required": "Instructor must review and confirm or reject this scan."
}
```

**Error Responses:**

| Code | Condition |
|------|-----------|
| 400 | Invalid file type or size |
| 403 | Not authorised for this student |
| 409 | Student has not given consent for logbook data collection |
| 422 | Claude Vision API could not detect a valid logbook page |
| 503 | Anthropic API unavailable |

---

#### PATCH /api/v1/students/:id/logbook-scans/:scanId

**Purpose:** Instructor confirms or rejects a logbook scan. On confirmation, supervised hours are recalculated and cached on the student record.  
**Auth:** 🎓 Instructor only  
**Rate Limit:** 30/min  

**Request Body:**
```json
{
  "action": "confirm",
  "rejection_reason": null
}
```
or
```json
{
  "action": "reject",
  "rejection_reason": "Incorrect dates — this logbook belongs to another student"
}
```

**Business Logic on `confirm`:**
1. Set `logbook_scans.status = 'confirmed'`, `reviewed_by`, `reviewed_at`
2. Recalculate supervised hours from all confirmed scans for this student:
   - `supervised_day_hours` = sum of valid BLUE_DAY entry minutes ÷ 60
   - `supervised_night_hours` = sum of valid RED_NIGHT entry minutes ÷ 60
   - `adi_actual_hours` = sum of valid GREEN_ADI + ADI_STAMP entry minutes ÷ 60
3. Update cached values on `students` record
4. Recalculate and cache `p1_eligibility_status`
5. Write audit log entry

**Business Logic on `reject`:**
1. Set `logbook_scans.status = 'rejected'`, `rejection_reason`
2. Logbook entries remain in DB (append-only) but are not counted
3. Write audit log entry

**Response (200):**
```json
{
  "scan_id": "uuid",
  "status": "confirmed",
  "hours_impact": {
    "supervised_day_hours_added": 9.0,
    "supervised_night_hours_added": 0,
    "adi_hours_added": 0,
    "student_totals": {
      "supervised_day_hours": 45.5,
      "supervised_night_hours": 8.0,
      "adi_actual_hours": 6.0
    }
  }
}
```

---

#### GET /api/v1/students/:id/logbook-scans

**Purpose:** List all logbook scans for a student with summary data.  
**Auth:** 🔑 Instructor (own students), Student (own), Admin  
**Rate Limit:** 60/min  

**Response:**
```json
{
  "student_id": "uuid",
  "scans": [
    {
      "id": "uuid",
      "status": "confirmed",
      "page_type": "BLUE_DAY",
      "page_number": 3,
      "valid_entry_count": 7,
      "total_minutes": 540,
      "uploaded_at": "2025-08-15T14:30:00Z",
      "reviewed_at": "2025-08-15T15:00:00Z"
    }
  ],
  "totals": {
    "supervised_day_hours": 45.5,
    "supervised_night_hours": 8.0,
    "adi_actual_hours": 6.0,
    "pending_scans": 1,
    "confirmed_scans": 8,
    "rejected_scans": 0
  }
}
```

---

### 4.7 P1 Eligibility Endpoint (NEW in v2.0)

#### GET /api/v1/students/:id/p1-eligibility

**Purpose:** Comprehensive P1 licence eligibility check across all four gates.  
**Auth:** 🔑 Instructor (own students), Student (own), Admin  
**Rate Limit:** 60/min  

**Response:**
```json
{
  "student_id": "uuid",
  "student_name": "Jane Smith",
  "pathway": "P1_RED",
  "pathway_description": "Under 25 at time of L-plate issue",
  "overall_eligible": false,
  "eligibility_status": "pending_hours",
  "gates": {
    "hours": {
      "passed": false,
      "required": 100,
      "current_credited": 73.5,
      "remaining": 26.5,
      "breakdown": {
        "supervised_day_hours": 45.5,
        "supervised_night_hours": 8.0,
        "adi_actual_hours": 6.0,
        "adi_credited_hours": 18.0,
        "safer_driver_bonus": 20,
        "vru_bonus": 0,
        "first_aid_bonus": 0,
        "total_credited": 73.5
      },
      "credit_note": "First 10 ADI hours count as 30 credited hours (3:1 multiplier). ADI hours beyond 10 count 1:1."
    },
    "night_hours": {
      "passed": false,
      "required": 10,
      "current": 8.0,
      "remaining": 2.0
    },
    "tenure": {
      "passed": true,
      "tenure_start_date": "2024-08-01",
      "months_required": 12,
      "earliest_eligible_date": "2025-08-01",
      "days_until_eligible": 0,
      "currently_met": true
    },
    "assessments": {
      "passed": false,
      "cbta_completed": true,
      "cbta_date": "2025-07-15",
      "hpt_completed": false,
      "hpt_date": null,
      "missing": ["hpt"]
    }
  },
  "credits": {
    "safer_driver": false,
    "vru": false,
    "first_aid": false
  },
  "pending_scans": 1,
  "checked_at": "2025-09-15T14:30:00Z"
}
```

**ADI Credit Calculation:**
- First 10 actual ADI hours → 3× credit (10 actual hours = 30 credited hours)
- ADI hours beyond 10 → 1× credit
- Example: 15 actual ADI hours = (10 × 3) + (5 × 1) = 35 credited hours

**Course Credits:**
- Safer Drivers Course → +20 hours (verify via uploaded certificate in `cbta_documents`)
- Vulnerable Road Users (VRU) course → +10 hours
- Accredited First Aid → +5 hours

**Pathway determination:**
- `P1_RED` (under 25 at L-plate issue): 100 hours total, 10 night, 12-month tenure
- `P2_GREEN` (25+ at L-plate issue): 50 hours total, 5 night, 6-month tenure

---

## 5. Service Layer Functions

### 5.1 Core Competency Functions

```typescript
// ─── File: src/services/competency.service.ts ───────────────────

export async function getAllCompetencyTasks(): Promise<CompetencyTask[]>

export async function getCurrentCompetencyStatuses(
  studentId: string,
  transmission: 'manual' | 'auto'
): Promise<Map<number, CompetencyStatus>>

export async function getCompetencyMatrix(
  studentId: string,
  transmission?: 'manual' | 'auto'
): Promise<CompetencyMatrix>

export async function recordCompetencyChange(params: {
  studentId: string;
  taskNumber: number;
  status: CompetencyStatus;
  transmission: 'manual' | 'auto';
  lessonId?: string;
  signatureId?: string;
  instructorId: string;
}): Promise<StudentCompetency>

export async function canAssessTask(
  studentId: string,
  taskNumber: number,
  transmission: 'manual' | 'auto'
): Promise<{ can_assess: boolean; blocked_by: number[] }>

export async function checkCertificateEligibility(
  studentId: string,
  transmission?: 'manual' | 'auto'
): Promise<CertificateEligibility>

export async function generateCertificate(
  studentId: string,
  instructorId: string,
  options: { confirm: boolean; notes?: string }
): Promise<{ certificate_number: string; pdf_url: string }>

export async function processLessonCompetencies(params: {
  lessonId: string;
  studentId: string;
  instructorId: string;
  competenciesTaught: number[];
  competenciesAssessed: number[];
  competenciesAchievedManual: number[];
  competenciesAchievedAuto: number[];
  signatureId?: string;
}): Promise<{ created: number; events_emitted: number }>
```

### 5.2 Analytics Functions

```typescript
export async function getProgressAnalytics(
  studentId: string,
  transmission?: 'manual' | 'auto'
): Promise<ProgressAnalytics>

export async function verifyHashChain(studentId: string): Promise<{
  valid: boolean;
  total_records: number;
  first_broken_record_id?: string;
}>
```

---

## 6. Logbook Scanner Service (NEW in v2.0)

### 6.1 Architecture

```
Student/Instructor Browser
        │
        │  multipart/form-data (image)
        ▼
Next.js API Route: POST /api/v1/students/:id/logbook-scan
        │
        ├─── Upload image to R2 (Cloudflare SDK)
        │
        ├─── ANTHROPIC_API_KEY (server env only — NEVER sent to browser)
        │
        ├─── Call Anthropic API: claude-sonnet-4-5 with Vision
        │
        ├─── Parse + validate extraction
        │
        ├─── INSERT logbook_scans
        │
        └─── INSERT logbook_entries (one per row)
```

**Key difference from APEX implementation:** The original APEX code called the Anthropic API directly from the browser (passing `apiKey` to the `LogbookScanner` constructor). NexDrive's implementation runs entirely server-side. The browser never sees `ANTHROPIC_API_KEY`.

### 6.2 Claude Vision Prompt

```typescript
// ─── File: src/services/logbook-scanner.service.ts ──────────────

const LOGBOOK_EXTRACTION_PROMPT = `You are analyzing an ACT (Australian Capital Territory) learner driver logbook page.

IMPORTANT: Extract ALL handwritten entries from this logbook page with extreme accuracy.

First, identify the page type by the header color:
- BLUE header = "RECORD OF DRIVING HOURS - DAY WITH A SUPERVISING DRIVER"
- RED header = "RECORD OF DRIVING HOURS - NIGHT WITH A SUPERVISING DRIVER"
- GREEN header = "RECORD OF DRIVING HOURS - DAY WITH AN ACT ADI"
- Grey/White with "ACT ACCREDITED DRIVER INSTRUCTOR PRACTICE" = ADI Stamp page

For each row with data, extract:
1. DATE (format: DD/MM/YYYY)
2. WEATHER CONDITIONS (if visible)
3. SUPERVISOR/ADI NAME
4. LICENCE/ADI NUMBER
5. START TIME (24hr format HH:MM)
6. FINISH TIME (24hr format HH:MM)
7. TOTAL TIME (in hours and minutes, e.g., "1:30")
8. Whether signature appears present (true/false)
9. ODOMETER START (if visible)
10. ODOMETER FINISH (if visible)

Also note:
- Any entries that are illegible or unclear (mark as "UNCLEAR")
- Any obvious errors (e.g., finish time before start time)
- The page subtotal if visible

Respond ONLY with valid JSON in this exact format:
{
  "pageType": "BLUE_DAY" | "RED_NIGHT" | "GREEN_ADI" | "ADI_STAMP",
  "pageNumber": <number if visible or null>,
  "entries": [
    {
      "rowNumber": 1,
      "date": "DD/MM/YYYY" or "UNCLEAR",
      "weather": "string or null",
      "supervisorName": "string or UNCLEAR",
      "licenceNumber": "string or UNCLEAR",
      "startTime": "HH:MM" or "UNCLEAR",
      "finishTime": "HH:MM" or "UNCLEAR",
      "totalTime": "H:MM" or "UNCLEAR",
      "hasSignature": true or false,
      "odometerStart": number or null,
      "odometerFinish": number or null,
      "confidence": "high" | "medium" | "low",
      "notes": "any issues or observations"
    }
  ],
  "subtotal": "H:MM if visible on page or null",
  "pageNotes": "any overall observations about page quality"
}

Common handwriting confusions to watch for: 1 vs 7, 0 vs 6, 4 vs 9, 5 vs 6.
If uncertain, mark confidence as "low" and add a note.`;
```

### 6.3 Validation Logic

```typescript
interface ValidationRule {
  maxSessionHours: 2;           // Max 2 hours before mandatory break
  minSessionMinutes: 5;         // Minimum valid session duration
  maxDailyHours: 8;             // Sanity check
  timeMismatchToleranceMinutes: 5;  // Allowed difference between recorded and calculated
  maxSpeedKmh: 110;             // Max average speed check (odometer sanity)
}

function validateLogbookEntry(entry: RawExtractedEntry, pageType: PageType): ValidatedEntry {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // 1. Parse date — must be in past, after 2020-01-01
  const parsedDate = parseDate(entry.date);
  if (!parsedDate) errors.push({ field: 'date', message: 'Invalid or unclear date' });
  else if (parsedDate > new Date()) errors.push({ field: 'date', message: 'Date is in the future' });

  // 2. Parse times and calculate duration
  const startMinutes = parseTime(entry.startTime);
  const finishMinutes = parseTime(entry.finishTime);
  let calculatedDuration: number | null = null;

  if (startMinutes !== null && finishMinutes !== null) {
    // Handle overnight (finish before start = crossed midnight)
    const adjustedFinish = finishMinutes < startMinutes ? finishMinutes + 1440 : finishMinutes;
    calculatedDuration = adjustedFinish - startMinutes;

    if (calculatedDuration < 5) errors.push({ field: 'duration', message: 'Session under 5 minutes' });
    if (calculatedDuration > 120) warnings.push({ field: 'duration', message: 'Session over 2 hours — break required' });

    // Compare with recorded total (>5 min difference = error)
    const recordedDuration = parseDuration(entry.totalTime);
    if (recordedDuration !== null && Math.abs(calculatedDuration - recordedDuration) > 5) {
      errors.push({
        field: 'totalTime',
        message: `Time mismatch: recorded ${formatDuration(recordedDuration)} but calculated ${formatDuration(calculatedDuration)}`
      });
    }
  }

  // 3. Check signature
  if (!entry.hasSignature) warnings.push({ field: 'signature', message: 'Signature appears missing' });

  // 4. Odometer sanity check
  if (entry.odometerStart && entry.odometerFinish) {
    const distance = entry.odometerFinish - entry.odometerStart;
    if (distance < 0) errors.push({ field: 'odometer', message: 'Odometer finish less than start' });
    else if (calculatedDuration && distance / (calculatedDuration / 60) > 110) {
      warnings.push({ field: 'odometer', message: 'Average speed exceeds 110 km/h — check readings' });
    }
  }

  // 5. Low confidence
  if (entry.confidence === 'low') warnings.push({ field: 'general', message: 'Low confidence — please verify manually' });

  return {
    ...entry,
    parsedDate,
    calculatedDuration,
    durationMinutes: calculatedDuration ?? parseDuration(entry.totalTime),
    isNight: pageType === 'RED_NIGHT',
    isAdi: pageType === 'GREEN_ADI' || pageType === 'ADI_STAMP',
    errors,
    warnings,
    isValid: errors.length === 0,
  };
}
```

### 6.4 API Route Implementation

```typescript
// ─── File: src/app/api/v1/students/[id]/logbook-scan/route.ts ───

import { auth } from '@clerk/nextjs/server';
import Anthropic from '@anthropic-ai/sdk';
import { uploadToR2 } from '@/lib/r2';
import { db } from '@/db';
import { logbookScans, logbookEntries } from '@/db/schema';
import { validateLogbookEntry } from '@/services/logbook-scanner.service';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,  // Server-side only
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const studentId = params.id;

  // 1. Verify consent (Australian Privacy Act)
  const student = await db.query.students.findFirst({
    where: eq(students.id, studentId),
    columns: { consentGiven: true },
  });
  if (!student?.consentGiven) {
    return Response.json(
      { error: 'Student has not provided consent for logbook data collection', code: 'CONSENT_REQUIRED' },
      { status: 409 }
    );
  }

  // 2. Parse multipart form
  const formData = await req.formData();
  const imageFile = formData.get('image') as File | null;
  if (!imageFile) return Response.json({ error: 'No image provided' }, { status: 400 });

  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
  if (!ALLOWED_TYPES.includes(imageFile.type)) {
    return Response.json({ error: 'Invalid image type' }, { status: 400 });
  }
  if (imageFile.size > 10 * 1024 * 1024) {
    return Response.json({ error: 'Image exceeds 10MB limit' }, { status: 400 });
  }

  // 3. Upload to R2
  const objectKey = `logbooks/${studentId}/${crypto.randomUUID()}.jpg`;
  const imageBuffer = await imageFile.arrayBuffer();
  await uploadToR2(objectKey, Buffer.from(imageBuffer), imageFile.type);

  // 4. Convert to base64 for Vision API
  const base64Image = Buffer.from(imageBuffer).toString('base64');

  // 5. Call Claude Vision API (server-side)
  const visionResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageFile.type as 'image/jpeg' | 'image/png' | 'image/webp',
            data: base64Image,
          },
        },
        { type: 'text', text: LOGBOOK_EXTRACTION_PROMPT },
      ],
    }],
  });

  // 6. Parse extraction
  const rawText = visionResponse.content[0].type === 'text' ? visionResponse.content[0].text : '';
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return Response.json({ error: 'Could not parse logbook page — is this a valid ACT logbook?' }, { status: 422 });
  }
  const extraction = JSON.parse(jsonMatch[0]);

  // 7. Validate entries
  const validatedEntries = extraction.entries.map((e: any) =>
    validateLogbookEntry(e, extraction.pageType)
  );

  const totalMinutes = validatedEntries
    .filter((e: any) => e.isValid)
    .reduce((sum: number, e: any) => sum + (e.durationMinutes ?? 0), 0);

  // 8. Insert scan record
  const [scan] = await db.insert(logbookScans).values({
    studentId,
    instructorId: authContext.instructorId,
    r2ObjectKey: objectKey,
    r2Bucket: 'nexdrive-uploads',
    fileSizeBytes: imageFile.size,
    mimeType: imageFile.type,
    pageType: extraction.pageType,
    pageNumber: extraction.pageNumber,
    rawExtraction: extraction,
    extractionModel: 'claude-sonnet-4-5',
    pageNotes: extraction.pageNotes,
    entryCount: validatedEntries.length,
    validEntryCount: validatedEntries.filter((e: any) => e.isValid).length,
    errorCount: validatedEntries.flatMap((e: any) => e.errors).length,
    warningCount: validatedEntries.flatMap((e: any) => e.warnings).length,
    totalMinutes,
    status: 'pending',
  }).returning();

  // 9. Insert entry rows
  if (validatedEntries.length > 0) {
    await db.insert(logbookEntries).values(
      validatedEntries.map((e: any) => ({
        logbookScanId: scan.id,
        studentId,
        rowNumber: e.rowNumber,
        entryDate: e.parsedDate,
        weather: e.weather,
        supervisorName: e.supervisorName === 'UNCLEAR' ? null : e.supervisorName,
        licenceNumber: e.licenceNumber === 'UNCLEAR' ? null : e.licenceNumber,
        startTime: e.startTime === 'UNCLEAR' ? null : e.startTime,
        finishTime: e.finishTime === 'UNCLEAR' ? null : e.finishTime,
        durationMinutes: e.durationMinutes,
        hasSignature: e.hasSignature,
        odometerStart: e.odometerStart,
        odometerFinish: e.odometerFinish,
        isNight: e.isNight,
        isAdi: e.isAdi,
        confidence: e.confidence,
        entryNotes: e.notes,
        isValid: e.isValid,
        validationErrors: e.errors,
        validationWarnings: e.warnings,
      }))
    );
  }

  // 10. Audit log
  await writeAuditLog({
    eventType: 'LOGBOOK_SCAN_UPLOADED',
    actorId: authContext.instructorId,
    actorRole: 'instructor',
    subjectType: 'student',
    subjectId: studentId,
    details: { scan_id: scan.id, page_type: extraction.pageType, entry_count: validatedEntries.length },
  });

  return Response.json({
    scan_id: scan.id,
    status: 'pending',
    page_type: extraction.pageType,
    entry_count: validatedEntries.length,
    valid_entry_count: validatedEntries.filter((e: any) => e.isValid).length,
    total_minutes: totalMinutes,
    entries: validatedEntries,
    action_required: 'Instructor must review and confirm or reject this scan.',
  }, { status: 201 });
}
```

---

## 7. P1 Eligibility Engine (NEW in v2.0)

### 7.1 Four-Gate System

All four gates must be passed for P1 eligibility:

```
Gate 1: HOURS         → Total credited hours ≥ threshold (100 for RED, 50 for GREEN)
Gate 2: NIGHT HOURS   → Night hours ≥ threshold (10 for RED, 5 for GREEN)
Gate 3: TENURE        → L-plates held for ≥ months required (12 for RED, 6 for GREEN)
Gate 4: ASSESSMENTS   → CBT&A completed AND HPT completed
```

### 7.2 Hour Credit Calculation

```typescript
// ─── File: src/services/p1-eligibility.service.ts ───────────────

interface HoursBreakdown {
  supervisedDayHours: number;       // From confirmed BLUE_DAY logbook scans
  supervisedNightHours: number;     // From confirmed RED_NIGHT logbook scans
  adiActualHours: number;           // Raw ADI hours from GREEN_ADI/ADI_STAMP scans
  adiCreditedHours: number;         // After 3:1 multiplier for first 10 hours
  saferDriverBonus: number;         // 20 if credit active, else 0
  vruBonus: number;                 // 10 if credit active, else 0
  firstAidBonus: number;            // 5 if credit active, else 0
  totalCredited: number;            // Sum of all credited hours
}

function calculateCreditedHours(student: StudentWithHours): HoursBreakdown {
  // ADI 3:1 credit: first 10 actual hours = 30 credited, beyond that = 1:1
  const adiFirst10 = Math.min(student.adiActualHours, 10) * 3;
  const adiExtra = Math.max(0, student.adiActualHours - 10) * 1;
  const adiCreditedHours = adiFirst10 + adiExtra;

  const saferDriverBonus = student.saferDriverCredit ? 20 : 0;
  const vruBonus = student.vruCredit ? 10 : 0;
  const firstAidBonus = student.firstAidCredit ? 5 : 0;

  const totalCredited =
    student.supervisedDayHours +
    student.supervisedNightHours +
    adiCreditedHours +
    saferDriverBonus +
    vruBonus +
    firstAidBonus;

  return {
    supervisedDayHours: student.supervisedDayHours,
    supervisedNightHours: student.supervisedNightHours,
    adiActualHours: student.adiActualHours,
    adiCreditedHours,
    saferDriverBonus,
    vruBonus,
    firstAidBonus,
    totalCredited,
  };
}
```

### 7.3 Pathway Determination

```typescript
function determinePathway(student: Student): 'P1_RED' | 'P2_GREEN' {
  if (!student.dateOfBirth || !student.licenceIssueDate) return 'P1_RED'; // Default to stricter
  const ageAtIssue = differenceInYears(student.licenceIssueDate, student.dateOfBirth);
  return ageAtIssue < 25 ? 'P1_RED' : 'P2_GREEN';
}

const PATHWAY_REQUIREMENTS = {
  P1_RED: { totalHours: 100, nightHours: 10, tenureMonths: 12 },
  P2_GREEN: { totalHours: 50, nightHours: 5, tenureMonths: 6 },
};
```

### 7.4 Full Eligibility Check

```typescript
async function checkP1Eligibility(studentId: string): Promise<P1EligibilityResult> {
  const student = await getStudentWithHours(studentId);
  const pathway = determinePathway(student);
  const requirements = PATHWAY_REQUIREMENTS[pathway];

  // Gate 1: Hours
  const hours = calculateCreditedHours(student);
  const hoursGate = {
    passed: hours.totalCredited >= requirements.totalHours,
    required: requirements.totalHours,
    current_credited: hours.totalCredited,
    remaining: Math.max(0, requirements.totalHours - hours.totalCredited),
    breakdown: hours,
  };

  // Gate 2: Night hours
  const nightHoursGate = {
    passed: student.supervisedNightHours >= requirements.nightHours,
    required: requirements.nightHours,
    current: student.supervisedNightHours,
    remaining: Math.max(0, requirements.nightHours - student.supervisedNightHours),
  };

  // Gate 3: Tenure
  const today = new Date();
  const earliestEligible = student.tenureStartDate
    ? addMonths(student.tenureStartDate, requirements.tenureMonths)
    : null;
  const tenureGate = {
    passed: earliestEligible ? today >= earliestEligible : false,
    tenure_start_date: student.tenureStartDate?.toISOString().split('T')[0] ?? null,
    months_required: requirements.tenureMonths,
    earliest_eligible_date: earliestEligible?.toISOString().split('T')[0] ?? null,
    days_until_eligible: earliestEligible ? Math.max(0, differenceInDays(earliestEligible, today)) : null,
    currently_met: earliestEligible ? today >= earliestEligible : false,
  };

  // Gate 4: Assessments
  const assessmentsGate = {
    passed: student.cbtaCompleted && student.hptCompleted,
    cbta_completed: student.cbtaCompleted,
    cbta_date: student.cbtaDate?.toISOString().split('T')[0] ?? null,
    hpt_completed: student.hptCompleted,
    hpt_date: student.hptDate?.toISOString().split('T')[0] ?? null,
    missing: [
      ...(!student.cbtaCompleted ? ['cbta'] : []),
      ...(!student.hptCompleted ? ['hpt'] : []),
    ],
  };

  // Overall status (priority: hours > night hours > tenure > assessments)
  const overallEligible = hoursGate.passed && nightHoursGate.passed && tenureGate.passed && assessmentsGate.passed;
  let eligibilityStatus: string;
  if (overallEligible) eligibilityStatus = 'eligible';
  else if (!hoursGate.passed) eligibilityStatus = 'pending_hours';
  else if (!nightHoursGate.passed) eligibilityStatus = 'pending_night_hours';
  else if (!tenureGate.passed) eligibilityStatus = 'pending_tenure';
  else eligibilityStatus = 'pending_assessments';

  // Cache on student record
  await db.update(students).set({
    p1EligibilityStatus: eligibilityStatus,
    p1EligibilityCheckedAt: new Date(),
  }).where(eq(students.id, studentId));

  // Count pending scans
  const pendingScans = await db.select({ count: sql`COUNT(*)` })
    .from(logbookScans)
    .where(and(eq(logbookScans.studentId, studentId), eq(logbookScans.status, 'pending')));

  return {
    student_id: studentId,
    student_name: student.profile.fullName,
    pathway,
    overall_eligible: overallEligible,
    eligibility_status: eligibilityStatus,
    gates: { hours: hoursGate, night_hours: nightHoursGate, tenure: tenureGate, assessments: assessmentsGate },
    credits: {
      safer_driver: student.saferDriverCredit,
      vru: student.vruCredit,
      first_aid: student.firstAidCredit,
    },
    pending_scans: Number(pendingScans[0].count),
    checked_at: new Date().toISOString(),
  };
}
```

### 7.5 Supervised Hours Recalculation

Called whenever a scan is confirmed or rejected:

```typescript
async function recalculateSupervisedHours(studentId: string): Promise<void> {
  // Query only confirmed scans, only valid entries
  const totals = await db
    .select({
      pageType: logbookScans.pageType,
      totalMinutes: sql<number>`SUM(${logbookEntries.durationMinutes})`,
    })
    .from(logbookEntries)
    .innerJoin(logbookScans, eq(logbookEntries.logbookScanId, logbookScans.id))
    .where(
      and(
        eq(logbookEntries.studentId, studentId),
        eq(logbookEntries.isValid, true),
        eq(logbookScans.status, 'confirmed')
      )
    )
    .groupBy(logbookScans.pageType);

  let supervisedDayMinutes = 0;
  let supervisedNightMinutes = 0;
  let adiMinutes = 0;

  for (const row of totals) {
    if (row.pageType === 'BLUE_DAY') supervisedDayMinutes = row.totalMinutes;
    else if (row.pageType === 'RED_NIGHT') supervisedNightMinutes = row.totalMinutes;
    else if (row.pageType === 'GREEN_ADI' || row.pageType === 'ADI_STAMP') adiMinutes += row.totalMinutes;
  }

  await db.update(students).set({
    supervisedDayHours: (supervisedDayMinutes / 60).toFixed(2),
    supervisedNightHours: (supervisedNightMinutes / 60).toFixed(2),
    adiActualHours: (adiMinutes / 60).toFixed(2),
  }).where(eq(students.id, studentId));
}
```

---

## 8. Event Integration

### 8.1 Events Emitted

| Event | Trigger | Data |
|-------|---------|------|
| `COMPETENCY_ACHIEVED` | Status → `competent` | `{ student_id, task_number, task_name, transmission }` |
| `CERTIFICATE_ISSUED` | Certificate PDF generated | `{ student_id, certificate_number }` |
| `LOGBOOK_SCAN_UPLOADED` | New scan created | `{ student_id, scan_id, page_type }` |
| `LOGBOOK_SCAN_CONFIRMED` | Scan confirmed | `{ student_id, scan_id, hours_added }` |
| `LOGBOOK_SCAN_REJECTED` | Scan rejected | `{ student_id, scan_id, reason }` |
| `P1_ELIGIBILITY_ACHIEVED` | All four gates pass | `{ student_id }` |

### 8.2 Events Consumed

| Event | Handler |
|-------|---------|
| `LESSON_COMPLETED` | → `processLessonCompetencies()` |
| `COMPETENCY_ACHIEVED` | → Check certificate eligibility |
| `LOGBOOK_SCAN_CONFIRMED` | → `recalculateSupervisedHours()` → `checkP1Eligibility()` |

### 8.3 Notification Templates (SPEC-07)

**`logbook_scan_review_required` (push/in-app to Instructor):**
- "Jane Smith uploaded a new logbook page (Day, 9 hrs). Please review."

**`logbook_scan_confirmed` (Email to Student):**
- "Your logbook page has been verified. Total logged hours: 45.5 day + 8.0 night."

**`p1_eligibility_achieved` (Email + SMS to Student):**
- "🎉 You've met all requirements for your P1 licence application!"

---

## 9. Transmission Tracking

Each `student_competencies` row specifies `transmission`. A student can achieve the same task in both transmissions. Certificate eligibility checks only competencies matching `students.transmission`.

The `lessons` table has separate arrays: `competencies_achieved_manual INTEGER[]` and `competencies_achieved_auto INTEGER[]`.

If a student changes their enrolled transmission, existing competency records remain. Certificate eligibility recalculates against the new transmission. Some tasks may need re-achievement in the new transmission. Changes logged in `audit_log` with `TRANSMISSION_CHANGED`.

---

## 10. Append-Only Compliance

**Rules:**
1. No UPDATE or DELETE on `student_competencies` or `logbook_entries`
2. `logbook_scans.status` is mutable (pending → confirmed/rejected) — this is workflow state
3. Hash chain links `student_competencies` records per-student
4. Current competency status = latest row per student+task+transmission (ORDER BY `created_at DESC`)
5. Corrections via new records only

**Hash Chain Verification:**
```typescript
async function verifyHashChain(studentId: string): Promise<HashChainVerifyResult> {
  const records = await db.query.studentCompetencies.findMany({
    where: eq(studentCompetencies.studentId, studentId),
    orderBy: asc(studentCompetencies.createdAt),
  });

  let previousHash: string | null = null;
  for (const record of records) {
    if (record.previousHash !== previousHash) {
      return { valid: false, total_records: records.length, first_broken_record_id: record.id };
    }
    const computedHash = computeSha256(
      record.studentId + record.taskId + record.instructorId +
      record.status + record.transmission +
      record.statusChangedAt.toISOString() +
      (record.previousHash ?? 'GENESIS')
    );
    if (record.recordHash !== computedHash) {
      return { valid: false, total_records: records.length, first_broken_record_id: record.id };
    }
    previousHash = record.recordHash;
  }
  return { valid: true, total_records: records.length };
}
```

---

## 11. File Structure

```
src/
├── app/api/v1/
│   ├── competency-tasks/
│   │   └── route.ts                         # GET all 23 tasks
│   └── students/
│       └── [id]/
│           ├── competencies/
│           │   └── route.ts                 # GET + POST
│           ├── certificate-eligibility/
│           │   └── route.ts                 # GET
│           ├── certificate/
│           │   └── route.ts                 # POST
│           ├── logbook-scan/
│           │   └── route.ts                 # POST (upload + Claude Vision)
│           ├── logbook-scans/
│           │   ├── route.ts                 # GET (list)
│           │   └── [scanId]/
│           │       └── route.ts             # PATCH (confirm/reject)
│           └── p1-eligibility/
│               └── route.ts                 # GET
├── services/
│   ├── competency.service.ts                # CBT&A business logic
│   ├── certificate.service.ts               # PDF generation + R2
│   ├── logbook-scanner.service.ts           # Claude Vision + validation
│   └── p1-eligibility.service.ts            # Four-gate P1 engine
├── lib/
│   ├── hash.ts                              # SHA-256 utility
│   ├── events.ts                            # Event bus
│   └── r2.ts                               # R2 upload/signed URL
└── templates/
    └── certificate.html                     # Form 165751 HTML template
```

---

## 12. TypeScript Types

```typescript
// ─── File: src/types/competency.types.ts ────────────────────────

export type CompetencyStatus = 'not_started' | 'taught' | 'assessed' | 'competent' | 'not_yet_competent';
export type Transmission = 'manual' | 'auto';
export type LogbookPageType = 'BLUE_DAY' | 'RED_NIGHT' | 'GREEN_ADI' | 'ADI_STAMP';
export type P1Pathway = 'P1_RED' | 'P2_GREEN';
export type P1EligibilityStatus = 'eligible' | 'pending_hours' | 'pending_night_hours' | 'pending_tenure' | 'pending_assessments' | 'not_eligible';
export type LogbookScanStatus = 'pending' | 'confirmed' | 'rejected';

export interface P1EligibilityResult {
  student_id: string;
  student_name: string;
  pathway: P1Pathway;
  pathway_description: string;
  overall_eligible: boolean;
  eligibility_status: P1EligibilityStatus;
  gates: {
    hours: HoursGate;
    night_hours: NightHoursGate;
    tenure: TenureGate;
    assessments: AssessmentsGate;
  };
  credits: {
    safer_driver: boolean;
    vru: boolean;
    first_aid: boolean;
  };
  pending_scans: number;
  checked_at: string;
}

export interface HoursGate {
  passed: boolean;
  required: number;
  current_credited: number;
  remaining: number;
  breakdown: HoursBreakdown;
  credit_note: string;
}

export interface HoursBreakdown {
  supervised_day_hours: number;
  supervised_night_hours: number;
  adi_actual_hours: number;
  adi_credited_hours: number;
  safer_driver_bonus: number;
  vru_bonus: number;
  first_aid_bonus: number;
  total_credited: number;
}

export interface LogbookScanResult {
  scan_id: string;
  status: LogbookScanStatus;
  page_type: LogbookPageType;
  page_number: number | null;
  entry_count: number;
  valid_entry_count: number;
  error_count: number;
  warning_count: number;
  total_minutes: number;
  total_hours: number;
  entries: ValidatedLogbookEntry[];
  errors: ValidationError[];
  warnings: ValidationWarning[];
  page_notes: string | null;
  image_url: string;
  action_required: string;
}
```

---

## 13. Seed Data Script

```typescript
// ─── File: src/db/seed-competency-tasks.ts ──────────────────────

const TASKS = [
  { taskNumber: 1,  name: 'Pre-Drive Procedure', category: 'Basic Control', prerequisites: [], sortOrder: 1,
    description: 'Starting, adjusting and shutting down the car; seatbelt, mirrors, head restraint, gear selection' },
  { taskNumber: 2,  name: 'Controls and Instruments', category: 'Basic Control', prerequisites: [1], sortOrder: 2,
    description: 'Understanding all vehicle controls, gauges and instruments' },
  { taskNumber: 3,  name: 'Moving Off and Stopping', category: 'Basic Control', prerequisites: [1,2], sortOrder: 3,
    description: 'Smooth take-off from kerb and stop; clutch/brake coordination' },
  { taskNumber: 4,  name: 'Steering', category: 'Basic Control', prerequisites: [3], sortOrder: 4,
    description: 'Hand-over-hand, push-pull steering; maintaining lane position' },
  { taskNumber: 5,  name: 'Gear Changing', category: 'Basic Control', prerequisites: [3], sortOrder: 5,
    description: 'Smooth up/down gear changes; selecting appropriate gear for speed and road conditions' },
  { taskNumber: 6,  name: 'Low Speed Manoeuvres', category: 'Basic Control', prerequisites: [3,4,5], sortOrder: 6,
    description: 'U-turns, 3-point turns, reversing, parking (parallel, angle, 90°)' },
  { taskNumber: 7,  name: 'Intersections — Give Way/Stop', category: 'Traffic', prerequisites: [3,4,5], sortOrder: 7,
    description: 'Approaching and negotiating give way and stop sign intersections' },
  { taskNumber: 8,  name: 'Intersections — Traffic Lights', category: 'Traffic', prerequisites: [7], sortOrder: 8,
    description: 'Green, amber, red, arrows; turning at traffic lights' },
  { taskNumber: 9,  name: 'Intersections — Roundabouts', category: 'Traffic', prerequisites: [7], sortOrder: 9,
    description: 'Single and multi-lane roundabouts; signalling; lane selection' },
  { taskNumber: 10, name: 'Lane Changing and Overtaking', category: 'Traffic', prerequisites: [4,7], sortOrder: 10,
    description: 'Safe lane changes; mirror checks; overtaking procedures' },
  { taskNumber: 11, name: 'Speed Management', category: 'Traffic', prerequisites: [3,5], sortOrder: 11,
    description: 'Matching speed to conditions; speed zones; school zones' },
  { taskNumber: 12, name: 'Gap Selection', category: 'Traffic', prerequisites: [7,10], sortOrder: 12,
    description: 'Judging safe gaps in traffic for turning and merging' },
  { taskNumber: 13, name: 'Following Distance', category: 'Traffic', prerequisites: [11], sortOrder: 13,
    description: '3-second rule; adjusting for conditions' },
  { taskNumber: 14, name: 'Hazard Perception', category: 'Complex', prerequisites: [7,11,13], sortOrder: 14,
    description: 'Identifying and responding to potential hazards; scanning; prediction' },
  { taskNumber: 15, name: 'Sharing the Road', category: 'Complex', prerequisites: [10,14], sortOrder: 15,
    description: 'Vulnerable road users: cyclists, pedestrians, motorcyclists, heavy vehicles' },
  { taskNumber: 16, name: 'Night Driving', category: 'Complex', prerequisites: [14], sortOrder: 16,
    description: 'High/low beam; reduced visibility; adjusting to darkness' },
  { taskNumber: 17, name: 'Review Assessment — Tasks 1-17', category: 'Review',
    prerequisites: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
    isReview: true, reviewRequiresTasks: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], sortOrder: 17,
    description: 'Formal review of competencies 1-17' },
  { taskNumber: 18, name: 'Driving in Traffic', category: 'Advanced', prerequisites: [10,12,14], sortOrder: 18,
    description: 'Higher traffic volumes; multi-lane roads; managing complex traffic environments' },
  { taskNumber: 19, name: 'Freeway / Highway Driving', category: 'Advanced', prerequisites: [10,11,18], sortOrder: 19,
    description: 'Merging, exiting, maintaining speed on high-speed roads' },
  { taskNumber: 20, name: 'Rural / Country Roads', category: 'Advanced', prerequisites: [11,14], sortOrder: 20,
    description: 'Unsealed roads, single-lane bridges, livestock, fatigue management' },
  { taskNumber: 21, name: 'Adverse Conditions', category: 'Advanced', prerequisites: [14,16], sortOrder: 21,
    description: 'Rain, fog, sun glare; adjusting driving for conditions' },
  { taskNumber: 22, name: 'Review Assessment — Tasks 18-22', category: 'Review',
    prerequisites: [17,18,19,20,21],
    isReview: true, reviewRequiresTasks: [18,19,20,21], sortOrder: 22,
    description: 'Formal review of competencies 18-22' },
  { taskNumber: 23, name: 'Final Drive Assessment', category: 'Final',
    prerequisites: [17,22],
    isFinalDrive: true, finalDriveMinMinutes: 45, finalDriveUnfamiliarRoads: true, sortOrder: 23,
    description: 'Comprehensive final assessment; minimum 45 minutes; unfamiliar roads required' },
];

export async function seedCompetencyTasks() {
  await db.insert(competencyTasks).values(
    TASKS.map(t => ({
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
}
```

---

## 14. RBAC Summary

| Endpoint | Admin | Instructor | Student | Parent |
|----------|-------|-----------|---------|--------|
| GET /competency-tasks | ✅ | ✅ | ✅ | ✅ |
| GET /students/:id/competencies | All | Own students | Own only | Linked (if permitted) |
| POST /students/:id/competencies | ✅ | Own students | ❌ | ❌ |
| GET /students/:id/certificate-eligibility | ✅ | Own students | ❌ | ❌ |
| POST /students/:id/certificate | ✅ | Own students | ❌ | ❌ |
| POST /students/:id/logbook-scan | ✅ | Own students | Own (if enabled) | ❌ |
| GET /students/:id/logbook-scans | ✅ | Own students | Own | ❌ |
| PATCH /students/:id/logbook-scans/:id | ✅ | Own students | ❌ | ❌ |
| GET /students/:id/p1-eligibility | ✅ | Own students | Own | ❌ |

---

## 15. Testing Strategy

### Unit Tests

**Prerequisite Logic:** Task with no prerequisites → `can_assess: true`. Unmet prerequisites → correct `blocked_by`. Cannot mark `competent` with unmet prerequisites (409). CAN mark `taught` with unmet prerequisites (opportunistic teaching).

**Review Gating:** Review 1 fails if any Task 1-16 not competent. Tasks 18-21 cannot be assessed until Review 1 passed. Review 2 fails if Task 17 not competent or any Task 18-21 not competent. Final Drive (Task 23) requires both reviews.

**Certificate Eligibility:** Missing tasks returns correct list. Insufficient hours returns hours info. All 23 competent + hours met → `eligible: true`. Already issued → `certificate_already_issued: true`.

**Logbook Scanner Validation:** Session < 5 min → error. Session > 2 hours → warning. Finish before start → overnight detection. Recorded total vs calculated total > 5 min → error. Odometer finish < start → error. High average speed → warning.

**P1 Eligibility:** Correct pathway determination (under/over 25). ADI credit calculation (3:1 for first 10, then 1:1). Safer Drivers/VRU/First Aid bonuses apply correctly. All four gates evaluated independently. Status priority order: hours → night → tenure → assessments.

**Append-Only:** Every status change creates exactly one new row. Hash chain links correctly. `GENESIS` used for first record per student.

### Integration Tests

Full student journey: Task 1 → Task 23 → Certificate. Lesson save → competency rows → `COMPETENCY_ACHIEVED` event → notification. Logbook upload → Claude Vision mock → scan + entries created. Scan confirm → hours recalculated → P1 eligibility recalculated. Certificate generation: PDF in R2, student record updated, `CERTIFICATE_ISSUED` event. Hash chain integrity after 50+ records.

### Security Tests

`ANTHROPIC_API_KEY` must not appear in any client-side bundle (check with `next build`). Logbook images must only be accessible via signed R2 URLs. Student A cannot upload/confirm scans for Student B. Parent cannot view logbook scans. Unconfirmed (pending/rejected) scans must not contribute to hour totals.

### Load Tests

100 students × 23 tasks × avg 3 status changes = 6,900 rows → competency query < 50ms. Claude Vision API timeout handling (30s timeout, graceful error, R2 image retained). Certificate generation under load → queued gracefully.

---

## 16. Implementation Checklist

### Phase A: Core CBT&A API (3-4 days)
- [ ] Create Drizzle schema for `competency_tasks` and `student_competencies`
- [ ] Create DB trigger: `compute_competency_hash()` for hash chain
- [ ] Run seed script for 23 competency tasks
- [ ] Implement `competency.service.ts` — all core functions
- [ ] Implement `GET /api/v1/competency-tasks`
- [ ] Implement `GET /api/v1/students/:id/competencies`
- [ ] Implement `POST /api/v1/students/:id/competencies`
- [ ] Implement prerequisite checking and `can_assess` / `blocked_by` logic
- [ ] Implement review eligibility checks (Review 1, Review 2, Final Drive)
- [ ] Unit tests for all prerequisite/gating rules

### Phase B: Certificate Engine (3-4 days)
- [ ] Implement `GET /api/v1/students/:id/certificate-eligibility`
- [ ] Design Certificate HTML template (Form 165751 layout)
- [ ] Implement PDF generation (Puppeteer or `@react-pdf/renderer`)
- [ ] Implement certificate number sequence (CERT-YYYY-NNNN)
- [ ] Implement R2 upload for certificate PDFs (signed URL generation)
- [ ] Implement `POST /api/v1/students/:id/certificate`
- [ ] Update student record on certificate issuance
- [ ] Unit + integration tests for certificate flow

### Phase C: Logbook Scanner (3-4 days)
- [ ] Apply SPEC-01 amendment: students table new columns (§3.8)
- [ ] Create Drizzle schema for `logbook_scans`, `logbook_entries`, `cbta_documents`
- [ ] Implement R2 image upload for logbook pages
- [ ] Implement Claude Vision extraction prompt and API call (server-side only)
- [ ] Implement `validateLogbookEntry()` with all validation rules
- [ ] Implement `POST /api/v1/students/:id/logbook-scan`
- [ ] Implement `PATCH /api/v1/students/:id/logbook-scans/:scanId` (confirm/reject)
- [ ] Implement `GET /api/v1/students/:id/logbook-scans`
- [ ] Implement `recalculateSupervisedHours()` called on confirm/reject
- [ ] Security test: verify `ANTHROPIC_API_KEY` never in client bundle
- [ ] Consent gate: 409 if student has not given consent
- [ ] Unit tests for validation logic (all edge cases)

### Phase D: P1 Eligibility Engine (2-3 days)
- [ ] Implement `determinePathway()` with date-of-birth + licence-issue-date
- [ ] Implement `calculateCreditedHours()` with ADI 3:1 credit and course bonuses
- [ ] Implement `checkP1Eligibility()` four-gate evaluation
- [ ] Implement `GET /api/v1/students/:id/p1-eligibility`
- [ ] Cache eligibility status on student record
- [ ] Unit tests for pathway determination and hour credit calculations
- [ ] Integration test: scan confirm → hours recalc → eligibility recalc

### Phase E: Event Integration (2 days)
- [ ] Wire `COMPETENCY_ACHIEVED` emission in `recordCompetencyChange()`
- [ ] Wire `CERTIFICATE_ISSUED` emission in `generateCertificate()`
- [ ] Wire `LOGBOOK_SCAN_CONFIRMED` / `REJECTED` emissions in scan review
- [ ] Register `LESSON_COMPLETED` handler → `processLessonCompetencies()`
- [ ] Register `LOGBOOK_SCAN_CONFIRMED` handler → hours recalc → P1 check
- [ ] Register notification templates in SPEC-07
- [ ] End-to-end test: lesson save → competency rows → event → notification

### Phase F: Analytics & Polish (2 days)
- [ ] Implement progress analytics (projected completion, overdue flag)
- [ ] Implement hash chain verification function
- [ ] RBAC tests for all four roles across all endpoints
- [ ] Load test with 100-student dataset
- [ ] OpenAPI annotations on all endpoints

---

## 17. Dependencies

| Dependency | Purpose | Notes |
|-----------|---------|-------|
| SPEC-01 | Database schema | Tables must exist before API. **SPEC-01 v1.2 amendment required for §3.8 students additions.** |
| SPEC-02 | Auth & RBAC | Clerk middleware + role extraction |
| SPEC-07 | Notification Engine | New templates: `logbook_scan_review_required`, `logbook_scan_confirmed`, `p1_eligibility_achieved` |
| SPEC-12 | E-Signature | `signature_id` references on student_competencies |
| C11 (Instructor Workstation) | Lesson recording calls `processLessonCompetencies()` | C12 provides the API, C11 consumes it |
| `@anthropic-ai/sdk` | Claude Vision for logbook scanning | Server-side only — never in client bundle |
| Puppeteer or `@react-pdf/renderer` | Certificate PDF generation | HTML template approach recommended |
| Cloudflare R2 SDK | Logbook image + certificate storage | Sydney region; signed URLs 7-day expiry |
| `date-fns` | Date arithmetic (tenure calculation, pathway determination) | Already in stack |

---

## 18. Open Questions for Rob

1. **Minimum professional hours for CBT&A certificate:** Currently set to 20 hours (Rob's professional lessons). Is this the correct ACT threshold?
2. **Certificate serial number format:** Using `CERT-YYYY-NNNN`. Does the ACT require a specific format, or is there an external serial number allocation system?
3. **Prerequisite override:** Should Rob (as sole instructor) have admin-level ability to override prerequisites, or require a separate admin role?
4. **NYC re-assessment cool-down:** Should there be a minimum time/lessons between a NYC marking and re-assessment?
5. **Certificate PDF branding:** NexDrive logo + ACT Government reference, or pixel-perfect mirror of the ACT Government carbonless form?
6. **ACT total hours requirement (P1_RED):** APEX system uses **100 hours** for under-25 pathway. Open sources suggest 120 hours. Rob to confirm the current ACT requirement — this directly affects the `PATHWAY_REQUIREMENTS` constant.
7. **ADI credit calculation:** APEX uses 3:1 for first 10 actual ADI hours, then 1:1 beyond. Rob to confirm this is the current ACT rule before hardcoding.
8. **HPT recording workflow:** Will HPT completion be entered manually by Rob after the student tells him, or is there an API integration with the ACT Government to verify HPT results directly?
9. **Logbook scanner override:** If Claude Vision misidentifies a page type (e.g., classifies BLUE_DAY as RED_NIGHT), should Rob be able to override the page type after scanning, or must the student rescan?
10. **Student logbook upload:** Should students be allowed to upload their own logbook pages directly (which then await instructor confirmation), or is logbook scanning instructor-only?

---

*End of SPEC-13: CBT&A Compliance Engine v2.0*
