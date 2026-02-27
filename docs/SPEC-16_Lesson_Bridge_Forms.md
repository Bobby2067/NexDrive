# SPEC-16: Lesson Bridge Form Generator (C25)
**NexDrive Academy — Component Specification**
**Phase:** 3 (Digitise the Paperwork) — Weeks 13–20
**Status:** Ready for build
**Depends on:** SPEC-01 (DB Schema), SPEC-02 (Auth/RBAC), SPEC-12 (Instructor Workstation / C11), SPEC-13 (CBT&A Engine / C12), SPEC-07 (Notification Engine / C18)
**Referenced by:** SPEC-17 (Student Portal / C03), SPEC-18 (Parent Resource Center / C16)

---

## 1. Purpose

The Lesson Bridge Form Generator automatically produces a structured, printable/shareable post-lesson summary for supervising drivers (parents, guardians). It bridges the gap between what happened in a professional lesson and what the supervising driver should reinforce at home.

A bridge form is created for every completed and fully-signed lesson. It is NOT a compliance document — it is a communication and learning tool. It must be:
- Readable by a non-expert supervising driver
- Actionable (clear practice instructions)
- Auto-generated with zero instructor effort beyond normal lesson notes
- Distributable as a PDF email attachment or a link in the student portal

---

## 2. Database Table

From `NexDrive_System_Architecture_v1_1.md §3.3`:

```sql
CREATE TABLE lesson_bridge_forms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id       UUID NOT NULL UNIQUE REFERENCES lessons(id),
  student_id      UUID NOT NULL REFERENCES students(id),
  instructor_id   UUID NOT NULL REFERENCES instructors(id),

  -- Content (auto-generated from lesson data)
  skills_covered  JSONB NOT NULL,
  -- Array of { task_number: int, task_name: string, status: 'taught'|'assessed'|'competent' }

  positives       TEXT,   -- What went well (from lesson.comments, filtered)
  practice_instructions TEXT, -- What to practise at home
  focus_areas     TEXT,   -- Areas needing attention
  next_lesson_recommendation TEXT, -- Suggested focus for next lesson

  -- Generated document
  pdf_url         TEXT,   -- R2 storage path: bridge-forms/{student_id}/{lesson_id}.pdf

  -- Visibility
  is_visible_to_student BOOLEAN NOT NULL DEFAULT TRUE,
  is_visible_to_parent  BOOLEAN NOT NULL DEFAULT TRUE,
  -- ^^ subject to parent_student_links.can_view_bridge_forms

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- No updated_at — this record is immutable after creation.
  -- If re-generated, INSERT a new row (lesson_id is UNIQUE so re-generation overwrites via upsert).
);

CREATE INDEX idx_lbf_student ON lesson_bridge_forms(student_id);
CREATE INDEX idx_lbf_lesson  ON lesson_bridge_forms(lesson_id);
```

**Important:** The `lesson_bridge_forms` table is **not** an append-only compliance table. Bridge forms can be re-generated if the lesson record is corrected. The `UNIQUE` constraint on `lesson_id` ensures one canonical bridge form per lesson — use `INSERT ... ON CONFLICT (lesson_id) DO UPDATE` for idempotent generation.

---

## 3. Data Sources and Mapping

The auto-generation pipeline reads from three sources and produces four structured fields plus the `skills_covered` array.

### 3.1 Source Tables

| Source Table | Columns Used |
|---|---|
| `lessons` | `student_id`, `instructor_id`, `lesson_date`, `lesson_number`, `total_minutes`, `competencies_taught`, `competencies_assessed`, `competencies_achieved_auto`, `competencies_achieved_manual`, `comments`, `location_suburb` |
| `competency_tasks` | `task_number`, `name`, `description`, `category` — joined on task_number IN lesson arrays |
| `students` (→ `profiles`) | Student full name, preferred name |
| `instructors` (→ `profiles`) | Instructor full name |

### 3.2 `skills_covered` Mapping

Union all task numbers across the four lesson competency arrays, deduplicate, sort by task_number ascending:

```typescript
type SkillStatus = 'taught' | 'assessed' | 'competent';

interface SkillCovered {
  task_number: number;
  task_name: string;    // from competency_tasks.name
  category: string;     // from competency_tasks.category
  status: SkillStatus;
}
```

Status priority (highest wins per task number):
- `competencies_achieved_auto` OR `competencies_achieved_manual` → `'competent'`
- `competencies_assessed` (not in achieved) → `'assessed'`
- `competencies_taught` (not in assessed/achieved) → `'taught'`

### 3.3 Narrative Field Generation

The four narrative fields (`positives`, `practice_instructions`, `focus_areas`, `next_lesson_recommendation`) are produced by a Claude API call using the lesson data as context. This is lightweight — ~200 token input, ~300 token output.

**Why AI for this?** Rob's raw `comments` field is written in instructor shorthand. A supervising driver needs plain English. Claude converts instructor notes to parent-friendly language without Rob spending additional time.

**Prompt (system):**
```
You are a driving instructor assistant for NexDrive Academy in Canberra, ACT, Australia.
Your job is to convert a lesson summary into a short, friendly handout for the student's supervising driver (parent or guardian). 
Be specific and practical. Use plain English — the reader is not a driving instructor.
Avoid jargon. Be encouraging and positive. Australian English spelling.
Output must be valid JSON only. No markdown, no prose outside the JSON object.
```

**Prompt (user):**
```json
{
  "student_name": "{{student_preferred_name}}",
  "lesson_number": {{lesson_number}},
  "lesson_date": "{{lesson_date_formatted}}",
  "duration_minutes": {{total_minutes}},
  "location": "{{location_suburb}}",
  "skills_worked_on": [
    { "task_number": 3, "name": "Turning corners", "status": "assessed" },
    { "task_number": 7, "name": "Intersections — give way", "status": "competent" }
  ],
  "instructor_comments": "{{lessons.comments}}"
}
```

**Required JSON output shape:**
```json
{
  "positives": "String. 2–4 sentences. Specific praise about what went well.",
  "practice_instructions": "String. 3–5 actionable dot points as a single string with newlines. What the student should practise in supervised sessions.",
  "focus_areas": "String. 2–3 sentences. Areas that need more work — framed constructively.",
  "next_lesson_recommendation": "String. 1–2 sentences. What the next professional lesson will focus on."
}
```

**Model:** `claude-sonnet-4-5`  
**Max tokens:** 400  
**Temperature:** 0.3 (consistent, professional tone)  
**Error handling:** If Claude API fails or returns malformed JSON, fall back to structured defaults derived from the raw comments and skills list. Never block bridge form creation because of an AI failure.

**Fallback (no AI):**
```typescript
const fallback = {
  positives: `${studentName} worked on ${skillsSummary} during lesson ${lessonNumber}.`,
  practice_instructions: skillsCovered
    .filter(s => s.status !== 'competent')
    .map(s => `Practise ${s.task_name} in a quiet area.`)
    .join('\n'),
  focus_areas: `Continue practising the skills covered this lesson, particularly in varied traffic conditions.`,
  next_lesson_recommendation: `The next lesson will build on today's progress.`,
};
```

---

## 4. API Endpoints

### 4.1 `POST /api/v1/lessons/:id/bridge-form`

**Purpose:** Generate (or re-generate) the bridge form for a given lesson.

**Auth:** 🎓 `INSTRUCTOR` role only. Instructor must own the lesson (`lesson.instructor_id = authed_instructor_id`).

**Trigger:** Called automatically by the `LESSON_COMPLETED` event handler (see §7). Can also be called manually by the instructor to regenerate.

**Idempotency:** Fully idempotent. Calling twice produces the same result (overwrites via upsert).

**Preconditions:**
- `lesson.status = 'completed'` (both signatures captured)
- Lesson must belong to the authed instructor

**Request body:** None (all data derived from lesson record).

**Process:**
1. Fetch lesson by `:id` — verify `status = 'completed'` and `instructor_id` matches auth.
2. Fetch relevant `competency_tasks` rows for all task numbers in lesson arrays.
3. Build `skills_covered` array (§3.2 mapping).
4. Call Claude API to generate narrative fields (§3.3). Parse and validate JSON response.
5. Render PDF using bridge form template (§5). Upload to R2 (§6).
6. Upsert record in `lesson_bridge_forms`:
   ```sql
   INSERT INTO lesson_bridge_forms (
     lesson_id, student_id, instructor_id,
     skills_covered, positives, practice_instructions,
     focus_areas, next_lesson_recommendation, pdf_url
   ) VALUES (...)
   ON CONFLICT (lesson_id) DO UPDATE SET
     skills_covered = EXCLUDED.skills_covered,
     positives = EXCLUDED.positives,
     practice_instructions = EXCLUDED.practice_instructions,
     focus_areas = EXCLUDED.focus_areas,
     next_lesson_recommendation = EXCLUDED.next_lesson_recommendation,
     pdf_url = EXCLUDED.pdf_url;
   ```
7. Emit internal event `BRIDGE_FORM_GENERATED` (consumed by notification engine for parent email — §8).
8. Write to `audit_log`: `{ action: 'BRIDGE_FORM_GENERATED', entity_type: 'lesson_bridge_forms', entity_id: bridgeForm.id, actor_id: instructorId }`.

**Response `200 OK`:**
```json
{
  "bridge_form": {
    "id": "uuid",
    "lesson_id": "uuid",
    "student_id": "uuid",
    "skills_covered": [
      { "task_number": 3, "task_name": "Turning corners", "category": "Basic Control", "status": "assessed" }
    ],
    "positives": "...",
    "practice_instructions": "...",
    "focus_areas": "...",
    "next_lesson_recommendation": "...",
    "pdf_url": "https://cdn.nexdriveacademy.com.au/bridge-forms/student-uuid/lesson-uuid.pdf",
    "is_visible_to_student": true,
    "is_visible_to_parent": true,
    "created_at": "2026-02-22T10:00:00Z"
  }
}
```

**Error responses:**

| Code | Condition |
|---|---|
| `404` | Lesson not found or not owned by instructor |
| `409` | Lesson not yet completed (`status != 'completed'`) |
| `500` | PDF generation or R2 upload failed (log error, return message) |

---

### 4.2 `GET /api/v1/students/:id/bridge-forms`

**Purpose:** List all bridge forms for a student.

**Auth:** Multi-role endpoint — different roles get different results.

| Caller Role | Visibility Rule |
|---|---|
| `INSTRUCTOR` | Must own the student (`student.instructor_id = authed`). Returns all bridge forms regardless of visibility flags. |
| `STUDENT` | Must be the student (`student.clerk_user_id = authed`). Returns only forms where `is_visible_to_student = TRUE`. |
| `PARENT` | Must have an active `parent_student_links` record for this student with `can_view_bridge_forms = TRUE`. Returns only forms where `is_visible_to_parent = TRUE`. |

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | integer | 1 | Pagination page |
| `per_page` | integer | 20 | Max 50 |
| `lesson_id` | UUID | — | Filter to single lesson |

**Response `200 OK`:**
```json
{
  "bridge_forms": [
    {
      "id": "uuid",
      "lesson_id": "uuid",
      "lesson_date": "2026-02-22",
      "lesson_number": 14,
      "skills_covered": [...],
      "positives": "...",
      "practice_instructions": "...",
      "focus_areas": "...",
      "next_lesson_recommendation": "...",
      "pdf_url": "https://cdn.nexdriveacademy.com.au/bridge-forms/...",
      "is_visible_to_student": true,
      "is_visible_to_parent": true,
      "created_at": "2026-02-22T10:00:00Z"
    }
  ],
  "meta": {
    "total": 14,
    "page": 1,
    "per_page": 20
  }
}
```

**Note:** `pdf_url` returned here is a **signed R2 URL** with a 1-hour expiry (for students/parents). Instructors receive the raw R2 path, or a longer-lived signed URL. Never expose the raw R2 bucket URL publicly.

---

### 4.3 `PATCH /api/v1/bridge-forms/:id/visibility`

**Purpose:** Toggle student/parent visibility. Instructor only.

**Auth:** `INSTRUCTOR` — must own the bridge form's lesson.

**Request body:**
```json
{
  "is_visible_to_student": true,
  "is_visible_to_parent": false
}
```

**Response `200 OK`:** Updated bridge form record.

**Note:** This is the only mutable operation on a bridge form. The content and PDF are immutable after creation.

---

## 5. PDF Generation

### 5.1 Library

Use `@react-pdf/renderer` (v3.x). This library renders React components to PDF server-side — ideal for Vercel Functions and consistent with the Next.js stack. It is synchronous and has no Chromium dependency (unlike Puppeteer), making it lightweight for serverless.

```bash
npm install @react-pdf/renderer
```

### 5.2 Template Layout

The bridge form is a **single A4 page** PDF, portrait orientation, designed to be printed and handed to the supervising driver, or read on a phone screen.

```
┌─────────────────────────────────────────────────────┐
│  [NexDrive Logo]           NexDrive Academy         │
│  nexdriveacademy.com.au     Rob Harrison | ADI Cert  │
│  ─────────────────────────────────────────────────   │
│                                                     │
│  LESSON SUMMARY — Take-Home Guide                   │
│                                                     │
│  Student: Jordan Smith          Lesson #14          │
│  Date: Saturday, 22 Feb 2026    Duration: 90 min    │
│  Location: Tuggeranong          Instructor: Rob H.  │
│                                                     │
│  ─── SKILLS COVERED THIS LESSON ──────────────────  │
│  ✓  Task 7  — Intersections: give way (Achieved)    │
│  ►  Task 3  — Turning corners (Assessed)            │
│  ○  Task 9  — Lane changes (Introduced)             │
│                                                     │
│  ─── WHAT WENT WELL ───────────────────────────────  │
│  Jordan showed strong understanding of give way      │
│  rules at T-intersections today...                  │
│                                                     │
│  ─── PRACTICE AT HOME ─────────────────────────────  │
│  • When driving with you, practise turning left     │
│    onto quiet residential streets...                │
│  • Find an empty car park to work on smooth         │
│    acceleration from a stop...                      │
│                                                     │
│  ─── THINGS TO WORK ON ────────────────────────────  │
│  Jordan needs to check mirrors more consistently    │
│  before changing lanes...                           │
│                                                     │
│  ─── NEXT LESSON FOCUS ────────────────────────────  │
│  We'll build on today's intersection work by        │
│  introducing roundabouts (Task 8)...                │
│                                                     │
│  ─────────────────────────────────────────────────   │
│  Questions? Call Rob: 0400 XXX XXX                  │
│  or visit nexdriveacademy.com.au                    │
└─────────────────────────────────────────────────────┘
```

### 5.3 Status Icons in Skills Section

| Status | Icon | Label |
|---|---|---|
| `competent` | ✓ (green) | Achieved |
| `assessed` | ► (amber) | Assessed |
| `taught` | ○ (blue) | Introduced |

### 5.4 Branding

| Element | Value |
|---|---|
| Primary colour | `#1E3A5F` (deep navy) |
| Accent colour | `#F59E0B` (amber) |
| Success colour | `#16A34A` (green) |
| Body font | `Helvetica` (built into react-pdf, no external font needed for v1) |
| Logo | Fetch from R2 at `branding/nexdrive-logo.png` at render time |
| Footer contact | Rob's phone number + website (stored in environment variable `INSTRUCTOR_PHONE`) |

### 5.5 React PDF Component

```typescript
// src/lib/bridge-form/BridgeFormDocument.tsx
import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';

interface BridgeFormDocumentProps {
  studentName: string;
  lessonNumber: number;
  lessonDate: string;      // formatted: "Saturday, 22 Feb 2026"
  durationMinutes: number;
  locationSuburb: string;
  instructorName: string;
  skillsCovered: SkillCovered[];
  positives: string;
  practiceInstructions: string;
  focusAreas: string;
  nextLessonRecommendation: string;
  logoDataUrl: string;     // base64 PNG — pre-fetched from R2
}

export const BridgeFormDocument: React.FC<BridgeFormDocumentProps> = (props) => (
  <Document title={`NexDrive Bridge Form — Lesson ${props.lessonNumber}`}>
    <Page size="A4" style={styles.page}>
      {/* Header */}
      {/* Skills Table */}
      {/* Four narrative sections */}
      {/* Footer */}
    </Page>
  </Document>
);
```

### 5.6 Rendering

```typescript
import { renderToBuffer } from '@react-pdf/renderer';

const pdfBuffer = await renderToBuffer(<BridgeFormDocument {...props} />);
// → Uint8Array, upload to R2
```

`renderToBuffer` is the correct server-side API (not `renderToStream` which is for Node streams, not Vercel edge). Wrap in try/catch — if render fails, log error and set `pdf_url = null` in the database row rather than failing the entire bridge form record.

---

## 6. R2 Storage

### 6.1 File Path Convention

```
bridge-forms/{student_id}/{lesson_id}.pdf
```

Example: `bridge-forms/a3f8.../c71b....pdf`

### 6.2 Upload

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,   // https://<account>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

await r2.send(new PutObjectCommand({
  Bucket: process.env.R2_BUCKET_NAME!,  // 'nexdrive-files'
  Key: `bridge-forms/${studentId}/${lessonId}.pdf`,
  Body: pdfBuffer,
  ContentType: 'application/pdf',
  ContentDisposition: `attachment; filename="NexDrive-Lesson-${lessonNumber}-Bridge-Form.pdf"`,
  // No public ACL — access via signed URLs only
}));
```

### 6.3 Signed URL Generation

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const signedUrl = await getSignedUrl(r2, new GetObjectCommand({
  Bucket: process.env.R2_BUCKET_NAME!,
  Key: `bridge-forms/${studentId}/${lessonId}.pdf`,
}), { expiresIn: 3600 }); // 1 hour
```

### 6.4 `pdf_url` Stored in Database

Store the **R2 key** (not the signed URL) in `lesson_bridge_forms.pdf_url`. Generate signed URLs at query time in the service layer. This allows the signing secret to be rotated without invalidating database records.

```
pdf_url = "bridge-forms/a3f8.../c71b....pdf"   ← stored in DB
```

---

## 7. Auto-Generation Trigger

C25 subscribes to the internal `LESSON_COMPLETED` event. This event is emitted by C11 (Instructor Workstation) when the lesson's second signature is captured and status transitions to `'completed'`.

### 7.1 Event Handler

```typescript
// src/lib/events/handlers/bridgeFormHandler.ts
import { appEventBus } from '../eventBus';
import { generateBridgeForm } from '../../bridge-form/bridgeFormService';

appEventBus.on('LESSON_COMPLETED', async (lesson) => {
  try {
    await generateBridgeForm(lesson.id, lesson.instructor_id);
  } catch (err) {
    // Log to Sentry — do NOT re-throw. Bridge form failure must never
    // affect lesson completion or signature capture.
    Sentry.captureException(err, { tags: { component: 'C25' }, extra: { lesson_id: lesson.id } });
  }
});
```

**Critical:** Bridge form generation must never block or fail the lesson completion flow. It is a background side effect. Use a fire-and-forget pattern wrapped in error handling.

### 7.2 Ordering

The `LESSON_COMPLETED` event fires these handlers (from architecture §8 event table):
1. Bridge Form Generator (C25) — this spec
2. Competency Engine (C12) — updates student progress
3. Notification Engine (C18) — sends lesson completion SMS/email

All handlers run concurrently via `Promise.allSettled` in the event bus. C25 must emit its own internal `BRIDGE_FORM_GENERATED` event after successful generation for C18 to pick up and send the bridge form email.

---

## 8. Parent Notification

After successful bridge form generation, C25 emits `BRIDGE_FORM_GENERATED`. C18 (Notification Engine) consumes this event and sends the bridge form PDF as an email attachment to opted-in parents.

### 8.1 Opt-In Gate (Three Conditions — ALL must be true)

1. `parent_student_links.status = 'active'`
2. `parent_student_links.can_view_bridge_forms = TRUE`
3. `lesson_bridge_forms.is_visible_to_parent = TRUE`

Fetch all active, opted-in parent links for the student, then send individually to each parent's email.

### 8.2 Email Template (C18)

Uses notification template `bridge_form_ready` (listed in architecture §4.2.6 notification table as SMS + Email).

**Subject:** `Jordan's Lesson 14 Summary — NexDrive Academy`

**Body (plain English, parent-friendly):**
```
Hi [Parent Name],

Jordan's driving lesson on Saturday 22 February is complete. 
Rob has put together this lesson summary to help you support 
Jordan's practice between lessons.

[Attach: NexDrive-Lesson-14-Bridge-Form.pdf]

You can also view this summary online at any time through 
the NexDrive parent portal: [link]

Questions? Reply to this email or call Rob on 0400 XXX XXX.

NexDrive Academy
```

**Attachment:** Fetch PDF from R2 via `GetObjectCommand` → stream into Resend attachment.

```typescript
// Resend attachment format
{
  filename: `NexDrive-Lesson-${lessonNumber}-Bridge-Form.pdf`,
  content: pdfBuffer,   // Buffer
}
```

### 8.3 SMS Notification (C18)

Send a short SMS to parent's mobile (if SMS opted in):

```
NexDrive: Jordan's lesson summary is ready. View it here: [signed portal link]
```

The SMS does NOT attach the PDF — it links to the parent portal view.

---

## 9. Web Views

### 9.1 Student Portal — Bridge Forms Section (C03)

**Route:** `/portal/lessons` (within lesson history) or `/portal/bridge-forms`

**Data fetch:** `GET /api/v1/students/{studentId}/bridge-forms`

**UI Pattern:**
- List view: lesson date, lesson number, skill count, link to PDF and inline view
- Each item: expandable card showing all four narrative sections + skills table
- Download PDF button → opens signed R2 URL in new tab
- Only shows forms where `is_visible_to_student = TRUE`

### 9.2 Parent Resource Centre — Bridge Forms Section (C16)

**Route:** `/parent/bridge-forms`

**Data fetch:** `GET /api/v1/students/{linkedStudentId}/bridge-forms` (parent auth)

**Access gate (service layer):**
```typescript
const link = await db.query.parentStudentLinks.findFirst({
  where: and(
    eq(parentStudentLinks.parent_id, parentId),
    eq(parentStudentLinks.student_id, studentId),
    eq(parentStudentLinks.status, 'active'),
    eq(parentStudentLinks.can_view_bridge_forms, true),
  ),
});
if (!link) throw new ForbiddenError();
```

Only return forms where `is_visible_to_parent = TRUE`.

**UI:** Same card pattern as student portal. Show student name prominently (parent may have multiple linked students in future).

---

## 10. Service Layer

All business logic lives in a single service module. No direct DB access from route handlers.

```typescript
// src/lib/bridge-form/bridgeFormService.ts

export async function generateBridgeForm(
  lessonId: string,
  instructorId: string,
): Promise<LessonBridgeForm> { ... }

export async function getBridgeFormsForStudent(
  studentId: string,
  callerRole: 'instructor' | 'student' | 'parent',
  callerId: string,
  pagination: { page: number; perPage: number },
): Promise<{ forms: LessonBridgeForm[]; total: number }> { ... }

export async function updateBridgeFormVisibility(
  bridgeFormId: string,
  instructorId: string,
  updates: { is_visible_to_student?: boolean; is_visible_to_parent?: boolean },
): Promise<LessonBridgeForm> { ... }

// Internal helpers
async function buildSkillsCovered(lesson: Lesson): Promise<SkillCovered[]> { ... }
async function generateNarrativeFields(lesson: Lesson, skills: SkillCovered[]): Promise<NarrativeFields> { ... }
async function renderAndUploadPDF(data: BridgeFormData): Promise<string> { ... }  // returns R2 key
async function getSignedPdfUrl(r2Key: string): Promise<string> { ... }
```

---

## 11. Drizzle ORM Schema

```typescript
// src/db/schema/lessonBridgeForms.ts
import { pgTable, uuid, text, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { lessons, students, instructors } from './index';

export const lessonBridgeForms = pgTable('lesson_bridge_forms', {
  id:                         uuid('id').primaryKey().defaultRandom(),
  lessonId:                   uuid('lesson_id').notNull().unique().references(() => lessons.id),
  studentId:                  uuid('student_id').notNull().references(() => students.id),
  instructorId:               uuid('instructor_id').notNull().references(() => instructors.id),
  skillsCovered:              jsonb('skills_covered').notNull(),
  positives:                  text('positives'),
  practiceInstructions:       text('practice_instructions'),
  focusAreas:                 text('focus_areas'),
  nextLessonRecommendation:   text('next_lesson_recommendation'),
  pdfUrl:                     text('pdf_url'),
  isVisibleToStudent:         boolean('is_visible_to_student').notNull().default(true),
  isVisibleToParent:          boolean('is_visible_to_parent').notNull().default(true),
  createdAt:                  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

---

## 12. Route Handlers

```typescript
// src/app/api/v1/lessons/[id]/bridge-form/route.ts
export async function POST(request: NextRequest, { params }) {
  const { userId, sessionClaims } = getAuth(request);
  if (sessionClaims?.role !== 'instructor') return forbidden();

  const instructor = await getInstructorByClerkId(userId);
  const form = await generateBridgeForm(params.id, instructor.id);
  return NextResponse.json({ bridge_form: form });
}

// src/app/api/v1/students/[id]/bridge-forms/route.ts
export async function GET(request: NextRequest, { params }) {
  const { userId, sessionClaims } = getAuth(request);
  const role = sessionClaims?.role as 'instructor' | 'student' | 'parent';
  const { page, per_page } = parsePagination(request);

  const result = await getBridgeFormsForStudent(params.id, role, userId, { page, perPage: per_page });
  return NextResponse.json({ bridge_forms: result.forms, meta: { total: result.total, page, per_page } });
}

// src/app/api/v1/bridge-forms/[id]/visibility/route.ts
export async function PATCH(request: NextRequest, { params }) {
  const { userId, sessionClaims } = getAuth(request);
  if (sessionClaims?.role !== 'instructor') return forbidden();

  const instructor = await getInstructorByClerkId(userId);
  const body = await request.json();
  const updated = await updateBridgeFormVisibility(params.id, instructor.id, body);
  return NextResponse.json({ bridge_form: updated });
}
```

---

## 13. Environment Variables

```bash
# R2
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=nexdrive-files
R2_PUBLIC_DOMAIN=https://cdn.nexdriveacademy.com.au   # custom domain for R2

# Branding
INSTRUCTOR_PHONE=0400000000
NEXDRIVE_WEBSITE=https://nexdriveacademy.com.au

# AI
ANTHROPIC_API_KEY=...
```

---

## 14. Error Handling and Edge Cases

| Scenario | Behaviour |
|---|---|
| Lesson has no competency data | `skills_covered = []`. Generate bridge form with "No competency tasks recorded this lesson." in skills section. Still call Claude for narrative from comments. |
| Lesson has no comments | Claude prompt includes `instructor_comments: null`. Narrative fields will be generic but still valid. |
| Claude API timeout or error | Use structured fallback (§3.3). Log to Sentry. Bridge form still created. |
| PDF render fails | Store bridge form record with `pdf_url = null`. Student/parent see web view only. Instructor sees "PDF unavailable" with retry button in admin. |
| R2 upload fails | Retry once. If still failing, log to Sentry, store `pdf_url = null`. Notify via Sentry alert. |
| Parent has revoked link (`status = 'revoked'`) | Service layer query filters on `status = 'active'` — parent gets 403. |
| Student sets `can_view_bridge_forms = FALSE` | Parent sees 403. Bridge form still generated. |
| Instructor sets `is_visible_to_parent = FALSE` | Parent cannot see via API. No email sent. |

---

## 15. Testing Requirements

### Unit Tests
- `buildSkillsCovered` — correct status priority logic across all four arrays
- `generateNarrativeFields` — Claude API called with correct prompt shape; fallback invoked on error
- `getBridgeFormsForStudent` — correct visibility filtering per role
- Visibility PATCH — only instructor can update; correct ownership check

### Integration Tests
- `POST /lessons/:id/bridge-form` — full happy path from lesson ID to DB record
- `GET /students/:id/bridge-forms` — student role returns only visible forms; parent role enforces `can_view_bridge_forms`
- Re-generation — second POST on same lesson overwrites record (upsert), pdf_url updated

### PDF Tests
- Render `BridgeFormDocument` with representative data and assert output is a non-empty PDF buffer
- Snapshot test on rendered PDF page count (should be 1)

---

## 16. Dependencies and Build Order

C25 can be built once the following are complete:

| Dependency | Reason |
|---|---|
| SPEC-01: Database schema | `lesson_bridge_forms` table must exist |
| SPEC-02: Auth/RBAC | Clerk middleware, role extraction |
| SPEC-12: Instructor Workstation | `LESSON_COMPLETED` event must be emitted |
| SPEC-13: CBT&A Engine | `competency_tasks` seed data must exist |
| Phase 0: R2 bucket | Storage bucket and credentials ready |

C25 is a **dependency** of:
- SPEC-17 (Student Portal) — bridge forms section in C03
- SPEC-18 (Parent Resource Center) — bridge forms section in C16
- SPEC-07 (Notification Engine) — `bridge_form_ready` email template

Build C25 after C11 and C12 are functional (mid Phase 3, Week 18 estimate).

---

*SPEC-16 — NexDrive Academy | Phase 3 | C25 Lesson Bridge Form Generator*
*Authored by: BMAD Technical Architect Agent | 22 February 2026*
