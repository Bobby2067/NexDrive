# SPEC-17: Student Portal (C03)
### NexDrive Academy — Phase 4 Implementation Brief
**Version:** 1.0  
**Date:** 22 February 2026  
**Status:** Ready for Implementation  
**BMAD Phase:** 5 (Component Specs)  
**Build Phase:** Phase 4 (Weeks 21–28)  
**Suggested Build Tool:** v0 (design mockups) → Cursor (build)  
**Depends On:** SPEC-01 (DB), SPEC-02 (Auth/RBAC), SPEC-03 (Booking), SPEC-04 (Payment), SPEC-05 (CRM), SPEC-13 (CBT&A), SPEC-15 (Audit Trail), SPEC-16 (Bridge Forms)  
**Feeds Into:** SPEC-18 (Parent Resource Center), SPEC-19 (Self-Assessment)

---

## 1. Overview

The Student Portal is an authenticated web application providing students with self-service access to their driving education records, bookings, payments, competency progress, and privacy controls. It is the primary student-facing surface of NexDrive Academy beyond the public website.

**Users:** Students only (role: `student`). Parent access is governed by separate permissions defined in `parent_student_links` and delivered via the Parent Resource Center (C16) — parents do not log into this portal.

**Privacy guarantee:** Instructor private notes (`private_notes` table) are **never exposed** — they are excluded from all response shapes by the API layer, and this portal never requests or renders them.

**Architecture position:** Pure frontend — all data fetched via REST API (`/api/v1/`). No direct database access. All business logic stays in the service layer.

---

## 2. Technical Foundation

### 2.1 Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14.x App Router |
| Language | TypeScript 5.x |
| Styling | TailwindCSS 3.x |
| Auth | Clerk (student role required on all routes) |
| State | React useState / useReducer for local; SWR for server state |
| Data Fetching | SWR with stale-while-revalidate pattern |
| Forms | React Hook Form + Zod validation |
| Charts/Visuals | Recharts (progress ring, competency heatmap) |
| PDF Download | Browser fetch → Blob → anchor download (PDFs generated server-side by C25) |
| Error Tracking | Sentry |
| Analytics | PostHog + GA4 |

### 2.2 Authentication & Role Guard

All portal pages live under `/portal/` and are protected by a Clerk middleware guard that verifies:
1. Session exists (`auth().protect()`)
2. `publicMetadata.role === 'student'`
3. `publicMetadata.studentId` maps to a real student record owned by the correct instructor

```typescript
// middleware.ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPortalRoute = createRouteMatcher(['/portal(.*)']);

export default clerkMiddleware(async (auth, req) => {
  if (isPortalRoute(req)) {
    const { sessionClaims } = await auth.protect();
    if (sessionClaims?.metadata?.role !== 'student') {
      return Response.redirect(new URL('/unauthorised', req.url));
    }
  }
});
```

Every API call from the portal includes the Clerk session token as `Authorization: Bearer <token>`. The API service layer validates the token and resolves `student_id` from `clerk_user_id` before processing.

### 2.3 File Structure

```
src/
├── app/
│   └── portal/
│       ├── layout.tsx               # Portal shell (sidebar + header)
│       ├── page.tsx                 # Dashboard
│       ├── bookings/
│       │   ├── page.tsx             # Upcoming bookings list
│       │   ├── new/page.tsx         # Book new lesson
│       │   └── [id]/page.tsx        # Booking detail + reschedule/cancel
│       ├── lessons/
│       │   ├── page.tsx             # Lesson history list
│       │   └── [id]/page.tsx        # Lesson detail
│       ├── progress/
│       │   ├── page.tsx             # Competency matrix
│       │   └── [taskNumber]/page.tsx # Task detail + history
│       ├── payments/
│       │   ├── page.tsx             # Payment history + packages
│       │   └── [id]/page.tsx        # Invoice detail
│       ├── bridge-forms/
│       │   └── page.tsx             # Bridge form list
│       ├── self-assessment/
│       │   └── page.tsx             # Self-assessment entry (→ SPEC-19)
│       ├── settings/
│       │   ├── page.tsx             # Profile management
│       │   ├── privacy/page.tsx     # Parent visibility toggles
│       │   └── parents/page.tsx     # Parent invitation + management
│       └── export/
│           └── page.tsx             # Data export
├── components/
│   └── portal/
│       ├── PortalShell.tsx          # Layout wrapper with nav
│       ├── CompetencyRing.tsx       # SVG progress ring (X/23)
│       ├── CompetencyMatrix.tsx     # Full 23-task grid
│       ├── LessonCard.tsx
│       ├── BookingCard.tsx
│       ├── PaymentRow.tsx
│       ├── PrivacyToggleRow.tsx
│       ├── ParentInviteForm.tsx
│       └── UpcomingCountdown.tsx
└── lib/
    ├── api/
    │   ├── portal.ts               # Typed fetch wrappers
    │   └── types.ts                # Response type interfaces
    └── hooks/
        ├── useStudentProgress.ts
        ├── useBookings.ts
        └── usePayments.ts
```

---

## 3. Navigation & Layout

### 3.1 Portal Shell

Persistent shell with sidebar (desktop) and bottom tab bar (mobile). Student's first name and avatar (from Clerk) in header.

**Nav items:**
1. Dashboard
2. Bookings
3. My Progress
4. Lessons
5. Payments
6. Settings (expands to: Profile, Privacy, Parent Connections, Notifications, Data Export)

### 3.2 Responsive Breakpoints

| Layout | Applies at |
|--------|-----------|
| Mobile — bottom tab bar, stacked cards | < 768px |
| Tablet — icon-only collapsed sidebar | 768px–1024px |
| Desktop — full sidebar with labels (240px) | > 1024px |

---

## 4. Section Specifications

### 4.1 Dashboard — `/portal/`

**Data sources:**
- `GET /api/v1/bookings/upcoming` → next lesson card
- `GET /api/v1/students/:id/progress` → competency summary
- `GET /api/v1/students/:id/lessons?limit=3` → recent lessons
- `GET /api/v1/me/packages` → credit balance

**Layout:**

```
┌─────────────────────────────────────────┐
│  NEXT LESSON                             │
│  Tuesday 25 Feb · 9:00 AM · 60 min      │
│  [Reschedule]             [Cancel]       │
├─────────────────────────────────────────┤
│  COMPETENCY PROGRESS                     │
│        ●●●●●●●●●●●●○○○○○○○○○○○         │
│             12 / 23 complete             │
│  [View full progress →]                  │
├─────────────────────────────────────────┤
│  RECENT LESSONS                          │
│  18 Feb — Roundabouts, merging (2 tasks)│
│  11 Feb — Reverse parking (1 task)      │
│  [View all →]                            │
├─────────────────────────────────────────┤
│  QUICK ACTIONS                           │
│  [Book a lesson]  [View bridge forms]   │
│  [My self-assessment]                    │
└─────────────────────────────────────────┘
```

**`<CompetencyRing />` component:**
- SVG donut arc; fills proportionally with `competent / 23`
- Centre label: `12/23` large, `competent` below in muted text
- Green = competent, Amber = in_progress, Grey = not_started
- Entrance animation: arc fills over 600ms on mount

**Next lesson card:**
- If booking within 7 days → countdown chip "In 3 days"
- If no upcoming bookings → CTA: "Book your next lesson →"
- All times in ACT local time (AEST/AEDT)

**Package credit banner:** If active package has remaining credits, show inline banner: "You have 2 lesson credits remaining."

---

### 4.2 Bookings — `/portal/bookings/`

**Data source:** `GET /api/v1/bookings?status=confirmed,pending&date_from=today`

Each booking card shows: date/time (human-friendly), duration, service type, status badge, `Reschedule` button (if > 24 hours away), `Cancel` button.

Past bookings hidden behind "Show past bookings" toggle, paginated via cursor.

#### 4.2.1 Book New Lesson — `/portal/bookings/new`

Embeds the C02 Booking Widget in authenticated mode. Student name/email/phone pre-populated from Clerk profile. Flow: service → date/time (from `/booking/availability`) → apply credit/voucher → payment → confirmation.

#### 4.2.2 Reschedule

Opens a **drawer** (not a new page). Date/time picker calls `PATCH /api/v1/bookings/:id`. Old slot released; new slot reserved 10 minutes during selection.

Policy notice (displayed in drawer):
> Rescheduling is available up to 24 hours before your lesson. Changes within 24 hours may incur a late change fee.

#### 4.2.3 Cancel

**Confirmation modal** before any action. Shows lesson date/time and policy:
> Cancellations within 24 hours may incur a fee. Package credits may not be refunded.

Buttons: `Keep my lesson` (dismiss) | `Cancel lesson` (calls `POST /api/v1/bookings/:id/cancel`, then SWR revalidates).

---

### 4.3 Lesson History — `/portal/lessons/`

**Data source:** `GET /api/v1/students/:id/lessons` (paginated, newest first)

Each item in list: lesson number, date (human-friendly), duration, competencies count, signature status badge (`Signed` / `Pending` / `Draft`).

#### 4.3.1 Lesson Detail — `/portal/lessons/[id]`

**Data source:** `GET /api/v1/lessons/:id`

Sections:

**Lesson Summary:** Lesson number, date, duration, location suburb, instructor name.

**Competencies This Lesson:** Each task number with name and status chip (Taught / Assessed / Achieved–Auto / Achieved–Manual). Colour-coded to match progress matrix.

**Instructor Feedback:** `comments` field displayed as formatted text block. Label: "Instructor feedback". **Private notes are NOT shown and NOT fetched.**

**Signatures:** Instructor + student signature with signed name and timestamp. If student signature is pending (`signature_status === 'instructor_signed'`), show `Sign now` button.

**Bridge Form:** If `bridge_form_id` exists, show `View Bridge Form` and `Download PDF` buttons. If not, render nothing.

---

### 4.4 Competency Progress — `/portal/progress/`

**Data source:** `GET /api/v1/students/:id/competencies`

#### 4.4.1 Summary Bar

`12 competent · 4 in progress · 7 not started`

#### 4.4.2 `<CompetencyMatrix />` — 23 Tile Grid

| State | Visual |
|-------|--------|
| `not_started` | Grey tile, task name only |
| `taught` | Blue-50 border, "Taught" chip |
| `assessed` | Amber-50 border, "Assessed" chip |
| `competent` (auto) | Green fill, ✓ "Competent (A)" |
| `competent` (manual) | Green fill, ✓ "Competent (M)" |

Tiles with `blocked_by` array show a padlock icon + tooltip: "Complete task X first."

Mobile: 2 columns. Desktop: 4–5 columns.

**Transmission filter:** Segmented control (Auto / Manual / Both) when student has data for both. Default: student's primary `transmission`.

#### 4.4.3 Task Detail Drawer

Tapping a tile → slide-in drawer (or full page on mobile). Shows: task name, number, description, current status, transmission achieved, and a history table (lesson number, date, status change for each time the task appeared). Link to full lesson detail from each history row.

---

### 4.5 Payments — `/portal/payments/`

**Data sources:**
- `GET /api/v1/payments` — history
- `GET /api/v1/me/packages` — credit balances

**Package Credits Banner** (if active package exists):
```
🎟  10-Lesson Package · 2 credits left · Purchased 1 Jan 2026
```

**Payment list** (newest first, 10 per page with Load More): date, description, AUD amount, status badge, `Download Invoice` button.

**Invoice download:** `GET /api/v1/payments/:id/invoice` → PDF blob → object URL → `<a download>` trigger. Filename: `NexDrive-Invoice-{id_short}.pdf`. PDFs served via 15-minute signed R2 URLs.

---

### 4.6 Profile Management — `/portal/settings/`

**Data source:** `GET /api/v1/me` → `PATCH /api/v1/me`

**Editable fields:**

Contact: first name, last name, phone number, emergency contact name, emergency contact phone.

Licence: licence number, licence type (select: Learner / Provisional / Full), licence expiry date.

Learning: school or work (free text per Form 10.044). Transmission is read-only if lessons exist; show tooltip: "Contact your instructor to change this."

Email and avatar are managed via Clerk's `<UserProfile />` modal (opened via `Manage account` link).

**Form behaviour:** Zod validation on blur. Save button activates on dirty state. On save: `PATCH /api/v1/me` → optimistic update → toast "Profile updated". On error: inline error, form preserved.

---

### 4.7 Privacy Controls — `/portal/settings/privacy/`

**Data source / write:** `parent_student_links` fields via `PATCH /api/v1/students/:id/privacy`

**Schema note:** Six per-link boolean columns control what each parent sees: `can_view_progress`, `can_view_bookings`, `can_view_payments`, `can_view_lesson_notes`, `can_view_bridge_forms`, `can_book_lessons`. Top-level master switch: `students.parent_visibility`.

**Layout per linked parent:**

```
Sarah Harrison (Parent) — Active

  Progress (competency tracking)    [● ON]
  Bookings (upcoming lessons)       [● ON]
  Payment history                   [○ OFF]
  Lesson notes (comments)           [● ON]
  Bridge forms (post-lesson PDFs)   [● ON]
  Book lessons on my behalf         [○ OFF]
```

**Master kill-switch** at page top: "Share my progress with connected parents" → maps to `students.parent_visibility`. When OFF, all individual toggles grey out and parents see nothing.

**Save behaviour:** Toggle change calls `PATCH /api/v1/students/:id/privacy` (debounced 500ms) with body `{ link_id, field, value }`. Auto-dismiss "Saved" chip after 2 seconds.

**Info callout (always visible):**
> Your instructor's private coaching notes are never visible to you, your parents, or supervisors.

**Empty state:** If no linked parents: "You haven't connected any parents or supervisors yet. [Invite someone →]"

---

### 4.8 Parent Invitation — `/portal/settings/parents/`

**API endpoints:**
- List: inferred from `parent_student_links` via `/api/v1/students/:id` (parent links in response)
- Invite: `POST /api/v1/students/:id/invite-parent`

#### 4.8.1 Existing Links

List with: name, relationship, status badge (`Active` / `Pending` / `Revoked`), `Revoke access` button (sets `status = 'revoked'` via PATCH).

#### 4.8.2 Invite Form

Fields:
- Email address (required if no phone)
- Mobile number (required if no email; AU format: 04xx xxx xxx validated by Zod)
- Relationship (select: Parent / Guardian / Supervisor / Other)

On submit: `POST /api/v1/students/:id/invite-parent` → C18 sends invite SMS/email. Success message: "Invitation sent. They'll receive a link to create their account."

**Limit:** Max 5 linked parents. API enforces; surface as validation error.

---

### 4.9 Self-Assessment — `/portal/self-assessment/`

**Data source:** `GET /api/v1/students/:id/self-assessments`

**Active prompt card** (when review/pre-test lesson within 7 days):
```
📋 Self-Assessment Due
Complete before your lesson on 25 Feb
[Start self-assessment →]
```

**Past submissions list:** date + linked lesson, tap to view (read-only).

**Always-available** `[Start new self-assessment]` button.

The self-assessment form is the C24 component (SPEC-19), embedded here as a React component receiving `studentId` and optional `upcomingLessonId` as props. This spec does not define the form itself — refer to SPEC-19.

---

### 4.10 Bridge Forms — `/portal/bridge-forms/`

**Data source:** `GET /api/v1/students/:id/bridge-forms`

List (newest first): lesson number + date, skills covered summary, `View` button (web view), `Download PDF` button (signed R2 URL, browser download triggered via blob).

**Empty state:** "No bridge forms yet. These are generated by your instructor after each lesson."

---

### 4.11 Data Export — `/portal/export/`

**API endpoint:** `POST /api/v1/students/:id/export`

**Format options (checkboxes):** JSON | CSV

**Data scope checkboxes (all default ticked):**
- My profile
- Lesson history
- Competency records
- Booking history
- Payment history
- Bridge form links
- Self-assessments

**Always excluded (server-enforced, non-configurable):** Private notes, other students' data, audit log hashes.

**UX:** Small export → immediate browser download. Large export → "Your export is being prepared. We'll email it to you shortly."

**Rate limit:** 3 exports per 24 hours per student (Upstash Redis counter).

---

## 5. API Integration Reference

All calls via shared `apiFetch` wrapper that attaches Clerk session token:

```typescript
// lib/api/portal.ts
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = await getToken(); // Clerk
  const res = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });
  if (!res.ok) throw new ApiError(res.status, await res.json());
  return res.json() as T;
}
```

| Section | Endpoint | Method |
|---------|----------|--------|
| Dashboard – next booking | `/bookings/upcoming` | GET |
| Dashboard – progress | `/students/:id/progress` | GET |
| Dashboard – recent lessons | `/students/:id/lessons?limit=3` | GET |
| Dashboard – packages | `/me/packages` | GET |
| Bookings list | `/bookings?status=confirmed,pending` | GET |
| Booking detail | `/bookings/:id` | GET |
| Reschedule | `/bookings/:id` | PATCH |
| Cancel | `/bookings/:id/cancel` | POST |
| Availability | `/booking/availability` | GET |
| Reserve slot | `/booking/reserve` | POST |
| Confirm booking | `/booking/confirm` | POST |
| Lesson list | `/students/:id/lessons` | GET |
| Lesson detail | `/lessons/:id` | GET |
| Competency matrix | `/students/:id/competencies` | GET |
| Competency task names | `/competency-tasks` | GET |
| Payment list | `/payments` | GET |
| Invoice PDF | `/payments/:id/invoice` | GET |
| Package credits | `/me/packages` | GET |
| Profile get | `/me` | GET |
| Profile update | `/me` | PATCH |
| Privacy settings | `/students/:id/privacy` | PATCH |
| Parent list | (embedded in student record) | GET |
| Invite parent | `/students/:id/invite-parent` | POST |
| Self-assessments | `/students/:id/self-assessments` | GET |
| Bridge forms | `/students/:id/bridge-forms` | GET |
| Data export | `/students/:id/export` | POST |

---

## 6. Data Shapes (Frontend Types)

```typescript
// lib/api/types.ts

export interface UpcomingBooking {
  id: string;
  date: string;             // ISO date
  start_time: string;       // "09:00"
  end_time: string;
  duration_minutes: number;
  service_name: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
  can_reschedule: boolean;  // API-computed based on time-to-lesson
  can_cancel: boolean;
}

export interface LessonSummary {
  id: string;
  lesson_number: number;
  lesson_date: string;
  duration_minutes: number;
  competency_count: number;
  signature_status: 'draft' | 'instructor_signed' | 'both_signed';
  has_bridge_form: boolean;
}

export interface LessonDetail extends LessonSummary {
  location_suburb: string;
  instructor_name: string;
  comments: string;          // public only — private_notes NEVER included
  competencies_taught: CompetencyRef[];
  competencies_assessed: CompetencyRef[];
  competencies_achieved_auto: CompetencyRef[];
  competencies_achieved_manual: CompetencyRef[];
  student_signature?: SignatureSummary;
  instructor_signature?: SignatureSummary;
  bridge_form_id?: string;
}

export interface CompetencyStatus {
  task_number: number;
  task_name: string;
  category: string;
  status: 'not_started' | 'taught' | 'assessed' | 'competent';
  transmission: 'auto' | 'manual' | 'both';
  taught_at?: string;
  assessed_at?: string;
  achieved_at?: string;
  lesson_id?: string;
  can_assess: boolean;
  blocked_by: number[];
}

export interface CompetencyProgress {
  competencies: CompetencyStatus[];
  summary: {
    total: 23;
    competent: number;
    in_progress: number;
    not_started: number;
  };
}

export interface Payment {
  id: string;
  created_at: string;
  description: string;
  amount_cents: number;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  payment_method?: string;
}

export interface ParentLink {
  id: string;
  parent_name: string;
  relationship: 'parent' | 'guardian' | 'supervisor' | 'other';
  status: 'pending' | 'active' | 'revoked';
  can_view_progress: boolean;
  can_view_bookings: boolean;
  can_view_payments: boolean;
  can_view_lesson_notes: boolean;
  can_view_bridge_forms: boolean;
  can_book_lessons: boolean;
}

export interface BridgeFormSummary {
  id: string;
  lesson_id: string;
  lesson_number: number;
  lesson_date: string;
  skills_summary: string;
  pdf_url?: string;
  web_view_url: string;
}
```

---

## 7. State Management

SWR for all server data. No global state store needed. Cache keys follow `/api/v1/<endpoint>` convention to allow targeted revalidation.

```typescript
const swrConfig = {
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  dedupingInterval: 10_000,
  errorRetryCount: 3,
};
```

**Optimistic updates used for:** privacy toggle changes, profile field saves.

---

## 8. Error States & Loading Skeletons

Every data-dependent section must handle three states:

**Loading:** Skeleton cards (`animate-pulse`) matching loaded content shape to prevent layout shift.

**Error:** Inline callout with `Try again` button calling SWR `mutate()`.

**Empty state:** Friendly zero-state with contextual CTA (see individual sections).

**HTTP error codes:**
- 401 → redirect to Clerk sign-in
- 403 → "You don't have access to this"
- 404 → "This record no longer exists"
- 429 → "Too many requests — please wait a moment"
- 5xx → Sentry capture + "Something went wrong — please try again"

---

## 9. Notification Preferences

At `/portal/settings/` under a "Notifications" sub-section.

**Endpoint:** `GET /api/v1/me/notification-preferences` → `PATCH /api/v1/me/notification-preferences`

**Toggles (all default ON):**
- Booking confirmations (SMS + email)
- Lesson reminders (24h before, 2h before)
- Bridge form available
- Self-assessment reminder (before review lessons)
- Package credit low balance warning

Saved immediately on toggle (debounced 500ms, same pattern as privacy controls).

---

## 10. Security & Privacy Guardrails (Non-Negotiable)

1. **Private notes:** Never requested by portal. No component renders instructor-private fields. `LessonDetail` response shape excludes `private_notes` at the API service layer.

2. **Own data only:** API resolves `student_id` from authenticated `clerk_user_id`. Mismatched `student_id` in URL → 403. Backend enforces this regardless of frontend construction.

3. **Export rate limiting:** `POST /api/v1/students/:id/export` limited to 3 per 24h via Upstash Redis.

4. **Invoice PDF access:** Validated to belong to requesting student. Served via 15-minute signed R2 URLs — not public URLs.

5. **Bridge form access:** Same signed URL pattern. Only returns forms for authenticated student.

6. **Parent invitation:** Invite token expires in 24h. Parent must create Clerk account to accept. Student confirmation screen before link activates.

---

## 11. Accessibility Requirements

- All interactive elements keyboard-reachable (logical Tab order)
- All icons have `aria-label` or visible adjacent text
- Colour is never the sole status indicator — badges always include text
- `aria-live` regions on save confirmations and error messages
- Minimum touch target: 44×44px on mobile
- WCAG 2.1 AA contrast ratios throughout (use TailwindCSS colour tokens that pass)

---

## 12. Testing Requirements

**Unit tests (Vitest):**
- `<CompetencyRing />` renders correct arc fill for various `competent/23` inputs
- `<CompetencyMatrix />` renders 23 tiles; locked tiles show padlock; competent tiles show checkmark
- `<PrivacyToggleRow />` calls correct endpoint on change
- `apiFetch` attaches auth token; throws `ApiError` on non-2xx

**Integration tests (Playwright):**
- Student signs in via Clerk and lands on dashboard
- Dashboard shows next lesson card when booking exists
- Competency matrix renders 23 tiles with correct states
- Cancel booking modal appears and calls cancel endpoint
- Privacy toggle persists after page reload
- Parent invite form validates AU mobile format and email

**E2E happy path:**
1. Sign in → dashboard
2. Book new lesson through booking widget
3. View lesson history (seed data required)
4. Download invoice PDF
5. Toggle parent visibility setting
6. Invite parent by email
7. Export data as JSON → verify download triggers

---

## 13. Build Priority Within This Spec

| Priority | Section | Rationale |
|----------|---------|-----------|
| 1 | Portal shell + auth guard | Unblocks all other pages |
| 2 | Dashboard | Most-visited; validates API integration |
| 3 | Competency progress matrix | Core student value prop |
| 4 | Lesson history + detail | Completes CBT&A Phase 3 loop |
| 5 | Bookings (view + cancel) | Reduces admin workload |
| 6 | Book new lesson (C02 embed) | Revenue touchpoint |
| 7 | Payments + invoice download | Financial transparency |
| 8 | Profile management | Basic hygiene |
| 9 | Privacy controls + parent invite | Prerequisite for Parent Resource Center (C16) |
| 10 | Bridge form access | Requires C25 complete |
| 11 | Self-assessment integration | Requires SPEC-19 complete |
| 12 | Data export | Nice-to-have; lowest risk if delayed |

---

## 14. Dependencies & Completion Checklist

Pre-requisites for full build:
- [ ] SPEC-01 — all 26 tables in Neon
- [ ] SPEC-02 — Clerk `student` role in metadata; webhook syncing `profiles`
- [ ] SPEC-03 — booking API routes live
- [ ] SPEC-04 — payment records + invoice PDF generation working
- [ ] SPEC-05 — `students` and `parent_student_links` writable via API
- [ ] SPEC-13 — competency matrix API returning 23-task data
- [ ] SPEC-15 — lesson records with signature data
- [ ] SPEC-16 — bridge form generation + PDFs in R2

Feature-specific dependencies:
- [ ] SPEC-19 (Self-Assessment) — for Section 4.9
- [ ] C25 (Bridge Form Generator) — for Section 4.10

---

*SPEC-17 v1.0 — NexDrive Academy — BMAD Phase 5*  
*22 February 2026*
