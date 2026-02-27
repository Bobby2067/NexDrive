# SPEC-13: CBT&A Compliance Engine (C12)
### NexDrive Academy — Phase 3 Digitise Paperwork
**Version:** 1.0  
**Date:** 21 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.5, §5.2; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-07 (Notification Engine); SPEC-12 (E-Signature)  
**Phase:** 3 (Digitise Paperwork — Weeks 13-20)  
**Estimated Effort:** 10-12 days  

---

## 1. Overview

The CBT&A Compliance Engine encodes the ACT Government's Competency Based Training & Assessment framework into software. It tracks student progression through 23 mandatory competency tasks, enforces prerequisite gating, manages review assessments, validates Final Drive eligibility, and generates the Certificate of Competency (Form 165751) when all requirements are met.

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **Append-only compliance.** The `student_competencies` table has NO `updated_at` column. Every status change creates a new row. No updates, no deletes. Hash chain provides tamper evidence.
2. **Prerequisites are enforced for assessment, not teaching.** Instructors can _teach_ any task opportunistically, but cannot mark a task as _competent_ until all prerequisites are competent.
3. **Review 1 (Task 17) gates advanced tasks.** Tasks 18-22 cannot be assessed until Review 1 is passed.
4. **Review 2 (Task 22) gates Final Drive.** Task 23 cannot be attempted until Review 2 is passed.
5. **Final Drive has hard requirements.** Minimum 45 minutes, unfamiliar roads, all 22 prior tasks competent.
6. **Transmission tracked separately.** Manual and auto achievements are independent. Certificate eligibility checks only competencies matching the student's enrolled transmission.
7. **Multi-instructor from day one.** Every query scopes by `instructor_id`.
8. **Private notes NEVER visible to students or parents.** Defence in depth — excluded from all student/parent response shapes.
9. **Hash chain integrity.** SHA-256 hash of each record links to previous record. `GENESIS` for first record per student.
10. **Event-driven side effects.** Competency changes emit `COMPETENCY_ACHIEVED` events; notification/certificate listeners handle downstream effects.

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

**Seed data:** See §2.1 for all 23 tasks. Seed script in SPEC-01 §6.

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

### 3.4 Related Tables (Read from, Not Owned)

- **`students`** — `transmission`, `professional_hours`, `certificate_issued_at`, `certificate_number`, `completion_date`, `status`
- **`lessons`** — `competencies_taught`, `competencies_assessed`, `competencies_achieved_manual`, `competencies_achieved_auto`, `total_minutes`, `start_time`, `end_time`
- **`signatures`** — Referenced by `student_competencies.signature_id`
- **`audit_log`** — Append competency events here

---

## 4. API Endpoints

### 4.1 GET /api/v1/competency-tasks

**Purpose:** Return all 23 ACT CBT&A tasks with prerequisites and metadata.  
**Auth:** 🔑 Any authenticated user (student, parent, instructor, admin)  
**Rate Limit:** 60/min  

**Response:**
```json
{
  "tasks": [
    {
      "id": "uuid",
      "task_number": 1,
      "name": "Pre-Drive Procedure",
      "description": "Starting, adjusting and shutting down the car...",
      "category": "Basic Control",
      "prerequisites": [],
      "is_review": false,
      "is_final_drive": false,
      "review_requires_tasks": [],
      "final_drive_min_minutes": null,
      "final_drive_unfamiliar_roads": false,
      "sort_order": 1
    }
  ]
}
```

**Implementation:**

```typescript
// src/app/api/v1/competency-tasks/route.ts
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { competencyTasks } from '@/db/schema';
import { asc } from 'drizzle-orm';

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

**Caching:** This is reference data that rarely changes. Cache in memory or Redis with 1-hour TTL. Invalidate on admin update.

---

### 4.2 GET /api/v1/students/:id/competencies

**Purpose:** Full competency matrix for a student — current status per task with `can_assess` and `blocked_by` flags.  
**Auth:** 🔑 Instructor (own students), Student (own), Parent (linked, if `parent_visibility = true`), Admin (all)  
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
    },
    {
      "task_number": 10,
      "task_name": "Lane Changing and Overtaking",
      "category": "Traffic",
      "status": "taught",
      "transmission": "auto",
      "taught_at": "2025-07-10T10:30:00Z",
      "assessed_at": null,
      "achieved_at": null,
      "lesson_id": "uuid",
      "can_assess": false,
      "blocked_by": [7],
      "is_review": false,
      "is_final_drive": false,
      "history_count": 1
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

**Implementation Notes:**

The core query fetches the _latest_ status for each task. Use a lateral join or `DISTINCT ON`:

```sql
-- Get current (latest) status per task per student
SELECT DISTINCT ON (sc.task_id)
  sc.*, ct.task_number, ct.name, ct.category, ct.prerequisites,
  ct.is_review, ct.is_final_drive
FROM student_competencies sc
JOIN competency_tasks ct ON sc.task_id = ct.id
WHERE sc.student_id = $1 AND sc.transmission = $2
ORDER BY sc.task_id, sc.created_at DESC;
```

For tasks with no `student_competencies` rows, the status is `not_started`. Left join all active `competency_tasks` against the latest status subquery.

**`can_assess` computation (per task):**

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
    if (prereqStatus !== 'competent') {
      blocked_by.push(prereqNumber);
    }
  }

  return { can_assess: blocked_by.length === 0, blocked_by };
}
```

**Timestamps extraction:** Walk the student's competency history for each task to find first occurrence of `taught`, `assessed`, `competent` timestamps:

```typescript
function extractTimestamps(history: StudentCompetency[]): {
  taught_at: string | null;
  assessed_at: string | null;
  achieved_at: string | null;
} {
  const taught = history.find(h => h.status === 'taught');
  const assessed = history.find(h => h.status === 'assessed');
  const achieved = history.find(h => h.status === 'competent');
  return {
    taught_at: taught?.status_changed_at ?? null,
    assessed_at: assessed?.status_changed_at ?? null,
    achieved_at: achieved?.status_changed_at ?? null,
  };
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

// Student: only own competencies
if (authContext.role === 'student') {
  if (studentId !== authContext.student_id) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
}

// Parent: only linked student with parent_visibility = true
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

1. **`status` must be valid:** One of `taught`, `assessed`, `competent`, `not_yet_competent`
2. **`transmission` must match lesson or student:** `manual` or `auto`
3. **`lesson_id` should reference a valid lesson** for this student (optional for admin overrides)
4. **Status transition must be valid:** Cannot go from `not_started` to `not_yet_competent` directly
5. **Prerequisites enforced for `competent` and `assessed`:**
   - If `status` is `competent` or `assessed`, all prerequisites must be `competent`
   - If `status` is `taught`, prerequisites are NOT enforced (opportunistic teaching)
6. **Review gating enforced:** Cannot set Tasks 18-22 to `competent` unless Task 17 is `competent`
7. **Final Drive gating:** Cannot set Task 23 to `competent` unless Task 22 is `competent`
8. **Instructor owns the student:** Verified via instructor_id check

**Response (201 Created):**
```json
{
  "id": "uuid",
  "student_id": "uuid",
  "task_number": 5,
  "task_name": "Gear Changing",
  "status": "competent",
  "transmission": "auto",
  "record_hash": "sha256hex...",
  "created_at": "2025-07-10T10:30:00Z"
}
```

**Error Responses:**

| Code | Condition |
|------|-----------|
| 400 | Invalid status value or transition |
| 403 | Instructor doesn't own this student |
| 409 | Prerequisites not met (returns `blocked_by` array) |
| 422 | Task number not found |

**409 Response Format:**
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

**Implementation:**

```typescript
// Core service function
async function recordCompetencyChange(params: {
  studentId: string;
  taskNumber: number;
  status: CompetencyStatus;
  transmission: 'manual' | 'auto';
  lessonId?: string;
  signatureId?: string;
  instructorId: string;
}): Promise<StudentCompetency> {
  // 1. Look up task by task_number
  const task = await db.query.competencyTasks.findFirst({
    where: eq(competencyTasks.taskNumber, params.taskNumber),
  });
  if (!task) throw new AppError(422, 'TASK_NOT_FOUND');

  // 2. Verify instructor owns student
  const student = await db.query.students.findFirst({
    where: eq(students.id, params.studentId),
  });
  if (student.instructorId !== params.instructorId) {
    throw new AppError(403, 'FORBIDDEN');
  }

  // 3. Check prerequisites (only for 'assessed' and 'competent')
  if (['assessed', 'competent'].includes(params.status)) {
    const { can_assess, blocked_by } = await canAssessTask(
      params.studentId, params.taskNumber, params.transmission
    );
    if (!can_assess) {
      throw new AppError(409, 'PREREQUISITES_NOT_MET', { blocked_by });
    }
  }

  // 4. Insert new row (hash chain computed by DB trigger)
  const [record] = await db.insert(studentCompetencies).values({
    studentId: params.studentId,
    taskId: task.id,
    instructorId: params.instructorId,
    status: params.status,
    transmission: params.transmission,
    lessonId: params.lessonId ?? null,
    signatureId: params.signatureId ?? null,
    signedByInstructor: !!params.signatureId,
    signedByStudent: !!params.signatureId,
  }).returning();

  // 5. Write to audit_log
  await writeAuditLog({
    eventType: `COMPETENCY_${params.status.toUpperCase()}`,
    actorId: params.instructorId,
    actorRole: 'instructor',
    subjectType: 'student',
    subjectId: params.studentId,
    details: {
      task_number: params.taskNumber,
      task_name: task.name,
      status: params.status,
      transmission: params.transmission,
      lesson_id: params.lessonId,
      student_competency_id: record.id,
    },
  });

  // 6. Emit event if status is 'competent'
  if (params.status === 'competent') {
    await eventBus.emit({
      type: 'COMPETENCY_ACHIEVED',
      data: {
        student_id: params.studentId,
        student_name: student.profile?.fullName,
        task_number: params.taskNumber,
        task_name: task.name,
        transmission: params.transmission,
        student_competency_id: record.id,
      },
    });
  }

  return record;
}
```

---

### 4.4 GET /api/v1/students/:id/certificate-eligibility

**Purpose:** Check whether a student has met all requirements for the Certificate of Competency.  
**Auth:** 🎓 Instructor (own students), Admin  
**Rate Limit:** 30/min  

**Response (eligible):**
```json
{
  "eligible": true,
  "student_id": "uuid",
  "student_name": "Jane Smith",
  "transmission": "auto",
  "total_tasks": 23,
  "competent_tasks": 23,
  "missing_tasks": [],
  "review_1_passed": true,
  "review_2_passed": true,
  "final_drive_passed": true,
  "professional_hours": 22.5,
  "minimum_hours_met": true,
  "minimum_hours_required": 20,
  "certificate_already_issued": false
}
```

**Response (not eligible):**
```json
{
  "eligible": false,
  "student_id": "uuid",
  "student_name": "Jane Smith",
  "transmission": "auto",
  "total_tasks": 23,
  "competent_tasks": 19,
  "missing_tasks": [
    { "task_number": 20, "name": "Rural / Country Roads", "status": "taught" },
    { "task_number": 21, "name": "Adverse Conditions", "status": "not_started" },
    { "task_number": 22, "name": "Review Assessment — Tasks 18-22", "status": "not_started" },
    { "task_number": 23, "name": "Final Drive Assessment", "status": "not_started" }
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

**Implementation:**

```typescript
async function checkCertificateEligibility(
  studentId: string,
  transmission?: 'manual' | 'auto'
): Promise<CertificateEligibility> {
  const student = await getStudentWithProfile(studentId);
  const tx = transmission ?? student.transmission;
  const MINIMUM_PROFESSIONAL_HOURS = 20; // Configurable

  // 1. Get current status for all 23 tasks in student's transmission
  const statuses = await getCurrentCompetencyStatuses(studentId, tx);

  // 2. Check which tasks are competent
  const allTasks = await getAllActiveTasks();
  const missing: MissingTask[] = [];
  let competentCount = 0;

  for (const task of allTasks) {
    const status = statuses.get(task.taskNumber) ?? 'not_started';
    if (status === 'competent') {
      competentCount++;
    } else {
      missing.push({
        task_number: task.taskNumber,
        name: task.name,
        status,
      });
    }
  }

  // 3. Specific checks
  const review1Passed = (statuses.get(17) ?? 'not_started') === 'competent';
  const review2Passed = (statuses.get(22) ?? 'not_started') === 'competent';
  const finalDrivePassed = (statuses.get(23) ?? 'not_started') === 'competent';
  const hoursOk = Number(student.professionalHours) >= MINIMUM_PROFESSIONAL_HOURS;

  const eligible = missing.length === 0 && hoursOk;

  return {
    eligible,
    student_id: studentId,
    student_name: student.profile.fullName,
    transmission: tx,
    total_tasks: allTasks.length,
    competent_tasks: competentCount,
    missing_tasks: missing,
    review_1_passed: review1Passed,
    review_2_passed: review2Passed,
    final_drive_passed: finalDrivePassed,
    professional_hours: Number(student.professionalHours),
    minimum_hours_met: hoursOk,
    minimum_hours_required: MINIMUM_PROFESSIONAL_HOURS,
    certificate_already_issued: !!student.certificateIssuedAt,
  };
}
```

**Minimum Professional Hours:** Configurable, defaults to 20 hours. The 3:1 credit rule (first 10 professional hours count as 30 logbook hours) is a _display calculation_ for the student portal — it does not affect certificate eligibility, which uses raw professional hours only.

---

### 4.5 POST /api/v1/students/:id/certificate

**Purpose:** Generate the Certificate of Competency (Form 165751) PDF and update student records.  
**Auth:** 🎓👑 Instructor (own students) + Admin approval  
**Rate Limit:** 5/min (expensive PDF generation)  

**Request Body:**
```json
{
  "confirm": true,
  "unfamiliar_roads_confirmed": true,
  "notes": "Outstanding student, achieved all competencies efficiently."
}
```

**Pre-conditions (all must be true):**
1. Certificate eligibility check passes (all 23 competent, hours met)
2. No existing certificate issued (`certificate_issued_at IS NULL`)
3. `confirm: true` in request body (prevents accidental generation)
4. Final Drive lesson has `total_minutes >= 45`

**Response (201 Created):**
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

**Certificate Number Format:** `CERT-YYYY-NNNN` where NNNN is a zero-padded sequential number per year. Stored in `students.certificate_number`. Generated using a database sequence or counter table to prevent conflicts.

**PDF Generation:**

The certificate PDF matches the ACT Government Form 165751 (Certificate of Competency) layout:

```typescript
async function generateCertificatePDF(
  studentId: string,
  instructorId: string
): Promise<{ certificateNumber: string; pdfUrl: string }> {
  // 1. Verify eligibility (throws if not eligible)
  const eligibility = await checkCertificateEligibility(studentId);
  if (!eligibility.eligible) throw new AppError(409, 'NOT_ELIGIBLE');

  // 2. Check not already issued
  const student = await getStudentWithProfile(studentId);
  if (student.certificateIssuedAt) throw new AppError(409, 'ALREADY_ISSUED');

  // 3. Get instructor details
  const instructor = await getInstructorWithProfile(instructorId);

  // 4. Get all competency records with achievement dates
  const competencies = await getCompetencyAchievements(studentId, student.transmission);

  // 5. Generate certificate number
  const certNumber = await generateCertificateNumber();

  // 6. Generate PDF
  // Use PDFKit or Puppeteer with HTML template
  const pdfBuffer = await renderCertificatePDF({
    certificate_number: certNumber,
    student: {
      full_name: student.profile.fullName,
      date_of_birth: student.profile.dateOfBirth,
      licence_number: student.licenceNumber,
      address: formatAddress(student.profile),
    },
    instructor: {
      full_name: instructor.profile.fullName,
      adi_number: instructor.adiNumber,
    },
    transmission: student.transmission,
    competencies: competencies.map(c => ({
      task_number: c.taskNumber,
      task_name: c.taskName,
      achieved_date: c.achievedAt,
    })),
    issued_at: new Date(),
  });

  // 7. Upload to R2
  const pdfPath = `certificates/${studentId}/${certNumber}.pdf`;
  const pdfUrl = await uploadToR2(pdfPath, pdfBuffer, 'application/pdf');

  // 8. Update student record (single atomic transaction)
  await db.update(students).set({
    certificateIssuedAt: new Date(),
    certificateNumber: certNumber,
    completionDate: new Date(),
    status: 'completed',
  }).where(eq(students.id, studentId));

  // 9. Audit log
  await writeAuditLog({
    eventType: 'CERTIFICATE_ISSUED',
    actorId: instructorId,
    actorRole: 'instructor',
    subjectType: 'student',
    subjectId: studentId,
    details: {
      certificate_number: certNumber,
      pdf_url: pdfUrl,
      transmission: student.transmission,
      total_competencies: competencies.length,
    },
  });

  // 10. Emit event
  await eventBus.emit({
    type: 'CERTIFICATE_ISSUED',
    data: {
      student_id: studentId,
      certificate_number: certNumber,
    },
  });

  return { certificateNumber: certNumber, pdfUrl };
}
```

**PDF Content Layout (Form 165751):**

| Section | Content |
|---------|---------|
| Header | NexDrive Academy logo, "Certificate of Competency", ACT Government reference |
| Student Details | Full name, DOB, licence number, address |
| Instructor Details | Full name, ADI number |
| Transmission | Manual / Automatic |
| Competency Table | All 23 tasks: task number, task name, date achieved |
| Review Assessments | Review 1 date, Review 2 date, Final Drive date |
| Professional Hours | Total professional hours with instructor |
| Declaration | Dual declaration text (instructor and student) |
| Signatures | Instructor signature, student signature (from most recent lesson) |
| Serial Number | Certificate number (CERT-YYYY-NNNN) |
| Issue Date | Date of generation |

**PDF Library:** Use `@react-pdf/renderer` (React-based PDF generation) or `puppeteer` with an HTML template. The HTML template approach is recommended for pixel-perfect Form 165751 matching — render HTML/CSS to PDF via Puppeteer running in a Vercel serverless function.

**R2 Storage Path:** `certificates/{student_id}/{certificate_number}.pdf`  
**R2 Access:** Signed URLs with 7-day expiry for student/parent download.

---

## 5. Service Layer Functions

### 5.1 Core Functions

```typescript
// ─── File: src/services/competency.service.ts ───────────────────

/**
 * Get all 23 competency tasks (cached reference data)
 */
export async function getAllCompetencyTasks(): Promise<CompetencyTask[]>

/**
 * Get current competency status for all tasks for a student.
 * Returns Map<task_number, latest_status>
 */
export async function getCurrentCompetencyStatuses(
  studentId: string,
  transmission: 'manual' | 'auto'
): Promise<Map<number, CompetencyStatus>>

/**
 * Get full competency matrix with can_assess flags and history.
 * This is the main data source for the competency grid UI.
 */
export async function getCompetencyMatrix(
  studentId: string,
  transmission?: 'manual' | 'auto'
): Promise<CompetencyMatrix>

/**
 * Record a competency status change. Creates new append-only row.
 * Emits COMPETENCY_ACHIEVED event if status is 'competent'.
 */
export async function recordCompetencyChange(params: {
  studentId: string;
  taskNumber: number;
  status: CompetencyStatus;
  transmission: 'manual' | 'auto';
  lessonId?: string;
  signatureId?: string;
  instructorId: string;
}): Promise<StudentCompetency>

/**
 * Check if a specific task can be assessed (prerequisites met).
 */
export async function canAssessTask(
  studentId: string,
  taskNumber: number,
  transmission: 'manual' | 'auto'
): Promise<{ can_assess: boolean; blocked_by: number[] }>

/**
 * Check Review 1 eligibility: All Tasks 1-16 must be competent.
 */
export async function checkReview1Eligibility(
  studentId: string,
  transmission: 'manual' | 'auto'
): Promise<{ eligible: boolean; missing: number[] }>

/**
 * Check Review 2 eligibility: Task 17 + Tasks 18-21 all competent.
 */
export async function checkReview2Eligibility(
  studentId: string,
  transmission: 'manual' | 'auto'
): Promise<{ eligible: boolean; missing: number[] }>

/**
 * Check Final Drive eligibility: Reviews + all 22 tasks competent.
 */
export async function checkFinalDriveEligibility(
  studentId: string,
  transmission: 'manual' | 'auto'
): Promise<{ eligible: boolean; missing: number[] }>

/**
 * Check certificate eligibility: all 23 + minimum hours.
 */
export async function checkCertificateEligibility(
  studentId: string,
  transmission?: 'manual' | 'auto'
): Promise<CertificateEligibility>

/**
 * Generate Certificate of Competency PDF.
 */
export async function generateCertificate(
  studentId: string,
  instructorId: string,
  options: { confirm: boolean; notes?: string }
): Promise<{ certificate_number: string; pdf_url: string }>
```

### 5.2 Lesson Integration Functions

```typescript
// ─── File: src/services/competency.service.ts (continued) ──────

/**
 * Process competency arrays from a completed lesson.
 * Called by the Instructor Workstation (C11) when a lesson is saved.
 * 
 * For each task number in the lesson's competency arrays:
 * - competencies_taught → create row with status='taught'
 * - competencies_assessed → create row with status='assessed'
 * - competencies_achieved_manual → create row with status='competent', transmission='manual'
 * - competencies_achieved_auto → create row with status='competent', transmission='auto'
 */
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

**Implementation of `processLessonCompetencies`:**

```typescript
async function processLessonCompetencies(params: ProcessLessonCompetenciesParams) {
  let created = 0;
  let eventsEmitted = 0;

  // Process taught (no prerequisite check)
  for (const taskNumber of params.competenciesTaught) {
    await recordCompetencyChange({
      studentId: params.studentId,
      taskNumber,
      status: 'taught',
      transmission: 'auto', // taught applies to both, default to student's transmission
      lessonId: params.lessonId,
      instructorId: params.instructorId,
    });
    created++;
  }

  // Process assessed (prerequisite check applies)
  for (const taskNumber of params.competenciesAssessed) {
    try {
      await recordCompetencyChange({
        studentId: params.studentId,
        taskNumber,
        status: 'assessed',
        transmission: 'auto',
        lessonId: params.lessonId,
        instructorId: params.instructorId,
      });
      created++;
    } catch (err) {
      // Log but don't fail the lesson — assessed might not meet prereqs
      // This shouldn't happen in practice because the UI prevents it
      console.error(`Cannot assess task ${taskNumber}: prerequisites not met`);
    }
  }

  // Process achieved (manual) — prerequisite check enforced
  for (const taskNumber of params.competenciesAchievedManual) {
    await recordCompetencyChange({
      studentId: params.studentId,
      taskNumber,
      status: 'competent',
      transmission: 'manual',
      lessonId: params.lessonId,
      signatureId: params.signatureId,
      instructorId: params.instructorId,
    });
    created++;
    eventsEmitted++;
  }

  // Process achieved (auto) — prerequisite check enforced
  for (const taskNumber of params.competenciesAchievedAuto) {
    await recordCompetencyChange({
      studentId: params.studentId,
      taskNumber,
      status: 'competent',
      transmission: 'auto',
      lessonId: params.lessonId,
      signatureId: params.signatureId,
      instructorId: params.instructorId,
    });
    created++;
    eventsEmitted++;
  }

  return { created, events_emitted: eventsEmitted };
}
```

### 5.3 Analytics Functions

```typescript
/**
 * Get progress analytics for a student.
 */
export async function getProgressAnalytics(
  studentId: string,
  transmission?: 'manual' | 'auto'
): Promise<ProgressAnalytics>
```

**`ProgressAnalytics` shape:**

```typescript
interface ProgressAnalytics {
  student_id: string;
  transmission: 'manual' | 'auto';
  competent_count: number;           // Tasks with status 'competent'
  total_tasks: number;               // 23
  completion_percentage: number;     // e.g., 60.87
  professional_hours: number;
  total_lessons: number;
  average_lessons_per_task: number;  // competent_count > 0 ? total_lessons / competent_count
  lessons_since_last_competency: number;
  days_since_last_lesson: number;
  projected_completion_date: string | null; // Based on current pace
  next_recommended_tasks: number[];  // Next tasks student should work on
  overdue: boolean;                  // No lesson in 21+ days
}
```

**Projected completion calculation:** `remaining_tasks / tasks_per_lesson * average_days_between_lessons + today`.

**Next recommended tasks:** Tasks whose prerequisites are all met but status is not yet `competent`. Ordered by `sort_order`.

---

## 6. Event Integration

### 6.1 Events Emitted

| Event | Trigger | Data |
|-------|---------|------|
| `COMPETENCY_ACHIEVED` | Status changes to `competent` | `{ student_id, student_name, task_number, task_name, transmission, student_competency_id }` |
| `CERTIFICATE_ISSUED` | Certificate PDF generated | `{ student_id, certificate_number }` |

### 6.2 Events Consumed

| Event | Handler |
|-------|---------|
| `LESSON_COMPLETED` | Call `processLessonCompetencies()` with lesson's competency arrays |
| `COMPETENCY_ACHIEVED` | Check if all 23 complete → log auto-eligibility check result |

### 6.3 Notification Templates (from SPEC-07)

**`competency_achieved` (Email):**
- To: Student
- Subject: "🎉 Task {task_number} Complete — {task_name}"
- Body: "Congratulations! You've completed {competent_count}/23 tasks. {remaining} to go!"
- Includes link to student portal progress view

**`certificate_issued` (SMS + Email):**
- To: Student
- Subject: "Your Certificate of Competency is ready!"
- Body: Certificate number, download link, congratulations

---

## 7. Transmission Tracking

### 7.1 How It Works

Each `student_competencies` row specifies `transmission: 'manual' | 'auto'`. A student can achieve the same task in both transmissions. The certificate checks competencies matching the student's enrolled transmission (`students.transmission`).

**Example:** Student enrolled as `auto`. They achieve Task 5 (Gear Changing) in both `manual` and `auto` during lessons. For certificate eligibility, only the `auto` achievement counts.

### 7.2 Lesson Integration

The `lessons` table has separate arrays:
- `competencies_achieved_manual INTEGER[]` — Tasks achieved in manual transmission this lesson
- `competencies_achieved_auto INTEGER[]` — Tasks achieved in auto transmission this lesson

When the instructor records a lesson, the Competency Grid UI shows a Manual/Auto toggle for achieved competencies. The toggle pre-defaults to the student's enrolled transmission.

### 7.3 Transmission Change

If a student changes their enrolled transmission (e.g., `auto` → `manual`), their existing competency records remain. Certificate eligibility recalculates against the new transmission. Some tasks may need to be re-achieved in the new transmission.

Transmission changes are logged in `audit_log` with event_type `TRANSMISSION_CHANGED`.

---

## 8. Append-Only Compliance

### 8.1 Rules

1. **No UPDATE on `student_competencies`.** Every status change is a new INSERT.
2. **No DELETE on `student_competencies`.** Historical record preserved forever.
3. **Hash chain links records.** Each record's `record_hash` incorporates the `previous_hash`, creating a tamper-evident chain per student.
4. **Current status is latest row.** Query: `ORDER BY created_at DESC LIMIT 1` per student+task+transmission.
5. **Corrections via new records.** If an error occurs, the instructor records a new status change (potentially reverting to a previous status). The new record's `lesson_id` can be NULL and notes can explain the correction.

### 8.2 Hash Chain Verification

```typescript
/**
 * Verify hash chain integrity for a student's competency records.
 * Returns true if all hashes are valid, false if tampering detected.
 */
async function verifyHashChain(studentId: string): Promise<{
  valid: boolean;
  total_records: number;
  first_broken_record_id?: string;
}> {
  const records = await db.query.studentCompetencies.findMany({
    where: eq(studentCompetencies.studentId, studentId),
    orderBy: asc(studentCompetencies.createdAt),
  });

  let previousHash: string | null = null;
  for (const record of records) {
    // Verify previous_hash links correctly
    const expectedPrevHash = previousHash ?? null;
    if (record.previousHash !== expectedPrevHash) {
      return { valid: false, total_records: records.length, first_broken_record_id: record.id };
    }

    // Recompute hash
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

## 9. File Structure

```
src/
├── app/api/v1/
│   ├── competency-tasks/
│   │   └── route.ts                    # GET /api/v1/competency-tasks
│   └── students/
│       └── [id]/
│           ├── competencies/
│           │   └── route.ts            # GET + POST /api/v1/students/:id/competencies
│           ├── certificate-eligibility/
│           │   └── route.ts            # GET /api/v1/students/:id/certificate-eligibility
│           └── certificate/
│               └── route.ts            # POST /api/v1/students/:id/certificate
├── services/
│   ├── competency.service.ts           # All business logic
│   └── certificate.service.ts          # PDF generation + R2 upload
├── lib/
│   ├── hash.ts                         # SHA-256 utility
│   └── events.ts                       # Event bus (emit/subscribe)
├── templates/
│   └── certificate.html                # HTML template for Form 165751 PDF
└── db/
    └── schema/
        └── compliance.ts               # Drizzle schema (competency_tasks, student_competencies)
```

---

## 10. TypeScript Types

```typescript
// ─── File: src/types/competency.types.ts ────────────────────────

export type CompetencyStatus =
  | 'not_started'
  | 'taught'
  | 'assessed'
  | 'competent'
  | 'not_yet_competent';

export type Transmission = 'manual' | 'auto';

export interface CompetencyTaskRef {
  id: string;
  task_number: number;
  name: string;
  description: string | null;
  category: string | null;
  prerequisites: number[];
  is_review: boolean;
  is_final_drive: boolean;
  review_requires_tasks: number[];
  final_drive_min_minutes: number | null;
  final_drive_unfamiliar_roads: boolean;
  sort_order: number;
}

export interface CompetencyEntry {
  task_number: number;
  task_name: string;
  category: string;
  status: CompetencyStatus;
  transmission: Transmission;
  taught_at: string | null;
  assessed_at: string | null;
  achieved_at: string | null;
  lesson_id: string | null;
  can_assess: boolean;
  blocked_by: number[];
  is_review: boolean;
  is_final_drive: boolean;
  history_count: number;
}

export interface CompetencyMatrix {
  student_id: string;
  transmission: Transmission;
  competencies: CompetencyEntry[];
  summary: {
    total: number;
    competent: number;
    in_progress: number;
    not_started: number;
    not_yet_competent: number;
  };
}

export interface MissingTask {
  task_number: number;
  name: string;
  status: CompetencyStatus;
}

export interface CertificateEligibility {
  eligible: boolean;
  student_id: string;
  student_name: string;
  transmission: Transmission;
  total_tasks: number;
  competent_tasks: number;
  missing_tasks: MissingTask[];
  review_1_passed: boolean;
  review_2_passed: boolean;
  final_drive_passed: boolean;
  professional_hours: number;
  minimum_hours_met: boolean;
  minimum_hours_required: number;
  certificate_already_issued: boolean;
}

export interface CertificateResult {
  certificate_number: string;
  student_id: string;
  student_name: string;
  pdf_url: string;
  issued_at: string;
  transmission: Transmission;
  instructor_name: string;
  instructor_adi_number: string;
}

export interface ProgressAnalytics {
  student_id: string;
  transmission: Transmission;
  competent_count: number;
  total_tasks: number;
  completion_percentage: number;
  professional_hours: number;
  total_lessons: number;
  average_lessons_per_task: number;
  lessons_since_last_competency: number;
  days_since_last_lesson: number;
  projected_completion_date: string | null;
  next_recommended_tasks: number[];
  overdue: boolean;
}
```

---

## 11. RBAC Summary

| Endpoint | Admin | Instructor | Student | Parent |
|----------|-------|-----------|---------|--------|
| GET /competency-tasks | ✅ | ✅ | ✅ | ✅ |
| GET /students/:id/competencies | All | Own students | Own only | Linked (if permitted) |
| POST /students/:id/competencies | ✅ | Own students | ❌ | ❌ |
| GET /students/:id/certificate-eligibility | ✅ | Own students | ❌ | ❌ |
| POST /students/:id/certificate | ✅ | Own students | ❌ | ❌ |

**Enforcement pattern:** Clerk middleware extracts `{ userId, role, instructorId, studentId }` from session claims. Service layer verifies ownership before every DB query. See SPEC-02 §3 for full implementation.

---

## 12. Testing Strategy

### 12.1 Unit Tests (competency.service.test.ts)

**Prerequisite Logic:**
- Task with no prerequisites → `can_assess: true`
- Task with unmet prerequisites → `can_assess: false`, correct `blocked_by`
- Task with all prerequisites met → `can_assess: true`
- Cannot mark `competent` with unmet prerequisites → 409 error
- CAN mark `taught` with unmet prerequisites → success (opportunistic teaching)

**Review Gating:**
- Review 1 (Task 17): Fails if any of Tasks 1-16 not competent
- Review 1 (Task 17): Passes when all Tasks 1-16 competent
- Tasks 18-21 cannot be assessed until Review 1 passed
- Review 2 (Task 22): Fails if Task 17 not competent
- Review 2 (Task 22): Fails if any of Tasks 18-21 not competent
- Review 2 (Task 22): Passes when Task 17 + Tasks 18-21 all competent

**Final Drive Gating:**
- Task 23 fails without Review 1 → correct error
- Task 23 fails without Review 2 → correct error
- Task 23 passes with both reviews + all tasks competent

**Status State Machine:**
- Valid transitions succeed (new row created)
- Invalid transitions rejected (e.g., `not_started` → `not_yet_competent`)
- Each change creates exactly one new row (append-only verified)
- Hash chain links correctly (previous_hash matches last record)
- `not_yet_competent` → re-assess → `competent` flow works

**Certificate Eligibility:**
- Not eligible: missing tasks → returns correct missing list
- Not eligible: insufficient hours → returns hours info
- Eligible: all 23 competent + hours met → `eligible: true`
- Already issued: returns `certificate_already_issued: true`

**Transmission:**
- Same task achieved in `auto` and `manual` → separate records
- Certificate eligibility only checks enrolled transmission
- Transmission change doesn't delete existing records

### 12.2 Integration Tests (competency.integration.test.ts)

- Full student journey: Task 1 → Task 23 → Certificate
- Lesson with competency arrays → competency rows created
- COMPETENCY_ACHIEVED event emitted on achievement
- CERTIFICATE_ISSUED event emitted on certificate generation
- PDF generated and uploaded to R2
- Student record updated (certificate_number, status='completed')
- Hash chain integrity verified after 50+ records

### 12.3 RBAC Tests

- Instructor can view/edit own students' competencies
- Instructor CANNOT view another instructor's students
- Student can view own competencies
- Student CANNOT view another student's competencies
- Parent can view linked student (if `parent_visibility = true`)
- Parent CANNOT view linked student (if `parent_visibility = false`)
- Only instructor/admin can POST competencies
- Only instructor/admin can generate certificates

### 12.4 Load Tests

- 100 students × 23 tasks × avg 3 status changes = 6,900 rows → query performance < 50ms
- Concurrent competency updates for different students → no conflicts
- Certificate generation under load → queue handles gracefully

---

## 13. Seed Data Script

```typescript
// ─── File: src/db/seed-competency-tasks.ts ──────────────────────

const TASKS = [
  { taskNumber: 1, name: 'Pre-Drive Procedure', category: 'Basic Control',
    description: 'Starting, adjusting and shutting down the car; seatbelt, mirrors, head restraint, gear selection',
    prerequisites: [], sortOrder: 1 },
  { taskNumber: 2, name: 'Controls and Instruments', category: 'Basic Control',
    description: 'Understanding all vehicle controls, gauges and instruments',
    prerequisites: [1], sortOrder: 2 },
  { taskNumber: 3, name: 'Moving Off and Stopping', category: 'Basic Control',
    description: 'Smooth take-off from kerb and stop; clutch/brake coordination',
    prerequisites: [1, 2], sortOrder: 3 },
  { taskNumber: 4, name: 'Steering', category: 'Basic Control',
    description: 'Hand-over-hand, push-pull steering; maintaining lane position',
    prerequisites: [3], sortOrder: 4 },
  { taskNumber: 5, name: 'Gear Changing', category: 'Basic Control',
    description: 'Smooth up/down gear changes; selecting appropriate gear for speed and road conditions',
    prerequisites: [3], sortOrder: 5 },
  { taskNumber: 6, name: 'Low Speed Manoeuvres', category: 'Basic Control',
    description: 'U-turns, 3-point turns, reversing, parking (parallel, angle, 90°)',
    prerequisites: [3, 4, 5], sortOrder: 6 },
  { taskNumber: 7, name: 'Intersections — Give Way/Stop', category: 'Traffic',
    description: 'Approaching and negotiating give way and stop sign intersections',
    prerequisites: [3, 4, 5], sortOrder: 7 },
  { taskNumber: 8, name: 'Intersections — Traffic Lights', category: 'Traffic',
    description: 'Green, amber, red, arrows; turning at traffic lights',
    prerequisites: [7], sortOrder: 8 },
  { taskNumber: 9, name: 'Intersections — Roundabouts', category: 'Traffic',
    description: 'Single and multi-lane roundabouts; signalling; lane selection',
    prerequisites: [7], sortOrder: 9 },
  { taskNumber: 10, name: 'Lane Changing and Overtaking', category: 'Traffic',
    description: 'Safe lane changes; mirror checks; overtaking procedures',
    prerequisites: [4, 7], sortOrder: 10 },
  { taskNumber: 11, name: 'Speed Management', category: 'Traffic',
    description: 'Matching speed to conditions; speed zones; school zones',
    prerequisites: [3, 5], sortOrder: 11 },
  { taskNumber: 12, name: 'Gap Selection', category: 'Traffic',
    description: 'Judging safe gaps in traffic for turning and merging',
    prerequisites: [7, 10], sortOrder: 12 },
  { taskNumber: 13, name: 'Following Distance', category: 'Traffic',
    description: '3-second rule; adjusting for conditions',
    prerequisites: [11], sortOrder: 13 },
  { taskNumber: 14, name: 'Hazard Perception', category: 'Complex',
    description: 'Identifying and responding to potential hazards; scanning; prediction',
    prerequisites: [7, 11, 13], sortOrder: 14 },
  { taskNumber: 15, name: 'Sharing the Road', category: 'Complex',
    description: 'Vulnerable road users: cyclists, pedestrians, motorcyclists, heavy vehicles',
    prerequisites: [10, 14], sortOrder: 15 },
  { taskNumber: 16, name: 'Night Driving', category: 'Complex',
    description: 'High/low beam; reduced visibility; adjusting to darkness',
    prerequisites: [14], sortOrder: 16 },
  { taskNumber: 17, name: 'Review Assessment — Tasks 1-17', category: 'Review',
    description: 'Formal review of competencies 1-17',
    prerequisites: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    isReview: true, reviewRequiresTasks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    sortOrder: 17 },
  { taskNumber: 18, name: 'Driving in Traffic', category: 'Advanced',
    description: 'Higher traffic volumes; multi-lane roads; managing complex traffic environments',
    prerequisites: [10, 12, 14], sortOrder: 18 },
  { taskNumber: 19, name: 'Freeway / Highway Driving', category: 'Advanced',
    description: 'Merging, exiting, maintaining speed on high-speed roads',
    prerequisites: [10, 11, 18], sortOrder: 19 },
  { taskNumber: 20, name: 'Rural / Country Roads', category: 'Advanced',
    description: 'Unsealed roads, single-lane bridges, livestock, fatigue management',
    prerequisites: [11, 14], sortOrder: 20 },
  { taskNumber: 21, name: 'Adverse Conditions', category: 'Advanced',
    description: 'Rain, fog, sun glare; adjusting driving for conditions',
    prerequisites: [14, 16], sortOrder: 21 },
  { taskNumber: 22, name: 'Review Assessment — Tasks 18-22', category: 'Review',
    description: 'Formal review of competencies 18-22',
    prerequisites: [17, 18, 19, 20, 21],
    isReview: true, reviewRequiresTasks: [18, 19, 20, 21],
    sortOrder: 22 },
  { taskNumber: 23, name: 'Final Drive Assessment', category: 'Final',
    description: 'Comprehensive final assessment; minimum 45 minutes; unfamiliar roads required',
    prerequisites: [17, 22],
    isFinalDrive: true, finalDriveMinMinutes: 45, finalDriveUnfamiliarRoads: true,
    sortOrder: 23 },
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

## 14. Implementation Checklist

### Phase A: Core API (3-4 days)
- [ ] Create Drizzle schema for competency_tasks and student_competencies (if not from SPEC-01)
- [ ] Create DB trigger: `compute_competency_hash()` for hash chain
- [ ] Run seed script for 23 competency tasks
- [ ] Implement `competency.service.ts` — all core functions
- [ ] Implement `GET /api/v1/competency-tasks` endpoint
- [ ] Implement `GET /api/v1/students/:id/competencies` endpoint
- [ ] Implement `POST /api/v1/students/:id/competencies` endpoint
- [ ] Implement prerequisite checking and `can_assess` / `blocked_by` logic
- [ ] Implement review eligibility checks (Review 1, Review 2, Final Drive)
- [ ] Write unit tests for all prerequisite/gating rules

### Phase B: Certificate Engine (3-4 days)
- [ ] Implement `GET /api/v1/students/:id/certificate-eligibility` endpoint
- [ ] Implement certificate eligibility business logic
- [ ] Design Certificate HTML template (Form 165751 layout)
- [ ] Implement PDF generation (Puppeteer or @react-pdf/renderer)
- [ ] Implement certificate number generation (CERT-YYYY-NNNN sequence)
- [ ] Implement R2 upload for certificate PDFs
- [ ] Implement `POST /api/v1/students/:id/certificate` endpoint
- [ ] Update student record on certificate issuance
- [ ] Write unit + integration tests for certificate flow

### Phase C: Event Integration (2 days)
- [ ] Wire `COMPETENCY_ACHIEVED` event emission in `recordCompetencyChange`
- [ ] Wire `CERTIFICATE_ISSUED` event emission in `generateCertificate`
- [ ] Register `LESSON_COMPLETED` handler → `processLessonCompetencies()`
- [ ] Register `COMPETENCY_ACHIEVED` handler → auto-check certificate eligibility
- [ ] Test end-to-end: lesson save → competency rows → event → notification

### Phase D: Analytics & Polish (2 days)
- [ ] Implement progress analytics (projected completion, next tasks, overdue flag)
- [ ] Implement hash chain verification function
- [ ] RBAC tests for all four roles
- [ ] Load test with simulated 100-student dataset
- [ ] API documentation (OpenAPI/Swagger annotations)

---

## 15. Dependencies

| Dependency | Purpose | Notes |
|-----------|---------|-------|
| SPEC-01 | Database schema | Tables must exist before API |
| SPEC-02 | Auth & RBAC | Clerk middleware + role extraction |
| SPEC-07 | Notification Engine | `COMPETENCY_ACHIEVED` email template |
| SPEC-12 | E-Signature | `signature_id` references |
| C11 (Instructor Workstation) | Lesson recording calls `processLessonCompetencies()` | C12 provides the API, C11 consumes it |
| Puppeteer or @react-pdf/renderer | PDF generation | Certificate of Competency |
| Cloudflare R2 SDK | Certificate PDF storage | Sydney region |

---

## 16. Open Questions for Rob

1. **Minimum professional hours for certificate:** Currently set to 20 hours. Is this the correct threshold for ACT requirements?
2. **Certificate serial number format:** Using `CERT-YYYY-NNNN`. Does the ACT require a specific format? Is there an external serial number allocation system?
3. **Prerequisite override:** Currently allows admin override with reason. Should Rob (as sole instructor initially) have this ability without admin role, or should he always have admin?
4. **NYC re-assessment cool-down:** Should there be a minimum time/lessons between a NYC marking and re-assessment of the same task?
5. **Certificate PDF branding:** NexDrive logo + ACT Government reference, or should it mirror the exact ACT Government carbonless form layout?

---

*End of SPEC-13: CBT&A Compliance Engine*
