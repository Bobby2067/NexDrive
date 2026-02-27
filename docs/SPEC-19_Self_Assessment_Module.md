# SPEC-19: Self-Assessment Module (C24)
**NexDrive Academy — Component Specification**
**Phase:** 4 (Student/Parent Experience) — Weeks 21–28
**Status:** Ready for build
**Depends on:** SPEC-01 (DB Schema), SPEC-02 (Auth/RBAC), SPEC-13 (CBT&A Compliance Engine / C12), SPEC-17 (Student Portal / C03), SPEC-07 (Notification Engine / C18)
**Referenced by:** SPEC-12 (Instructor Workstation / C11)

---

## 1. Purpose

The Self-Assessment Module lets students rate their own confidence across CBT&A competency tasks before a scheduled review lesson. The instructor sees the completed self-assessment before the lesson begins, enabling them to target instruction toward areas of low confidence rather than repeating what the student already feels comfortable with.

This is a communication and pedagogical tool — not a compliance document. It is never part of the regulatory record. It sits inside the student portal and surfaces as a dashboard card in the instructor workstation.

---

## 2. Database Table

From `SPEC-01_Database_Schema_ERD.md` (instructor-tools.ts):

```typescript
export const selfAssessments = pgTable('self_assessments', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id').notNull().references(() => students.id),

  assessmentType: text('assessment_type', {
    enum: ['pre_review_1_17', 'pre_review_1_22', 'pre_final_drive', 'general'],
  }).notNull(),

  responses: jsonb('responses').notNull(),
  // Array of: [{ task_number: number, confidence: 1|2|3|4|5, notes: string | null }]

  completedAt: timestamp('completed_at', { withTimezone: true }),
  reviewedByInstructor: boolean('reviewed_by_instructor').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_sa_student').on(table.studentId),
]);
```

**Notes:**
- `completedAt` is null until the student submits. A record may be created on first open (draft state) or only on submit — prefer submit-only creation to keep the table clean.
- `reviewedByInstructor` is toggled to `true` the first time an instructor opens the self-assessment view for that record.
- `responses` JSONB must be validated at the API layer before write.

---

## 3. Assessment Types & Task Coverage

| Assessment Type | Tasks Shown | When Triggered |
|---|---|---|
| `pre_review_1_17` | Tasks 1–17 | Booking type = `review` AND student has not yet passed their first review |
| `pre_review_1_22` | Tasks 1–22 | Booking type = `review` AND student passed first review but not second |
| `pre_final_drive` | Tasks 1–23 (all) | Booking type = `pre_test` or final drive assessment |
| `general` | All 23 tasks (ungated) | Manually opened from student portal at any time |

**Determination logic** (run server-side when the student portal loads the self-assessment):

```typescript
function determineAssessmentType(student: Student, booking: Booking): AssessmentType {
  if (booking.serviceType === 'pre_test') return 'pre_final_drive';
  if (booking.serviceType === 'review') {
    const passedFirstReview = student.competencyMilestone >= 17;
    const passedSecondReview = student.competencyMilestone >= 22;
    if (passedSecondReview) return 'pre_final_drive';
    if (passedFirstReview) return 'pre_review_1_22';
    return 'pre_review_1_17';
  }
  return 'general';
}
```

The `competency_tasks` table (23 rows, seeded in SPEC-01) is the single source of truth for task numbers, names, and descriptions. The API must join against it to populate the form — never hardcode task data in the frontend.

---

## 4. Responses Schema (JSONB)

Each element in the `responses` array:

```typescript
interface TaskResponse {
  task_number: number;       // 1–23
  confidence: 1 | 2 | 3 | 4 | 5;
  notes: string | null;      // max 500 chars, optional free-text
}
```

Confidence scale:

| Score | Label | Description |
|---|---|---|
| 1 | Not started | I haven't practised this yet |
| 2 | Attempted | I've tried it but struggle |
| 3 | Getting there | I can do it sometimes |
| 4 | Confident | I can do it most of the time |
| 5 | Mastered | I can do it consistently |

All tasks in scope for the assessment type must be present in the responses array on submit. Partial submissions are rejected.

---

## 5. API Endpoints

### 5.1 GET /api/v1/students/:id/self-assessments

Returns all self-assessments for a student, newest first.

**Auth:** Student may only access their own record. Instructor may access any student they teach. Parent may access their linked student's records (confidence scores only — instructor notes excluded, but student notes are visible). Admin can access all.

**Query params:**
- `?assessmentType=pre_review_1_17` — filter by type (optional)
- `?bookingId=uuid` — filter by associated booking (optional)
- `?limit=10&offset=0` — pagination

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "studentId": "uuid",
      "assessmentType": "pre_review_1_17",
      "responses": [
        { "task_number": 1, "confidence": 4, "notes": "Pretty good on this one" },
        { "task_number": 2, "confidence": 2, "notes": null }
      ],
      "completedAt": "2026-03-15T09:00:00+11:00",
      "reviewedByInstructor": false,
      "createdAt": "2026-03-15T08:45:00+11:00"
    }
  ],
  "total": 3,
  "limit": 10,
  "offset": 0
}
```

---

### 5.2 POST /api/v1/students/:id/self-assessments

Creates a new self-assessment. Only the student themselves (or an admin) may create one.

**Auth:** `student` role only (or `admin`). Instructors do not create self-assessments on behalf of students.

**Request body:**
```json
{
  "assessmentType": "pre_review_1_17",
  "bookingId": "uuid",
  "responses": [
    { "task_number": 1, "confidence": 4, "notes": "Feel okay on this" },
    { "task_number": 2, "confidence": 2, "notes": null }
    // ... all tasks in scope must be present
  ]
}
```

**Validation:**
- `assessmentType` must be one of the four enum values
- `responses` array length must equal the number of tasks in scope for that assessment type (17, 22, 22, or 23)
- All `task_number` values must be present with no gaps
- `confidence` must be 1–5 integer
- `notes` max 500 chars

**Response 201:**
```json
{
  "data": {
    "id": "uuid",
    "assessmentType": "pre_review_1_17",
    "completedAt": "2026-03-15T09:00:00+11:00",
    "lowConfidenceTasks": [2, 5, 9]
  }
}
```

`lowConfidenceTasks` (confidence ≤ 2) is returned immediately so the student UI can acknowledge what areas will be flagged for the instructor.

**Side effects:**
- Sets `completedAt` to `now()` on the new record
- Triggers a notification to the assigned instructor (see §9)
- If `bookingId` is provided, stores the association (the `bookingId` is not a DB column — it is used only to look up the instructor and fire the notification)

---

### 5.3 PATCH /api/v1/self-assessments/:id/reviewed

Marks a self-assessment as reviewed by the instructor. Called automatically when the instructor opens the detail view.

**Auth:** `instructor` or `admin` only.

**Request body:** none

**Response 200:**
```json
{ "reviewed": true }
```

---

## 6. Student Experience (C03 Integration)

### 6.1 Entry Points

The student sees a self-assessment prompt in two places inside C03 (Student Portal):

**A — Upcoming lesson banner:** When the student has a review or pre-test lesson within the next 7 days and has not yet submitted a self-assessment for it, a banner appears at the top of the portal home screen:

> 📝 **You have a review lesson on [date].** Complete your self-assessment so Rob can tailor the lesson to your needs. → [Start Self-Assessment]

**B — Self-Assessment tab:** A dedicated tab in the portal where students can view all past self-assessments and start a general one at any time.

### 6.2 Assessment Form UX

The form renders one task per row in a scrollable list. Each row shows:
- Task number and name (pulled from `competency_tasks`)
- A brief plain-language description of the task
- A 5-button confidence selector (1–5 with emoji labels)
- An optional notes field (collapsed by default, expands on tap)

On mobile (instructor car tablet or student phone), the form must be comfortable to complete in 5–10 minutes. Keep the layout vertical and touch-friendly. Minimum tap target 44×44px.

**Progress indicator:** "12 of 17 tasks rated" shown at top. Submit button only enables when all tasks are rated.

**Confidence selector labels (compact):**
- 1 — ❌ Not started
- 2 — 😬 Struggling
- 3 — 🤔 Getting there
- 4 — 👍 Confident
- 5 — ✅ Mastered

**Submit confirmation screen:**
- Shows a summary: "You rated X tasks as low confidence (1–2). Rob will focus on these in your lesson."
- Lists the low-confidence task names
- Provides a "Back to portal" button

### 6.3 Past Assessments View

A table or card list showing:
- Assessment type (human label, e.g., "Pre-Review (Tasks 1–17)")
- Date completed
- Score summary: e.g., "3 low / 9 medium / 5 confident"
- Instructor reviewed: ✅ or ⏳

Students cannot edit or delete a submitted self-assessment.

---

## 7. Instructor View (C11 Integration)

### 7.1 Upcoming Reviews Dashboard Card

On the Instructor Workstation home screen (C11), a card titled **"Upcoming Reviews"** lists all review-type bookings in the next 14 days. Each row shows:

| Student | Lesson Date | Type | Self-Assessment |
|---|---|---|---|
| Jane Smith | Mon 23 Mar, 10:00am | Review (1–17) | ✅ Completed — 4 low confidence areas |
| Tom Jones | Tue 24 Mar, 2:00pm | Review (1–22) | ⏳ Pending |
| Sarah Lee | Wed 25 Mar, 9:00am | Pre-Test | ✅ Completed — 1 low confidence area |

Clicking **"✅ Completed"** opens the assessment detail view (§7.2) and fires the PATCH `/reviewed` call.

### 7.2 Assessment Detail View

Shown in the instructor workstation before or during the review lesson. Layout:

**Header:** Student name, assessment type, submission date/time.

**Low Confidence Tasks (confidence 1–2):** Rendered first in a red/amber highlight box. Shows task number, name, confidence score, and student notes. These are the focus areas for the lesson.

**Medium Confidence Tasks (confidence 3):** Rendered in a neutral section below. Worth checking but not the primary focus.

**High Confidence Tasks (confidence 4–5):** Collapsed by default with a "Show all" toggle. Instructor can skip detailed attention here.

**Instructor Notes field:** A private scratchpad (maps to `private_notes` table, C15) where the instructor can jot lesson planning notes based on the self-assessment. This is never visible to the student.

**"Mark as Reviewed" button:** Visible until the record is marked reviewed. After marking, shows a checkmark and timestamp.

### 7.3 Lesson Plan Influence

The self-assessment does not auto-generate a lesson plan. It informs Rob's judgment. The low-confidence task list is surfaced as a suggested focus list in the instructor workstation's lesson recording screen (C11), pre-populated as the session's competency task targets. Rob can accept, remove, or add tasks before the lesson begins.

Integration point: When C11 loads the lesson recording screen for a review booking, it calls `GET /api/v1/students/:id/self-assessments?bookingId=:bookingId` and, if a completed assessment exists, passes the `lowConfidenceTasks` array to pre-populate the competency task selector.

---

## 8. Notification Trigger (C18 Integration)

### 8.1 Reminder to Student

When a review or pre-test booking is created or confirmed, C18 schedules a reminder notification:

- **Trigger:** Booking confirmed with `serviceType` in `['review', 'pre_test']`
- **Timing:** 72 hours before lesson start AND 24 hours before lesson start (if not yet completed)
- **Channels:** SMS (primary) + in-app notification badge
- **Message (SMS):**

> Hi [First Name], your review lesson with Rob is on [Day, Date] at [Time]. Please complete your self-assessment before then so Rob can focus on what matters most: [portal link]. Reply STOP to opt out.

- **Suppression:** If the student completes the self-assessment, the 24-hour reminder is cancelled (check `completedAt IS NOT NULL` before send).

### 8.2 Notification to Instructor

When a student submits a self-assessment:

- **Channel:** In-app notification in instructor workstation (push or badge)
- **Message:** "[Student Name] has completed their self-assessment for [Lesson Date]. [X] low confidence areas flagged."
- **Action:** Deep link to the assessment detail view

This notification uses the `notifications` table. Email is not sent to the instructor for this trigger — in-app only.

---

## 9. File Structure

```
src/
├── app/
│   ├── (student)/
│   │   └── portal/
│   │       └── self-assessment/
│   │           ├── page.tsx                  # Self-assessment tab (list + CTA)
│   │           ├── [assessmentId]/
│   │           │   └── page.tsx              # Past assessment detail (read-only for student)
│   │           └── new/
│   │               └── page.tsx              # Assessment form
│   └── (instructor)/
│       └── workstation/
│           └── reviews/
│               └── [bookingId]/
│                   └── self-assessment/
│                       └── page.tsx          # Instructor assessment detail view
├── api/
│   └── v1/
│       ├── students/
│       │   └── [id]/
│       │       └── self-assessments/
│       │           └── route.ts              # GET, POST
│       └── self-assessments/
│           └── [id]/
│               └── reviewed/
│                   └── route.ts              # PATCH
├── components/
│   └── self-assessment/
│       ├── AssessmentForm.tsx                # Main form (task list + confidence selectors)
│       ├── TaskRow.tsx                       # Individual task row
│       ├── ConfidenceSelector.tsx            # 5-button selector
│       ├── AssessmentSummary.tsx             # Student post-submit summary
│       ├── InstructorAssessmentDetail.tsx    # Instructor detail view
│       ├── LowConfidencePanel.tsx            # Red/amber highlight panel
│       └── UpcomingReviewsCard.tsx           # Instructor workstation dashboard card
├── lib/
│   └── self-assessments/
│       ├── service.ts                        # Business logic (CRUD, type determination)
│       ├── validators.ts                     # Zod schemas for request validation
│       └── notifications.ts                  # Notification trigger helpers (calls C18)
└── db/
    └── schema/
        └── instructor-tools.ts               # selfAssessments table (already in SPEC-01)
```

---

## 10. Service Layer (lib/self-assessments/service.ts)

```typescript
// Key functions — implement these, all DB access goes through here

async function createSelfAssessment(
  studentId: string,
  payload: CreateSelfAssessmentPayload,
  callerClerkId: string,
): Promise<SelfAssessmentRecord>

async function getStudentSelfAssessments(
  studentId: string,
  filters: SelfAssessmentFilters,
  callerRole: Role,
): Promise<PaginatedResult<SelfAssessmentRecord>>

async function markReviewed(
  assessmentId: string,
  instructorClerkId: string,
): Promise<void>

async function getLowConfidenceTasks(
  assessmentId: string,
): Promise<number[]>   // returns task_numbers with confidence <= 2

async function getAssessmentForBooking(
  bookingId: string,
  studentId: string,
): Promise<SelfAssessmentRecord | null>

async function determineAssessmentType(
  studentId: string,
  bookingId: string,
): Promise<AssessmentType>
```

All functions enforce role-based access. Throw `ForbiddenError` if caller does not have access. Never throw database errors directly — wrap in domain errors.

---

## 11. Zod Validation (lib/self-assessments/validators.ts)

```typescript
const TaskResponseSchema = z.object({
  task_number: z.number().int().min(1).max(23),
  confidence: z.number().int().min(1).max(5),
  notes: z.string().max(500).nullable(),
});

const CreateSelfAssessmentSchema = z.object({
  assessmentType: z.enum(['pre_review_1_17', 'pre_review_1_22', 'pre_final_drive', 'general']),
  bookingId: z.string().uuid().optional(),
  responses: z.array(TaskResponseSchema),
}).refine((data) => {
  const expectedCounts: Record<string, number> = {
    pre_review_1_17: 17,
    pre_review_1_22: 22,
    pre_final_drive: 23,
    general: 23,
  };
  return data.responses.length === expectedCounts[data.assessmentType];
}, { message: 'Response count does not match assessment type task scope' });
```

---

## 12. Auth & Access Control

| Action | Student (own) | Student (other) | Instructor | Parent | Admin |
|---|---|---|---|---|---|
| Create self-assessment | ✅ | ❌ | ❌ | ❌ | ✅ |
| Read own assessments | ✅ | ❌ | ✅ (if their student) | ✅ (linked student) | ✅ |
| Read confidence scores | ✅ | ❌ | ✅ | ✅ | ✅ |
| Read student notes | ✅ | ❌ | ✅ | ✅ | ✅ |
| Mark reviewed | ❌ | ❌ | ✅ | ❌ | ✅ |
| Delete assessment | ❌ | ❌ | ❌ | ❌ | ❌ (no deletes) |

Auth is enforced via Clerk middleware for role detection and checked again inside each service function. No database-level RLS.

---

## 13. Error States

| Error | HTTP Code | Message |
|---|---|---|
| Student not found | 404 | Student not found |
| Assessment not found | 404 | Assessment not found |
| Caller accessing another student's data | 403 | Forbidden |
| Response count mismatch | 422 | Response count does not match assessment type task scope |
| Confidence out of range | 422 | Confidence must be between 1 and 5 |
| Notes too long | 422 | Notes must be 500 characters or fewer |
| Duplicate for same booking | 409 | A self-assessment for this booking already exists |

---

## 14. Acceptance Criteria

**Student experience:**
- [ ] Student sees reminder banner on portal home when review lesson is within 7 days and no self-assessment exists
- [ ] Student can complete assessment form — all tasks in scope rendered, confidence required, notes optional
- [ ] Student cannot submit until all tasks are rated
- [ ] Submit shows a summary of low-confidence areas flagged for instructor
- [ ] Student can view all past assessments in read-only mode
- [ ] SMS reminder sent 72h and 24h before review lesson; 24h reminder suppressed if already completed

**Instructor experience:**
- [ ] Upcoming Reviews card in workstation shows assessment status (Pending / Completed + count of low-confidence areas) for all review bookings in next 14 days
- [ ] Clicking a completed assessment opens detail view, marks it as reviewed, and fires in-app notification cleared
- [ ] Low-confidence tasks rendered prominently at top of detail view
- [ ] Medium and high confidence tasks rendered below in collapsed/grouped sections
- [ ] Instructor scratchpad (private notes) is available on the detail view and writes to `private_notes` table
- [ ] Low-confidence tasks pre-populate the competency task selector in the lesson recording screen (C11) for the associated booking

**API:**
- [ ] POST validates response count matches assessment type task scope
- [ ] POST rejects duplicate assessment for same booking (409)
- [ ] GET returns correct records scoped by caller role
- [ ] PATCH `/reviewed` is idempotent

**Data:**
- [ ] No self-assessment record can be updated or deleted after creation (service layer enforces)
- [ ] `completedAt` is set at creation time (submit-only model — no draft state)

---

## 15. Dependencies & Integration Points

| Dependency | How Used |
|---|---|
| SPEC-01 DB Schema | `selfAssessments` table in `instructor-tools.ts` |
| SPEC-02 Auth/RBAC | Clerk role detection; `instructor_id` scoping |
| SPEC-13 CBT&A Engine (C12) | `competency_tasks` table for task names/descriptions; student milestone for type determination |
| SPEC-17 Student Portal (C03) | Embeds assessment form and past assessments tab |
| SPEC-12 Instructor Workstation (C11) | Reads low-confidence tasks to pre-populate lesson recording; hosts detail view |
| SPEC-07 Notification Engine (C18) | Student SMS reminders; instructor in-app notification on submission |
| SPEC-16 Lesson Bridge Forms (C25) | No direct dependency; both are read by C11 at the start of a lesson |

---

## 16. Out of Scope

- Instructor-created self-assessments on behalf of students
- AI-generated lesson plans from self-assessment data (future enhancement)
- Historical comparison / trend charts across assessments (future enhancement, data structure supports it)
- Self-assessment as a compliance document or regulatory record
- Parents completing assessments (view only)

---

*SPEC-19 — Self-Assessment Module (C24) | NexDrive Academy | Phase 4 | v1.0 | 22 February 2026*
