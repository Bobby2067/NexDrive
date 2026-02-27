# SPEC-18: Parent Resource Center (C16)
**NexDrive Academy — Component Specification**
**Phase:** 4 (Portals) — Weeks 21–28
**Status:** Ready for build
**Depends on:** SPEC-01 (DB Schema), SPEC-02 (Auth/RBAC), SPEC-03 (Booking Engine / C08), SPEC-05 (CRM / C09), SPEC-07 (Notification Engine / C18), SPEC-16 (Lesson Bridge Forms / C25), SPEC-17 (Student Portal / C03)
**Referenced by:** SPEC-17 (Student Portal — student controls parent access)

---

## 1. Purpose

The Parent Resource Center gives supervising drivers — parents, guardians, and other linked supervisors — a dedicated, privacy-respecting window into their learner's progress. It is NOT a secondary version of the student portal. Its purpose is to:

1. Keep parents informed enough to provide effective supervised practice
2. Deliver post-lesson bridge forms so practice sessions are targeted and safe
3. Allow parents to book lessons on behalf of a student (when permitted)
4. Provide coaching resources that help parents supervise confidently
5. Respect student privacy controls — every data point is gated by `parent_student_links` permissions, and if a student revokes access, data vanishes immediately

---

## 2. Authentication & RBAC

### 2.1 Clerk Configuration

The parent role is enforced via Clerk's custom session claims (as defined in SPEC-02). The claim shape is:

```typescript
// Clerk session claim — set via Clerk webhook on profile sync
{
  "nexdrive_role": "parent",
  "nexdrive_profile_id": "<uuid>"
}
```

All parent routes are protected by Next.js middleware that:
1. Checks `auth().sessionClaims?.nexdrive_role === 'parent'`
2. Redirects unauthenticated users to Clerk's hosted sign-in (`/sign-in`)
3. Returns 403 for authenticated non-parent roles

```typescript
// src/middleware.ts (parent route guard — excerpt)
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isParentRoute = createRouteMatcher(['/parent(.*)']);

export default clerkMiddleware(async (auth, req) => {
  if (isParentRoute(req)) {
    const { sessionClaims } = await auth();
    if (!sessionClaims || sessionClaims.nexdrive_role !== 'parent') {
      return Response.redirect(new URL('/sign-in', req.url));
    }
  }
});
```

### 2.2 Invitation Acceptance Flow

Parents cannot self-register as parents — they must be invited by the instructor (via C09 CRM) or by the student (via C03 Student Portal). The flow is:

**Step 1 — Instructor/student sends invite**
- `POST /api/parents/invite` — creates `parent_student_links` row with `status: 'pending'`
- Sets `invited_at = NOW()`, generates a signed invite token (JWT, 7-day expiry, contains `link_id`)
- Triggers C18 notification: invite email to parent's email address

**Step 2 — Parent receives email**
- Email contains a link: `https://nexdrive.com.au/parent/accept-invite?token=<jwt>`
- Link is valid for 7 days; expired tokens return a user-friendly error with option to request a new invite

**Step 3 — Accept invite page** (`/parent/accept-invite`)
- Decodes and validates JWT; extracts `link_id`
- If parent already has a Clerk account (email match): prompt sign-in → auto-accept on sign-in
- If new to NexDrive: render Clerk's `<SignUp />` with `emailAddress` pre-filled from token; after sign-up, webhook fires, profile created with role `parent`, link activated
- On success: `PATCH /api/parents/links/:linkId` → `{ status: 'active', accepted_at: NOW() }`

**Step 4 — Redirect to dashboard**
- Redirect to `/parent` with success toast: "You're now connected to [student name]"

### 2.3 Privacy Enforcement — Non-Negotiable

Every API endpoint that returns student data must:

1. Look up `parent_student_links` for the requesting parent ID and the target student ID
2. Check `link.status === 'active'` — pending or revoked links get 404 (do not reveal student existence)
3. Check the specific permission flag for the data being requested (e.g. `can_view_progress`)
4. Also check `students.parent_visibility === true` — student's master privacy toggle

If ANY of these checks fail, return 404 (not 403 — do not confirm the student exists to a revoked parent).

```typescript
// src/lib/parent-auth.ts — reusable guard
export async function getParentLinkOrThrow(
  parentClerkId: string,
  studentId: string,
  requiredPermission: keyof ParentPermissions
): Promise<ParentStudentLink> {
  const link = await db.query.parentStudentLinks.findFirst({
    where: and(
      eq(parentStudentLinks.studentId, studentId),
      inArray(
        parentStudentLinks.parentId,
        db.select({ id: parents.id }).from(parents).where(eq(parents.userId, parentClerkId))
      ),
      eq(parentStudentLinks.status, 'active')
    ),
    with: { student: true }
  });

  if (!link || !link.student.parentVisibility || !link[requiredPermission]) {
    throw new NotFoundError('Student not found');
  }

  return link;
}
```

---

## 3. Route Structure

```
/parent                             → Dashboard (multi-student aware)
/parent/[studentId]                 → Student-specific view (if >1 student linked)
/parent/[studentId]/progress        → CBT&A progress + logbook hours
/parent/[studentId]/bookings        → Upcoming + past lessons
/parent/[studentId]/bookings/new    → Book a lesson (if can_book_lessons)
/parent/[studentId]/bridge-forms    → List of bridge forms
/parent/[studentId]/bridge-forms/[formId] → Individual bridge form view
/parent/resources                   → Resource library (not student-specific)
/parent/settings                    → Notification preferences
/parent/accept-invite               → Invitation acceptance flow
```

All routes under `/parent/[studentId]/*` are `layout.tsx` scoped — the layout fetches the parent's linked students once and passes the active student context to all child routes. If the parent is linked to only one student, `[studentId]` is resolved automatically and the student picker is hidden.

---

## 4. File Structure

```
src/app/parent/
├── layout.tsx                          # Auth guard + student context provider
├── page.tsx                            # Dashboard (redirects to /[studentId] if >1 student)
├── accept-invite/
│   └── page.tsx                        # Invitation acceptance flow
├── resources/
│   └── page.tsx                        # Static resource library
├── settings/
│   └── page.tsx                        # Notification preferences
└── [studentId]/
    ├── layout.tsx                      # Student-scoped layout + nav
    ├── page.tsx                        # Student dashboard
    ├── progress/
    │   └── page.tsx                    # Progress + competency breakdown
    ├── bookings/
    │   ├── page.tsx                    # Booking list
    │   └── new/
    │       └── page.tsx                # Booking form
    └── bridge-forms/
        ├── page.tsx                    # Bridge form list
        └── [formId]/
            └── page.tsx               # Bridge form detail

src/app/api/parents/
├── me/
│   └── route.ts                        # GET — parent profile + linked students
├── invite/
│   └── route.ts                        # POST — create invite
├── links/
│   └── [linkId]/
│       └── route.ts                    # PATCH — accept invite
└── students/
    └── [studentId]/
        ├── summary/
        │   └── route.ts                # GET — dashboard data
        ├── progress/
        │   └── route.ts                # GET — CBT&A + logbook
        ├── bookings/
        │   ├── route.ts                # GET — booking list / POST — create booking
        │   └── [bookingId]/
        │       └── route.ts            # GET — booking detail
        └── bridge-forms/
            ├── route.ts                # GET — bridge form list
            └── [formId]/
                └── route.ts            # GET — bridge form detail + PDF URL

src/components/parent/
├── StudentSwitcher.tsx
├── ProgressCard.tsx
├── CompetencyGrid.tsx
├── BookingCard.tsx
├── BridgeFormCard.tsx
├── BridgeFormViewer.tsx
├── ResourceCard.tsx
├── NotificationSettings.tsx
└── InviteAcceptFlow.tsx
```

---

## 5. API Endpoints

### 5.1 `GET /api/parents/me`

Returns the authenticated parent's profile and all active linked students.

**Response:**
```typescript
{
  parent: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
  };
  linkedStudents: Array<{
    studentId: string;
    firstName: string;
    lastName: string;
    status: 'active' | 'inactive' | 'completed';
    relationship: 'parent' | 'guardian' | 'supervisor' | 'other';
    permissions: {
      canViewProgress: boolean;
      canViewBookings: boolean;
      canViewPayments: boolean;
      canViewLessonNotes: boolean;
      canViewBridgeForms: boolean;
      canBookLessons: boolean;
    };
  }>;
}
```

**Implementation:**
```typescript
// GET /api/parents/me
export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return unauthorized();

  const parent = await db.query.parents.findFirst({
    where: eq(parents.userId, userId),
    with: {
      profile: true,
      studentLinks: {
        where: eq(parentStudentLinks.status, 'active'),
        with: {
          student: {
            with: { profile: true }
          }
        }
      }
    }
  });

  if (!parent) return notFound();

  // Filter out students who have revoked parentVisibility
  const activeLinks = parent.studentLinks.filter(
    link => link.student.parentVisibility
  );

  return json({ parent: formatParent(parent), linkedStudents: formatLinks(activeLinks) });
}
```

---

### 5.2 `GET /api/parents/students/:studentId/summary`

Dashboard summary for one linked student.

**Permission check:** `can_view_progress` OR `can_view_bookings` (returns only permitted sections)

**Response:**
```typescript
{
  student: {
    firstName: string;
    lastName: string;
    status: string;
    enrollmentDate: string;
    estimatedTestDate: string | null;
    totalHours: number;
    nightHours: number;
  };
  progress: {              // null if !can_view_progress
    completedTasks: number;
    totalTasks: 23;
    percentComplete: number;
  } | null;
  upcomingLesson: {        // null if !can_view_bookings
    date: string;
    startTime: string;
    durationMinutes: number;
    suburb: string | null;
  } | null;
  recentBridgeForms: Array<{  // null if !can_view_bridge_forms
    id: string;
    lessonDate: string;
    lessonNumber: number;
    skillsCoveredCount: number;
  }> | null;
}
```

---

### 5.3 `GET /api/parents/students/:studentId/progress`

**Permission check:** `can_view_progress`

**Response:**
```typescript
{
  logbook: {
    totalHours: number;
    nightHours: number;
    professionalHours: number;
  };
  competencies: {
    taskNumber: number;
    taskName: string;
    category: string;
    status: 'not_started' | 'in_progress' | 'competent';
    lastAttemptDate: string | null;
  }[];
  summary: {
    total: 23;
    notStarted: number;
    inProgress: number;
    competent: number;
    percentComplete: number;
  };
}
```

**Important:** `student_competencies` rows with `status = 'not_competent'` are shown as `in_progress`. The raw competency status strings (and any instructor comments in competency rows) are never exposed to parents.

---

### 5.4 `GET /api/parents/students/:studentId/bookings`

**Permission check:** `can_view_bookings`

Returns upcoming and recent past bookings (limit: 10 past, all upcoming).

**Response:**
```typescript
{
  upcoming: Booking[];
  recent: Booking[];   // last 10 completed
}

type Booking = {
  id: string;
  lessonDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  serviceType: string;
  status: 'confirmed' | 'completed' | 'cancelled';
  suburb: string | null;
};
```

**Note:** Payment amounts are NOT included in this response even if `can_view_payments` is true — payments require a separate endpoint and are not on the MVP parent portal scope.

---

### 5.5 `POST /api/parents/students/:studentId/bookings`

**Permission check:** `can_book_lessons`

Books a lesson on behalf of the linked student. Uses the same booking engine (C08) as the student portal — same validation, same slot locking via Upstash Redis.

**Request body:** Identical to student portal booking — see SPEC-03 (Booking Engine API).

**Additional step:** After creating the booking via C08, fire a notification (C18) to the student informing them a booking was made on their behalf, including parent name.

**Response:** `{ bookingId: string; confirmationCode: string }`

---

### 5.6 `GET /api/parents/students/:studentId/bridge-forms`

**Permission check:** `can_view_bridge_forms`

**Response:**
```typescript
{
  forms: Array<{
    id: string;
    lessonDate: string;
    lessonNumber: number;
    skillsCovered: Array<{
      taskNumber: number;
      taskName: string;
      status: 'taught' | 'assessed' | 'competent';
    }>;
    hasPositives: boolean;
    hasPracticeInstructions: boolean;
    createdAt: string;
  }>;
}
```

---

### 5.7 `GET /api/parents/students/:studentId/bridge-forms/:formId`

**Permission check:** `can_view_bridge_forms`

Returns full bridge form content plus a pre-signed R2 URL for the PDF.

**Response:**
```typescript
{
  id: string;
  lessonDate: string;
  lessonNumber: number;
  studentName: string;
  instructorName: string;
  skillsCovered: Array<{
    taskNumber: number;
    taskName: string;
    category: string;
    status: 'taught' | 'assessed' | 'competent';
  }>;
  positives: string | null;
  practiceInstructions: string | null;
  focusAreas: string | null;
  nextLessonRecommendation: string | null;
  pdfUrl: string;          // Pre-signed R2 URL, 1-hour expiry
  createdAt: string;
}
```

**CRITICAL:** `lesson_bridge_forms.is_visible_to_parent` must be `true` in addition to the link permission check, otherwise 404.

---

### 5.8 `GET /api/parents/settings`

Returns parent's notification preferences.

**Response:**
```typescript
{
  preferences: {
    lessonReminders: boolean;
    bridgeFormReady: boolean;
    bookingConfirmations: boolean;
    progressMilestones: boolean;
    communicationChannel: 'email' | 'sms' | 'both';
  };
}
```

### 5.9 `PATCH /api/parents/settings`

Updates notification preferences. Calls C18's preference update endpoint internally.

---

## 6. UI Screens

### 6.1 Dashboard (`/parent` or `/parent/[studentId]`)

**Layout:** Two-column on desktop (sidebar nav + content); single column on mobile.

**Sidebar:**
- NexDrive logo
- Student switcher (only if >1 student linked; shows student name + avatar/initials)
- Nav links: Overview, Progress, Lessons, Bridge Forms, Resources
- Settings link at bottom
- Clerk `<UserButton />` for account/sign-out

**Main content — Dashboard cards (responsive grid):**

```
┌──────────────────────┬──────────────────────┐
│   Progress Summary   │   Next Lesson        │
│   18/23 tasks ✓      │   Tue 25 Feb 9:00am  │
│   ████████░░ 78%     │   60 min · Braddon   │
└──────────────────────┴──────────────────────┘
┌──────────────────────────────────────────────┐
│   Recent Bridge Forms                         │
│   Lesson 14 — 20 Feb   [View] [Download PDF] │
│   Lesson 13 — 12 Feb   [View] [Download PDF] │
└──────────────────────────────────────────────┘
```

**Empty states:**
- No student linked: "You haven't been connected to a student yet. Ask your student or their instructor to send you an invitation."
- Access revoked: Do NOT show "access revoked" — silently show the empty state above (same as not linked)

---

### 6.2 Progress Screen (`/parent/[studentId]/progress`)

Two sections:

**Logbook Hours:**
```
Total Hours:         42.5 hrs  ████████████░░░░ (target: 100hrs)
Night Hours:          4.0 hrs  ████░░░░░░░░░░░░ (target: 10hrs)
Professional Hours:   0.0 hrs
```

**Competency Grid:**
23 tasks displayed as a colour-coded grid (matching the student portal's visual language but read-only for parents):
- Grey = Not started
- Yellow/Amber = In progress
- Green = Competent

Clicking a task shows a tooltip with the task name and a plain-English description from `competency_tasks.description`. No raw assessment data, no instructor comments.

Category groupings (from `competency_tasks.category`) used as section headers.

---

### 6.3 Lessons Screen (`/parent/[studentId]/bookings`)

**Upcoming lessons** at top (highlight card style — prominent date, time, duration).

**Book a lesson button** — visible only if `can_book_lessons === true`. Opens booking flow (see §6.4).

**Past lessons table:**
| Date | Duration | Status |
|------|----------|--------|
| 20 Feb 2026 | 60 min | Completed |
| 12 Feb 2026 | 90 min | Completed |

Note: No lesson notes or competency details here — that's in bridge forms.

---

### 6.4 Book a Lesson (`/parent/[studentId]/bookings/new`)

Reuses the booking widget (C02) component, pre-populated with the linked student's details.

**Key differences from public booking widget:**
- Student fields are pre-filled and non-editable
- Payment is handled the same as student portal (existing packages, credit card)
- On confirmation, an SMS/email is sent to the **student** notifying them of the parent booking
- Header shows: "Booking a lesson for [Student Name]"

If `can_book_lessons` is `false`, this route returns 403 and the parent sees: "Your student hasn't enabled lesson booking for your account. Ask [student name] to update their privacy settings."

---

### 6.5 Bridge Forms Screen (`/parent/[studentId]/bridge-forms`)

List of all available bridge forms, newest first.

Each card shows:
- Lesson date and number
- Skills covered count (e.g. "3 skills covered")
- "View" button → opens detail view
- "Download PDF" button → opens pre-signed R2 PDF URL in new tab

If `can_view_bridge_forms === false`: Show placeholder: "Bridge form access hasn't been enabled for your account."

---

### 6.6 Bridge Form Detail (`/parent/[studentId]/bridge-forms/[formId]`)

Full-page view of a single bridge form. Matches the PDF layout so parents can read online or print.

**Sections:**
1. **Header** — NexDrive logo, student name, instructor name, lesson date, lesson number
2. **Skills Covered** — list of competency tasks with status badges
3. **What Went Well** — `positives` field (shown only if non-null)
4. **Practice Instructions** — `practice_instructions` field (most important section — large text)
5. **Focus Areas** — `focus_areas` field
6. **Next Lesson Focus** — `next_lesson_recommendation` field
7. **Download PDF** — button linking to pre-signed R2 URL

---

### 6.7 Resource Library (`/parent/resources`)

Static content — not student-specific. No permission checks beyond parent auth.

**Categories:**
- **Supervising Practice** — guides on how to conduct supervised sessions safely; ACT road rules summary
- **CBT&A Explainer** — what the 23 competency tasks mean; what "competent" looks like; the test process
- **Practice Tips** — low-traffic times, how to give feedback, how to debrief
- **Downloadable PDFs** — practice session log template, ACT road rules quick reference

**Implementation:** Content stored as MDX files in `src/content/parent-resources/`. Categories are directory-based. PDFs stored in R2 at `public/resources/*.pdf`.

**No dynamic data needed** — this page is fully static. Use `generateStaticParams` + ISR with 24-hour revalidation.

---

### 6.8 Notification Settings (`/parent/settings`)

Simple preferences form:

```
Notification Preferences
─────────────────────────────────────────────
[✓] Lesson reminders (24h + 2h before)
[✓] Bridge form ready after each lesson
[✓] Booking confirmations
[  ] Progress milestones (e.g. competency achieved)

Preferred channel:
( ) Email only
(●) SMS only
( ) Both email and SMS

[Save Preferences]
```

On save: `PATCH /api/parents/settings`

---

## 7. Invitation Acceptance Flow (UI)

Route: `/parent/accept-invite?token=<jwt>`

**States:**

**1 — Loading:** Decode token → show spinner

**2 — Token invalid/expired:**
```
This invitation has expired.
Please ask your student or their instructor to send a new invitation.
[Contact Instructor]
```

**3 — Already accepted (link is active):**
```
You're already connected to [student name].
[Go to Dashboard →]
```

**4 — Sign-in required (email matches existing Clerk account):**
```
You've been invited to track [student name]'s progress.
Sign in to your existing NexDrive account to accept.
[Sign In]
```
After sign-in, middleware detects the pending token in the session cookie, calls `PATCH /api/parents/links/:linkId` automatically, and redirects to `/parent`.

**5 — New user (no existing account):**
```
[student name] has invited you to track their driving progress.
Create your NexDrive account to get started.
[NexDrive logo]
[Clerk <SignUp /> component — email pre-filled]
```
After sign-up → Clerk webhook creates profile with `role: 'parent'` → link activated → redirect to `/parent`.

---

## 8. Multi-Student Support

When a parent is linked to more than one active student:

- Dashboard (`/parent`) shows a **student picker** before any student-specific content
- After selecting a student, the URL becomes `/parent/[studentId]` and all sub-navigation is scoped to that student
- The sidebar permanently shows a `StudentSwitcher` component displaying all linked students as avatars/initials with names
- Switching students changes the `[studentId]` param — no page reload needed (Next.js client navigation)
- Notification settings apply per-parent (not per-student)

**StudentSwitcher component:**
```tsx
// src/components/parent/StudentSwitcher.tsx
// Renders as a dropdown or tab strip depending on student count
// < 4 students: tab strip
// ≥ 4 students: dropdown select
```

---

## 9. Privacy — Detailed Enforcement Matrix

| Data Point | DB Permission Flag | Additional Check |
|---|---|---|
| Progress + competencies | `can_view_progress` | `students.parent_visibility` |
| Upcoming/past bookings | `can_view_bookings` | `students.parent_visibility` |
| Book a lesson | `can_book_lessons` | `students.parent_visibility` |
| Bridge forms (list) | `can_view_bridge_forms` | `students.parent_visibility` + `lesson_bridge_forms.is_visible_to_parent` |
| Bridge form (detail) | `can_view_bridge_forms` | Same as above |
| Logbook hours | `can_view_progress` | `students.parent_visibility` |
| Payment history | Not surfaced in MVP | — |
| Lesson notes/comments | Never exposed | Permanently excluded from all parent API response shapes |
| Private notes | Never exposed | Excluded by design — not even queried |

**Response shape discipline:** Create separate TypeScript response types for parent API responses that structurally cannot include lesson notes or private notes. Do not filter at the call site — exclude at the type level so the compiler catches any accidental inclusion.

```typescript
// src/lib/types/parent-responses.ts
// These types must NOT include: lessonNotes, comments, privateNotes, internalComments
export type ParentProgressResponse = { ... };
export type ParentBridgeFormResponse = { ... };
// etc.
```

---

## 10. Component Specifications

### `StudentSwitcher`

```typescript
interface StudentSwitcherProps {
  students: { id: string; firstName: string; lastName: string; avatarUrl?: string }[];
  activeStudentId: string;
  onSwitch: (studentId: string) => void;
}
```

Renders as tab strip (≤3 students) or combobox (≥4 students).

### `ProgressCard`

```typescript
interface ProgressCardProps {
  competent: number;
  inProgress: number;
  notStarted: number;
  totalHours: number;
}
```

Shows circular progress ring + summary text. Clicking navigates to `/parent/[studentId]/progress`.

### `CompetencyGrid`

```typescript
interface CompetencyGridProps {
  competencies: Array<{
    taskNumber: number;
    taskName: string;
    category: string;
    status: 'not_started' | 'in_progress' | 'competent';
  }>;
  readOnly: true; // Always true for parent view
}
```

Grid is always read-only. Tooltip on hover shows task name and category description. No click-to-expand detail (that's the student portal behaviour).

### `BridgeFormCard`

```typescript
interface BridgeFormCardProps {
  form: {
    id: string;
    lessonDate: string;
    lessonNumber: number;
    skillsCoveredCount: number;
    hasPracticeInstructions: boolean;
  };
  studentId: string;
}
```

Renders as a card with lesson info and two action buttons: View and Download PDF.

### `NotificationSettings`

```typescript
interface NotificationSettingsProps {
  initial: NotificationPreferences;
  onSave: (prefs: NotificationPreferences) => Promise<void>;
}

type NotificationPreferences = {
  lessonReminders: boolean;
  bridgeFormReady: boolean;
  bookingConfirmations: boolean;
  progressMilestones: boolean;
  communicationChannel: 'email' | 'sms' | 'both';
};
```

---

## 11. Responsive Design

**Desktop (≥1024px):**
- Sidebar navigation (240px fixed width) + main content area
- Dashboard uses 2-column card grid
- Bridge form detail renders as full-width readable content (max-width 720px, centred)

**Tablet (768–1023px):**
- Sidebar collapses to icon-only rail (48px)
- Dashboard uses 2-column grid
- StudentSwitcher shows as top tabs

**Mobile (<768px):**
- Sidebar replaced with bottom navigation bar (4 icons: Overview, Progress, Lessons, Bridge Forms)
- Dashboard single column
- StudentSwitcher shows as horizontal scroll tab strip above content
- Bridge form PDF download button is full-width CTA

**Design tokens:** Use the same NexDrive TailwindCSS theme as the Student Portal (C03) and public website (C01) for visual consistency.

---

## 12. Data Loading Strategy

| Route | Strategy | Rationale |
|---|---|---|
| `/parent` | Server Component + React Suspense | Initial data fetch at server, fast TTFB |
| `/parent/[studentId]` | Server Component | Student context loaded once in layout |
| `/parent/[studentId]/progress` | Server Component | No user interaction — pure read |
| `/parent/[studentId]/bookings` | Server Component + client SWR for upcoming | Upcoming lessons need near-real-time accuracy |
| `/parent/[studentId]/bridge-forms` | Server Component | Static list with pagination |
| `/parent/[studentId]/bridge-forms/[formId]` | Server Component | Pre-signed URL generated server-side |
| `/parent/resources` | Static (ISR 24h) | Purely static content |
| `/parent/settings` | Client Component | Form state management |

---

## 13. Error States

| Scenario | UX |
|---|---|
| Student revokes parent access | All student-specific pages silently show "student not found" state; dashboard shows empty state with invite prompt |
| Student disables `parent_visibility` | Same as above |
| Invite token expired | Clear message + "contact instructor" button |
| Booking fails (slot taken) | Inline error in booking form; suggest next available slot |
| Bridge form PDF generation in progress | Show "PDF generating..." spinner; auto-refresh every 10s |
| Network error | Standard error boundary with retry button |

---

## 14. Testing Checklist

Before marking SPEC-18 complete, verify:

- [ ] Parent cannot view any student data without an active link
- [ ] Revoking `parent_student_links.status` immediately hides all student data (no caching)
- [ ] Setting `students.parent_visibility = false` hides data regardless of link status
- [ ] Each permission flag (`can_view_progress`, `can_book_lessons`, etc.) independently gates its endpoint
- [ ] Lesson notes and private notes are confirmed absent from all parent API responses (type-level + integration test)
- [ ] Booking on behalf correctly notifies the student
- [ ] Invite token expires after 7 days
- [ ] Multi-student parent sees correct data for each student independently
- [ ] Bridge form PDF URL is pre-signed (not a permanent public URL)
- [ ] Mobile layout is functional with no horizontal scroll on 375px viewport
- [ ] Invite acceptance works for both new and existing Clerk users

---

## 15. Dependencies Not Yet Built (at time of this spec)

This spec assumes the following are complete and available when C16 is built (Phase 4):

| Dependency | Spec | Status at Phase 4 |
|---|---|---|
| DB Schema (all tables) | SPEC-01 | ✅ Phase 0 |
| Auth & RBAC (Clerk, parent role, session claims) | SPEC-02 | ✅ Phase 0 |
| Booking Engine API | SPEC-03 | ✅ Phase 1 |
| CRM (parent invite flow) | SPEC-05 | ✅ Phase 1 |
| Notification Engine | SPEC-07 | ✅ Phase 1 |
| Bridge Form Generator | SPEC-16 | ✅ Phase 3 |
| Student Portal (shared components) | SPEC-17 | ✅ Phase 4 (concurrent) |

---

*SPEC-18: Parent Resource Center — NexDrive Academy*
*Version 1.0 — 22 February 2026*
*Generated by BMAD Technical Architect Agent*
