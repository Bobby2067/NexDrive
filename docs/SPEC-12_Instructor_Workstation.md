# SPEC-12: Instructor Workstation (C11)

**NexDrive Academy | Phase 3 — Digitise the Paperwork**  
**Version:** 1.0  
**Date:** February 2026  
**Status:** Ready for Implementation  
**BMAD Phase:** 5 — Component Spec  
**Depends On:** SPEC-01 (Database Schema), SPEC-02 (Auth/RBAC), SPEC-03 (Booking Engine API), SPEC-04 (Payment Engine), SPEC-12 feeds into C12 (CBT&A Engine), C13 (E-Signature), C14 (Audit Trail), C15 (Private Notes), C25 (Bridge Forms)

---

## 1. Purpose & Scope

The Instructor Workstation is a Progressive Web App (PWA) used exclusively by Rob (and future instructors) during and immediately after driving lessons. It replaces paper Form 10.044 with a digital, audit-compliant lesson record that can be completed in under 90 seconds.

**Primary user:** Rob Harrison, driving instructor, iPhone 12+ in a car.  
**Secondary user:** Future instructors on same device class.  
**Context:** Poor or no mobile data connectivity in outer Canberra suburbs. Device may be shared briefly with student for e-signature capture.

**What this spec covers:**
- PWA shell, manifest, service worker
- Bottom tab navigation (5 tabs)
- Today view (schedule + alerts)
- Lesson recording form (Form 10.044)
- Signature capture UI
- Student detail view
- Private notes UI
- Offline strategy (IndexedDB + Background Sync)
- Cancellation/change polling
- Performance targets

**What this spec does NOT cover:**
- CBT&A business logic (see SPEC-XX: C12)
- E-signature hash chain verification (see SPEC-XX: C13)
- Audit log writes (handled by API layer per SPEC-XX: C14)
- Lesson Bridge Form generation (see SPEC-XX: C25)
- Admin-level features

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Instructor iPhone (PWA — installed to home screen)          │
│                                                             │
│  ┌──────────────┐  ┌──────────────────────────────────────┐ │
│  │ React App    │  │ Service Worker                       │ │
│  │ (App Router) │  │                                      │ │
│  │              │  │  - Cache: app shell, static assets   │ │
│  │  Today View  │  │  - Cache: today's bookings (daily)   │ │
│  │  Record Form │  │  - Cache: student competency maps    │ │
│  │  Student View│  │  - Queue: lesson records (offline)   │ │
│  │  Notes       │  │  - Queue: signatures (offline)       │ │
│  │  Settings    │  │  - Background Sync on reconnect      │ │
│  └──────┬───────┘  └────────────────────────────────────┬─┘ │
│         │                                               │   │
│  ┌──────▼───────────────────────────────────────────────▼─┐ │
│  │ IndexedDB (idb-keyval / Dexie.js)                      │ │
│  │  Stores: todayBookings, studentProfiles, draftLessons, │ │
│  │          pendingLessons, pendingSignatures, notesDrafts │ │
│  └────────────────────────────────────────────────────────┘ │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTPS (when online)
                ┌───────────▼──────────────┐
                │ Next.js API Routes       │
                │ /api/workstation/*       │
                └───────────┬──────────────┘
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
           Neon DB      Clerk Auth     Cloudflare R2
         (lessons,      (JWT verify)  (signature images)
          bookings,
          students)
```

**Tech decisions for this component:**
- Framework: Next.js 14 App Router (same codebase, dedicated `/workstation` route group)
- Offline library: Dexie.js (IndexedDB wrapper — better TypeScript support than raw idb)
- Service Worker: Workbox (via `next-pwa` or custom Workbox config)
- Signature canvas: `react-signature-canvas` (touch + stylus + mouse)
- State: Zustand (lightweight, offline-safe)
- Polling: React Query with `refetchInterval` + Workbox Background Sync for mutations

---

## 3. PWA Configuration

### 3.1 Manifest (`/public/manifest.json`)

```json
{
  "name": "NexDrive Workstation",
  "short_name": "NexDrive",
  "description": "NexDrive Academy instructor lesson recording",
  "start_url": "/workstation",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "categories": ["education", "productivity"],
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ],
  "screenshots": [
    { "src": "/screenshots/today.png", "sizes": "390x844", "type": "image/png", "form_factor": "narrow" }
  ]
}
```

### 3.2 Service Worker Strategy (Workbox)

```typescript
// workstation-sw.ts — registered at /workstation-sw.js

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { BackgroundSyncPlugin } from 'workbox-background-sync';
import { ExpirationPlugin } from 'workbox-expiration';

// App shell — precached at build time
precacheAndRoute(self.__WB_MANIFEST);

// Today's bookings — NetworkFirst (stale fallback if offline)
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/workstation/today'),
  new NetworkFirst({
    cacheName: 'today-bookings',
    plugins: [new ExpirationPlugin({ maxAgeSeconds: 24 * 60 * 60 })]
  })
);

// Student profiles + competency maps — StaleWhileRevalidate
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/workstation/students'),
  new StaleWhileRevalidate({
    cacheName: 'student-profiles',
    plugins: [new ExpirationPlugin({ maxAgeSeconds: 7 * 24 * 60 * 60, maxEntries: 50 })]
  })
);

// Competency task definitions — CacheFirst (rarely changes)
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/workstation/tasks'),
  new CacheFirst({
    cacheName: 'competency-tasks',
    plugins: [new ExpirationPlugin({ maxAgeSeconds: 30 * 24 * 60 * 60 })]
  })
);

// Lesson submission — Background Sync queue (POST only)
const lessonSyncPlugin = new BackgroundSyncPlugin('lesson-sync-queue', {
  maxRetentionTime: 48 * 60 // 48 hours in minutes
});
registerRoute(
  ({ url, request }) => url.pathname === '/api/workstation/lessons' && request.method === 'POST',
  new NetworkFirst({ plugins: [lessonSyncPlugin] }),
  'POST'
);

// Signature upload — Background Sync queue
const signatureSyncPlugin = new BackgroundSyncPlugin('signature-sync-queue', {
  maxRetentionTime: 48 * 60
});
registerRoute(
  ({ url, request }) => url.pathname === '/api/workstation/signatures' && request.method === 'POST',
  new NetworkFirst({ plugins: [signatureSyncPlugin] }),
  'POST'
);
```

### 3.3 Install Prompt

Show a custom "Add to Home Screen" banner the first time Rob visits `/workstation` on mobile. Store dismissal in `localStorage`. If installed, banner never shows again (detected via `window.matchMedia('(display-mode: standalone)')`).

---

## 4. IndexedDB Schema (Dexie.js)

```typescript
// src/lib/workstation/db.ts

import Dexie, { type Table } from 'dexie';

export interface IDBBooking {
  id: string;                    // UUID from server
  studentId: string;
  studentName: string;
  studentPhone: string;
  serviceId: string;
  serviceName: string;
  scheduledDate: string;         // ISO date
  startTime: string;             // ISO datetime
  endTime: string;               // ISO datetime
  durationMinutes: number;
  pickupAddress: string | null;
  suburb: string | null;
  bookingNotes: string | null;   // Visible to student
  status: string;
  paymentStatus: string;
  lastUpdatedAt: string;         // ISO datetime — used for change detection
  cachedAt: number;              // Unix timestamp
}

export interface IDBStudentProfile {
  studentId: string;
  clerkUserId: string;
  fullName: string;
  phone: string;
  licenceNumber: string | null;
  transmissionPreference: 'manual' | 'auto' | 'both';
  lessonCount: number;
  // Competency snapshot (flattened for speed)
  competencies: {
    taskNumber: number;
    taughtAt: string | null;
    assessedAt: string | null;
    achievedManualAt: string | null;
    achievedAutoAt: string | null;
  }[];
  cachedAt: number;
}

export interface IDBDraftLesson {
  draftId: string;               // Client-generated UUID
  bookingId: string | null;
  studentId: string;
  formData: Partial<LessonFormData>;
  step: number;                  // Which step the instructor is up to
  startedAt: number;
  updatedAt: number;
}

export interface IDBPendingLesson {
  draftId: string;
  payload: LessonSubmissionPayload;
  status: 'pending' | 'syncing' | 'failed';
  attempts: number;
  lastAttemptAt: number | null;
  queuedAt: number;
  error: string | null;
}

export interface IDBPendingSignature {
  signatureId: string;           // Client-generated UUID
  lessonDraftId: string;
  role: 'instructor' | 'student';
  imageDataUrl: string;          // Base64 PNG
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  capturedAt: number;
  status: 'pending' | 'syncing' | 'failed';
}

export interface IDBNotesDraft {
  draftId: string;
  studentId: string;
  content: string;
  category: string;
  updatedAt: number;
}

export class WorkstationDB extends Dexie {
  bookings!: Table<IDBBooking>;
  studentProfiles!: Table<IDBStudentProfile>;
  draftLessons!: Table<IDBDraftLesson>;
  pendingLessons!: Table<IDBPendingLesson>;
  pendingSignatures!: Table<IDBPendingSignature>;
  notesDrafts!: Table<IDBNotesDraft>;

  constructor() {
    super('nexdrive-workstation');
    this.version(1).stores({
      bookings:         'id, scheduledDate, studentId, status',
      studentProfiles:  'studentId, fullName',
      draftLessons:     'draftId, bookingId, studentId',
      pendingLessons:   'draftId, status',
      pendingSignatures:'signatureId, lessonDraftId, status',
      notesDrafts:      'draftId, studentId',
    });
  }
}

export const workstationDB = new WorkstationDB();
```

---

## 5. API Endpoints (Workstation-specific)

All routes are under `/app/api/workstation/` in the Next.js App Router. All require Clerk authentication with `role: 'instructor'` claim.

```
GET  /api/workstation/today
     → Today's bookings for authenticated instructor (ordered by start_time)
     → Cached by service worker (NetworkFirst)
     → Also pushes cancellations/changes since last poll

GET  /api/workstation/today/changes?since={isoTimestamp}
     → Returns bookings where updated_at > since
     → Fields: id, status, pickup_address, suburb, booking_notes, updated_at
     → Used for polling (every 60s when app is focused)

GET  /api/workstation/students/{studentId}
     → Student profile + competency snapshot
     → Returns: profile, competencies[], last 5 lesson summaries

GET  /api/workstation/tasks
     → All 23 competency_tasks (ordered by task_number)
     → Cached CacheFirst 30 days

POST /api/workstation/lessons
     → Submit completed lesson record (Form 10.044)
     → Body: LessonSubmissionPayload (see §8)
     → Creates lesson row (append-only), triggers C12/C13/C14/C25

POST /api/workstation/signatures
     → Upload signature image to R2
     → Body: multipart/form-data { image: File, lessonId, role, gpsLat, gpsLng, capturedAt }
     → Returns: { signatureId, r2Url }

POST /api/workstation/notes
     → Create private note (never visible to student/parent)
     → Body: { studentId, content, category, lessonId? }

GET  /api/workstation/students/{studentId}/notes
     → Private notes for student (instructor only)

PATCH /api/workstation/bookings/{bookingId}/start
      → Mark booking as in_progress
      → Sets lesson_id association
```

---

## 6. Navigation & Layout

### 6.1 Shell Layout

The workstation lives at `/workstation` in the Next.js App Router. A dedicated route group `(workstation)` has its own layout that:

- Sets `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">` to prevent accidental zoom during lesson recording
- Renders a full-screen container with bottom tab nav
- Loads the Service Worker registration

```
┌─────────────────────────────────┐  ← iPhone screen (390px wide)
│ Status bar (system)             │
├─────────────────────────────────┤
│                                 │
│                                 │
│         SCREEN CONTENT          │
│                                 │
│                                 │
│                                 │
├─────────────────────────────────┤
│  Today  Students  ●REC  Notes  ⚙ │  ← Bottom tab nav (safe area)
└─────────────────────────────────┘
```

### 6.2 Bottom Tab Navigation

```typescript
const TABS = [
  { id: 'today',    label: 'Today',    icon: CalendarDaysIcon,  href: '/workstation' },
  { id: 'students', label: 'Students', icon: UsersIcon,          href: '/workstation/students' },
  { id: 'record',   label: 'Record',   icon: CircleIcon,         href: '/workstation/record',
    accent: true },  // Red circle icon — primary action
  { id: 'notes',    label: 'Notes',    icon: PencilSquareIcon,  href: '/workstation/notes' },
  { id: 'settings', label: 'Settings', icon: Cog6ToothIcon,     href: '/workstation/settings' },
];
```

Tab bar sits above the iOS safe area (`padding-bottom: env(safe-area-inset-bottom)`). Icons are 28×28px. Touch targets are 56px tall minimum. Active tab uses brand orange accent. A pulsing red dot on the Record tab when a lesson is actively recording.

### 6.3 Sync Status Banner

A 40px banner sits above the tab bar (below main content) when sync is non-nominal:

- **Green / hidden:** All synced (no banner shown)
- **Amber:** "Offline — X records queued" — tappable to see queue detail
- **Red:** "Sync failed — tap to retry"

---

## 7. Today View (`/workstation`)

### 7.1 Layout

```
┌─────────────────────────────────────┐
│  Monday 24 Feb  •  3 lessons today  │  ← Date header
│  [!] Lesson 2 — pickup address changed  │  ← Alert banner (if changes detected)
├─────────────────────────────────────┤
│                                     │
│  ○ 8:00 AM — 60 min              →  │
│    Alex Chen                        │  ← Upcoming
│    15 Girrawheen St, Belconnen      │
│                                     │
│  ● 9:30 AM — 90 min [IN PROGRESS]  │
│    Sarah Mitchell                   │  ← Active (green border)
│    Pickup: 22 Scullin Place         │
│    [00:47 elapsed]                  │
│                                     │
│  ○ 11:30 AM — 60 min             →  │
│    James Park                       │  ← Upcoming
│    12 Wattle St, Holt               │
│                                     │
│  + Add manual lesson                │  ← Footer action
└─────────────────────────────────────┘
```

### 7.2 Lesson Card

Each booking renders as a card with:

- Time slot + duration badge
- Student full name (large text, easy to read at a glance)
- Pickup address
- Payment status badge (unpaid → amber, paid → hidden)
- Status: upcoming (grey dot), in-progress (green dot + elapsed timer), completed (green check), cancelled (red strikethrough)

Tapping an upcoming card: shows bottom sheet with "Start Lesson Recording" CTA + booking details + any notes.

### 7.3 Change/Cancellation Alerts

Changes are polled from `GET /api/workstation/today/changes` every 60 seconds when the app is in the foreground. IndexedDB's cached booking `lastUpdatedAt` is compared to server response.

On change detected:
- Update IndexedDB cache
- Show alert banner at top of Today view (dismissible per booking)
- If cancellation: card gets red "CANCELLED" overlay, removed from active list
- If pickup address changed: amber "Address updated" chip on card

Alert banner format: `"⚠ [Student name] — [what changed]"` — tapping opens booking detail.

Background polling via service worker `periodicsync` event (if supported) or `setInterval` on page focus.

---

## 8. Lesson Recording Form (`/workstation/record`)

### 8.1 Design Principle

**Target: completed in < 90 seconds from lesson end.**

The form is 4 steps. Progress is auto-saved to IndexedDB as a draft at every field change. If the app crashes mid-recording, the draft recovers on next open.

```
Step 1: STUDENT + TIMING     (~15s)
Step 2: LOCATION + ODOMETER  (~10s)
Step 3: COMPETENCIES         (~45s)
Step 4: COMMENTS + NOTES     (~20s)
→ SIGNATURE CAPTURE          (separate screen)
```

A progress bar across the top (4 segments). A floating "Save Draft" chip on all steps.

### 8.2 Step 1 — Student + Timing

**Pre-filled when launched from Today view booking card.** Can also be filled manually (for lessons not in the booking system).

```
┌─────────────────────────────────────┐
│  ← Cancel          Step 1 of 4  →  │
│══════░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │  progress bar
│                                     │
│  STUDENT                            │
│  ┌─────────────────────────────┐    │
│  │ 🔍 Sarah Mitchell           │    │  ← pre-filled from booking
│  └─────────────────────────────┘    │  Searchable dropdown: today's bookings first
│                                     │
│  LESSON DATE    LESSON NUMBER       │
│  [24 Feb 2026]  [Auto: #7]          │  ← lesson_number auto-computed by API
│                                     │
│  START TIME         END TIME        │
│  [09:30]            [11:00]         │  ← pre-filled, editable time pickers
│                                     │
│  ROUND TO 30-MIN PERIODS?  [  OFF ] │  ← toggle (stored in instructor prefs)
│                                     │
│                    [Next →]         │
└─────────────────────────────────────┘
```

Student selector shows today's bookings first (pulled from IndexedDB), then all active students. Searching fetches from `GET /api/workstation/students?q=` (network) or filters IndexedDB cache (offline).

### 8.3 Step 2 — Location + Odometer

```
┌─────────────────────────────────────┐
│  ← Back            Step 2 of 4  →  │
│════════════░░░░░░░░░░░░░░░░░░░░░░░  │
│                                     │
│  LOCATION / SUBURB                  │
│  ┌─────────────────────────────┐    │
│  │ Belconnen                   │    │  ← Free text + suburb dropdown
│  └─────────────────────────────┘    │
│  Location detail (optional)         │
│  ┌─────────────────────────────┐    │
│  │ Westfield car park area     │    │
│  └─────────────────────────────┘    │
│                                     │
│  ODOMETER                           │
│  Start km    [        ]             │  ← Numeric keypad auto-opens
│  End km      [        ]             │
│  Distance:   — km                   │  ← Calculated live
│                                     │
│                    [Next →]         │
└─────────────────────────────────────┘
```

Suburb field: free-text with suggestions from a static ACT suburbs list (bundled — works offline). Odometer fields: numeric-only virtual keyboard via `inputMode="numeric"`. End km must be ≥ start km (validated on blur).

### 8.4 Step 3 — Competencies

This is the heart of the form. All 23 ACT CBT&A tasks displayed as a scrollable, touch-optimised grid.

**Transmission context** (shown if student's preference is `both`):
```
Recording for: [Manual] [Auto] [Both]   ← Tab switcher at top of step
```

**Competency grid — each task:**
```
┌──────────────────────────────────────────────────────────┐
│ T7  Reverse Parking                           [current: —] │
│  [T] Taught   [A] Assessed   [✓] Achieved                  │
└──────────────────────────────────────────────────────────┘
```

Each task row:
- Task number (bold, large) + short name
- Current status badge (grey dash = not started, amber = in progress, green tick = achieved)
- Three toggle buttons: **T** (Taught) | **A** (Assessed) | **✓** (Achieved)
- Buttons are mutually exclusive via toggle group logic (T → A → ✓ or any subset)
- When Achieved is tapped for a previously incomplete task: brief haptic + green flash

Layout: single-column list (not a grid) for readability on narrow phones. Tasks grouped by category with a sticky category header:
- **Basic Vehicle Control** (Tasks 1–4)
- **Moving Off & Stopping** (Tasks 5–7)
- **Observation & Road Rules** (Tasks 8–12)
- **Complex Traffic** (Tasks 13–17)
- **Reviews & Assessment** (Tasks 18–22, Review 1–17, Review 1–22)
- **Final Drive** (Task 23 — gated, shows lock icon if prerequisites not met)

**Previous state pre-loaded:** Each task shows its current state from the cached student competency snapshot. The instructor is only recording *this lesson's* changes.

**Task 23 (Final Drive):** Rendered with a lock icon if `C12.checkFinalDriveEligibility()` returns false. Tapping the locked task shows an inline tooltip: "Final Drive requires all tasks competent + both reviews complete."

**Quick filter:** A row of filter chips at the top — `All | Incomplete | Today` — to jump to relevant tasks.

### 8.5 Step 4 — Comments + Private Note

```
┌─────────────────────────────────────┐
│  ← Back            Step 4 of 4  →  │
│══════════════════════════░░░░░░░░░  │
│                                     │
│  COMMENTS (visible to student)      │
│  ┌─────────────────────────────┐    │
│  │                             │    │  ← Multiline textarea
│  │ Great improvement on round- │    │
│  │ abouts today.               │    │
│  └─────────────────────────────┘    │
│  Quick phrases:                     │
│  [Good progress] [Work on mirrors]  │
│  [Review at home] [Well done!]      │  ← Configurable quick-inserts
│                                     │
│  PRIVATE NOTE (instructor only)     │  ← Clearly labelled "never shown to student"
│  ┌─────────────────────────────┐    │
│  │                             │    │  ← Optional, collapsible by default
│  └─────────────────────────────┘    │
│  Category: [General ▾]              │  ← coaching / behavioural / technical / admin
│                                     │
│         [Complete & Sign →]         │
└─────────────────────────────────────┘
```

Quick phrases are pre-configured strings that append to the comment field on tap. Rob can customise these in Settings. Stored in `localStorage`.

Private note is optional. Category dropdown: `General | Coaching | Behavioural | Technical | Admin`. Saved to `private_notes` table — never returned in student/parent API responses.

---

## 9. Signature Capture (`/workstation/sign`)

Entered from the end of Step 4, or directly from a pending lesson. Full-screen modal (no tab bar).

### 9.1 Flow

```
[Lesson summary panel]
    ↓
[Instructor signs]
    ↓
"Hand device to student"
    ↓
[Student signs]
    ↓
[Confirm & Submit]
```

### 9.2 Signature Screen Layout

```
┌─────────────────────────────────────┐
│  Instructor Signature               │
│  Rob Harrison — 24 Feb 2026 11:03   │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │                                 │ │
│ │   [sign here with finger]       │ │  ← Canvas — 320×180px minimum
│ │                                 │ │
│ └─────────────────────────────────┘ │
│  [Clear]  [Redo]                    │
│                                     │
│  GPS: Belconnen ACT (captured ✓)    │  ← GPS status (captured silently on mount)
│                                     │
│           [Continue →]              │
└─────────────────────────────────────┘
```

After instructor signs → screen flips to student view (CSS transform, no navigation):

```
┌─────────────────────────────────────┐
│  STUDENT SIGN-OFF                   │
│  I confirm this lesson record is    │
│  accurate.                          │
│                                     │
│  Sarah Mitchell                     │
│  24 Feb 2026 • Lesson #7            │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │   [student signs here]          │ │
│ └─────────────────────────────────┘ │
│  [Clear]                            │
│                                     │
│  ← Back (re-sign instructor)        │
│           [Submit Lesson →]         │
└─────────────────────────────────────┘
```

### 9.3 Canvas Implementation

```typescript
import SignatureCanvas from 'react-signature-canvas';

// Config
<SignatureCanvas
  ref={sigRef}
  canvasProps={{
    className: 'signature-canvas',
    width: 320,
    height: 180,
  }}
  backgroundColor="white"
  penColor="#1e3a5f"
  dotSize={2}
  minWidth={1.5}
  maxWidth={3}
  velocityFilterWeight={0.7}  // Smooth natural strokes
/>
```

Export as PNG (`sigRef.current.toDataURL('image/png')`) at completion. Image stored in IndexedDB as base64 until uploaded.

### 9.4 GPS Capture

On entering the signature screen, request GPS silently (no user prompt needed — instructor has already consented in settings):

```typescript
navigator.geolocation.getCurrentPosition(
  (pos) => setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
  () => setGps(null),  // Fail silently — GPS is supplementary, not blocking
  { timeout: 3000, maximumAge: 60000 }
);
```

GPS stored with each signature. If denied or timed out, lesson can still be submitted (compliance is met by timestamp + device info, GPS is additive audit data).

### 9.5 Submit Payload

```typescript
interface LessonSubmissionPayload {
  // Identity
  draftId: string;                     // Client-generated UUID for idempotency
  bookingId: string | null;
  studentId: string;
  instructorId: string;                // From Clerk session claim
  
  // Timing
  lessonDate: string;                  // YYYY-MM-DD
  startTime: string;                   // ISO datetime
  endTime: string;                     // ISO datetime
  totalMinutes: number;
  roundedMinutes: number | null;

  // Odometer
  odoStart: number | null;
  odoEnd: number | null;

  // Location
  locationSuburb: string | null;
  locationDetail: string | null;

  // Competencies
  competenciesTaught: number[];
  competenciesAssessed: number[];
  competenciesAchievedManual: number[];
  competenciesAchievedAuto: number[];

  // Comments
  comments: string | null;

  // Private note
  privateNote: {
    content: string;
    category: string;
  } | null;

  // Signatures (uploaded separately, referenced by ID)
  instructorSignatureId: string;       // Client UUID → server links after upload
  studentSignatureId: string;

  // Device info (for audit)
  deviceInfo: {
    userAgent: string;
    screenWidth: number;
    screenHeight: number;
    appVersion: string;
  };
}
```

Submission uses **two-phase commit pattern**:
1. `POST /api/workstation/signatures` (×2) → get server signature IDs + R2 URLs
2. `POST /api/workstation/lessons` with `{ instructorSignatureId, studentSignatureId }` populated

If offline: both requests go to Background Sync queue. The `draftId` ensures idempotency — duplicate submissions are rejected by the server with `409 Conflict` (server deduplicates on `draftId`).

---

## 10. Student View (`/workstation/students/[studentId]`)

Accessed from the Students tab or tapping a student name in Today view.

```
┌─────────────────────────────────────┐
│  ← Students                         │
│  Sarah Mitchell   [Start Lesson →]  │
│  Licence: DL123456 • Manual         │
├─────────────────────────────────────┤
│  [Progress] [History] [Notes] [Forms]  ← tab switcher
├─────────────────────────────────────┤
│  COMPETENCY MAP (Progress tab)      │
│                                     │
│  [1✓][2✓][3✓][4✓][5✓][6NYC][7-]... │  ← 5×5 grid of task pills
│  ✓=achieved  NYC=not yet  -=untouched│
│                                     │
│  14 / 23 tasks complete (61%)       │
│  ████████████░░░░░░░░░░             │
│                                     │
│  Last lesson: 17 Feb — 90 min       │
│  Suburb: Civic. Tasks: 8, 9, 11    │
└─────────────────────────────────────┘
```

**Progress tab:** Competency matrix (5×5 pill grid — task number + status colour). Tap any task pill → bottom sheet with full task detail (name, description, status history, last assessed date).

**History tab:** Last 10 lessons in reverse chronological order. Each: date, duration, suburb, tasks covered, comment excerpt. Tap → full lesson detail.

**Notes tab:** Private instructor notes only. Never visible to student. (See §11.)

**Forms tab:** Lesson Bridge Forms, self-assessment forms for this student. Links to full forms.

---

## 11. Private Notes UI

### 11.1 Notes Tab (within Student View)

```
┌─────────────────────────────────────┐
│  Private Notes — Sarah Mitchell     │
│  [+ Add Note]                       │
├─────────────────────────────────────┤
│  🏷 Coaching  •  22 Feb              │
│  "Anxious at roundabouts — use Emu  │
│   Bank approach first."             │
├─────────────────────────────────────┤
│  🏷 General  •  17 Feb               │
│  "Loves AFL — good rapport builder."│
├─────────────────────────────────────┤
│  🏷 Technical  •  10 Feb             │
│  "Watch left mirror check — has a   │
│   habit of skipping it on approach."│
└─────────────────────────────────────┘
```

Notes are display-only after saving (append-only pattern matches DB). A note can be "archived" (soft hide) but not deleted.

### 11.2 Add Note Bottom Sheet

```
┌─────────────────────────────────────┐
│  Add Private Note                   │  ← Bottom sheet, slides up
│  Sarah Mitchell                     │
│  ─────────────────────────────────  │
│  ┌─────────────────────────────┐    │
│  │                             │    │  ← 5-row textarea, auto-focus
│  └─────────────────────────────┘    │
│  Category: [General ▾]              │
│  Link to current lesson? [●]        │  ← Toggle (auto-on during lesson recording)
│                                     │
│  [Cancel]              [Save Note]  │
└─────────────────────────────────────┘
```

Quick-add is also available inline on Step 4 of lesson recording (pre-linked to that lesson).

### 11.3 Notes Tab (All Students — `/workstation/notes`)

A searchable reverse-chronological list of all recent notes across all students. Quick access without navigating per-student. Filter chips: `All | Coaching | Behavioural | Technical | Admin | Unlinked`.

---

## 12. Offline Architecture — Detailed Behaviour

### 12.1 Data Loading Strategy

**On app open (daily):**
1. Fetch today's bookings → store in `workstationDB.bookings`
2. For each booking, fetch student profile + competency snapshot → store in `workstationDB.studentProfiles`
3. Fetch all 23 tasks → store via service worker CacheFirst (rarely changes)
4. App is now fully usable offline for the rest of the day

**On lesson start (when online):**
5. Refresh student competency snapshot (in case another device made changes)

### 12.2 Lesson Recording Offline Flow

```
1. Instructor fills form (writes to IndexedDB `draftLessons`)
2. Signature captured (stored as base64 in IndexedDB `pendingSignatures`)
3. "Submit" tapped:
   a. If online:
      - Upload signatures → get server IDs
      - POST lesson → get server lesson ID
      - Delete local draft + pending records
      - Update booking status in IndexedDB cache
   b. If offline:
      - Move draft to `pendingLessons` with status 'pending'
      - Add signature blobs to `pendingSignatures` with status 'pending'
      - Show: "Saved. Will sync when connected."
      - Register Background Sync tag 'lesson-sync'
      
4. On reconnect (Background Sync fires):
      - Service worker wakes, processes `lesson-sync-queue`
      - Signatures uploaded first (parallel)
      - Lesson POST with signature IDs
      - On success: clear pending records, update cache
      - On failure (4xx): mark as 'failed', alert Rob via in-app banner
```

### 12.3 Conflict Resolution

Lessons are append-only — there is no update conflict possible for lesson records themselves. The server `draftId` field enforces idempotency.

For booking status (cancellation discovered on sync):
- If lesson already recorded for a cancelled booking: lesson stands (already signed), server logs a warning in `audit_log`. Rob notified via in-app alert on next Today view load.

For student competency state (another device changed competencies while offline):
- Server's state is authoritative
- On sync, refresh student profile cache
- If conflict: show Rob a "Competency state changed while you were offline — please review" alert

### 12.4 Sync Status UI

```typescript
// Zustand store
interface SyncState {
  pendingLessons: number;
  pendingSignatures: number;
  failedRecords: number;
  lastSyncAt: Date | null;
  isOnline: boolean;
}
```

Status banner (above tab bar) states:
- Hidden (all synced, online)
- `🟡 Offline — 2 lessons queued` (online = false, pending > 0)
- `🟡 Syncing…` (background sync in progress)
- `✅ All synced` (shown briefly after successful sync, then hidden)
- `🔴 Sync failed — 1 record needs attention` (tappable → sync detail screen)

---

## 13. Cancellation & Change Polling

### 13.1 Poll Strategy

When the workstation app is in the **foreground**:
- Poll `GET /api/workstation/today/changes?since={lastPollTime}` every **60 seconds**
- Compare returned bookings to IndexedDB cache
- On change: update cache + trigger UI alert

When the workstation app is in the **background**:
- Use `Periodic Background Sync` API (Chrome Android, not yet iOS Safari)
- Fallback: on next foreground focus event, immediately poll

### 13.2 Change Types + UI Response

| Change Type | DB field changed | UI Response |
|---|---|---|
| Cancellation | `status` → `cancelled` | Red "CANCELLED" overlay on card + banner |
| Pickup address change | `pickup_address` | Amber "Address updated" chip + banner |
| Booking notes added | `booking_notes` | Blue "Note added" chip |
| Rescheduled (time change) | `start_time`, `end_time` | Time updates on card + banner |

Banner format: `"⚠ Sarah Mitchell — lesson cancelled at 10:24 AM"`. Tapping opens booking detail. Dismissing removes the banner but keeps the card status.

### 13.3 API Response Format

```typescript
// GET /api/workstation/today/changes?since=2026-02-24T08:00:00Z
{
  changes: [
    {
      id: "uuid",
      studentName: "Sarah Mitchell",
      status: "cancelled",
      pickupAddress: null,
      suburb: "Belconnen",
      bookingNotes: "Student called to cancel — sick",
      startTime: "2026-02-24T09:30:00+11:00",
      updatedAt: "2026-02-24T10:24:00+11:00",
      changeType: "cancellation" | "address_change" | "notes_update" | "reschedule"
    }
  ]
}
```

---

## 14. Performance Targets

| Metric | Target | How achieved |
|---|---|---|
| App usable after install | < 2s | Service Worker pre-caches shell; IndexedDB pre-loads data |
| Today view load | < 1s | Served from IndexedDB; network refresh in background |
| Lesson form open | < 500ms | Pre-loaded student data; no network required |
| Competency grid render | < 300ms | Virtualized list (react-window) for 23 tasks |
| Lesson form (Steps 1–4) | < 90s total | Pre-filled fields; numbered grid; quick-phrase chips |
| Signature capture | < 3s from canvas open | Canvas renders instantly; GPS captured async |
| Lesson submit (online) | < 5s | Parallel signature upload; single lesson POST |
| Lesson submit (offline) | < 500ms | Write to IndexedDB only; sync is background |

**< 90 second lesson recording validation:**  
- Step 1 (Student + Timing): pre-filled from booking → ~5 touches, ~10s
- Step 2 (Location + ODO): suburb picker + 2 fields → ~10s
- Step 3 (Competencies): assume 3–5 tasks per lesson, each 2 taps → ~30s
- Step 4 (Comments): quick phrase chip → ~5s
- Signature (instructor): ~15s
- Signature (student): ~15s
- **Total: ~85s** ✅

---

## 15. Settings (`/workstation/settings`)

```
┌─────────────────────────────────────┐
│  Settings                           │
├─────────────────────────────────────┤
│  Quick Comment Phrases          [>] │  ← Edit list of quick-insert phrases
│  Default Transmission     [Manual]  │  ← Manual | Auto | Both
│  Round Lesson Time         [OFF]    │  ← Toggle
│  GPS Capture               [ON]     │  ← Toggle
│  ─────────────────────────────────  │
│  Sync Status                    [>] │  ← Detail: pending records, queue
│  Clear Cache                        │  ← Force re-fetch all data
│  ─────────────────────────────────  │
│  App Version: 1.0.0                 │
│  Last sync: Today 10:47 AM ✅       │
│  [Sign Out]                         │
└─────────────────────────────────────┘
```

---

## 16. Testing Approach

### 16.1 Unit Tests (Jest + Testing Library)

- Competency grid: toggle states, transmission context switching, task locking (Task 23 gating)
- Form validation: odo end < odo start error, missing required fields
- IndexedDB helpers: draft save/load/clear, pending queue management
- Sync state machine: offline → queued → synced / failed transitions

### 16.2 Offline Scenario Tests (Playwright)

```typescript
// Test: Complete lesson recording while offline, sync on reconnect
test('records lesson offline and syncs on reconnect', async ({ page, context }) => {
  await page.goto('/workstation');
  await context.setOffline(true);
  
  // Fill lesson form
  await page.click('[data-testid="booking-card-sarah-mitchell"]');
  await page.click('[data-testid="start-lesson-btn"]');
  // ... fill steps 1-4
  
  // Sign
  await drawOnCanvas(page, '[data-testid="instructor-sig-canvas"]');
  await drawOnCanvas(page, '[data-testid="student-sig-canvas"]');
  await page.click('[data-testid="submit-lesson-btn"]');
  
  // Verify offline state
  await expect(page.locator('[data-testid="sync-banner"]')).toContainText('1 lesson queued');
  
  // Reconnect
  await context.setOffline(false);
  
  // Wait for background sync
  await page.waitForSelector('[data-testid="sync-banner-success"]', { timeout: 10000 });
  
  // Verify lesson appears in history
  // ...
});
```

Additional Playwright offline scenarios:
- App opens with no connectivity (serves from cache)
- Cancellation detected on poll after reconnect
- Duplicate submission rejected (Background Sync fires twice)
- Signature upload fails → retry

### 16.3 Performance Tests (Lighthouse CI)

Run on every PR against `/workstation` route:
- LCP < 2.5s on throttled 4G (Lighthouse)
- Offline score: 100 (PWA)
- Accessibility score: ≥ 90

### 16.4 Device Testing Matrix

| Device | OS | Browser | Priority |
|---|---|---|---|
| iPhone 12 | iOS 17 | Safari | P0 (Rob's likely device) |
| iPhone 15 | iOS 17 | Safari | P0 |
| Samsung Galaxy S21 | Android 14 | Chrome | P1 |
| iPad Air | iOS 17 | Safari | P2 |

---

## 17. File Structure

```
src/
├── app/
│   └── (workstation)/
│       ├── layout.tsx              ← Workstation shell, tab nav, SW registration
│       ├── page.tsx                ← Today view
│       ├── record/
│       │   ├── page.tsx            ← Lesson recording entry (step 1)
│       │   ├── step2/page.tsx
│       │   ├── step3/page.tsx
│       │   ├── step4/page.tsx
│       │   └── sign/page.tsx       ← Signature capture
│       ├── students/
│       │   ├── page.tsx            ← Student list
│       │   └── [studentId]/
│       │       └── page.tsx        ← Student detail (tabs: progress/history/notes/forms)
│       ├── notes/
│       │   └── page.tsx            ← All notes across students
│       └── settings/
│           └── page.tsx
├── api/workstation/
│   ├── today/route.ts
│   ├── today/changes/route.ts
│   ├── students/route.ts
│   ├── students/[studentId]/route.ts
│   ├── students/[studentId]/notes/route.ts
│   ├── tasks/route.ts
│   ├── lessons/route.ts
│   ├── signatures/route.ts
│   └── bookings/[bookingId]/start/route.ts
└── lib/workstation/
    ├── db.ts                       ← Dexie schema + WorkstationDB instance
    ├── sync.ts                     ← Sync orchestration (online/offline state)
    ├── polling.ts                  ← Change polling (today/changes endpoint)
    └── competency-utils.ts         ← Task state helpers
```

---

## 18. Dependencies

```json
{
  "dexie": "^3.2",
  "react-signature-canvas": "^1.0",
  "workbox-webpack-plugin": "^7.0",
  "workbox-background-sync": "^7.0",
  "workbox-routing": "^7.0",
  "workbox-strategies": "^7.0",
  "zustand": "^4.5",
  "@tanstack/react-query": "^5.0",
  "react-window": "^1.8"
}
```

---

## 19. Security & Compliance Notes

- All workstation API routes enforce `role: 'instructor'` via Clerk `auth()` middleware. Students cannot access any `/api/workstation/*` endpoint.
- Private notes are excluded from all student/parent response shapes at the service layer. They are never returned by any student-facing API regardless of query parameters.
- Lesson records are written as append-only. The API layer rejects any UPDATE or DELETE on the `lessons` table. Corrections require a new row with `correction_of` set.
- Signature images stored in Cloudflare R2 with private ACL — only accessible via signed URLs generated server-side. URLs expire after 1 hour.
- IndexedDB data on the device is not encrypted (browser limitation). This is acceptable given: (a) device is Rob's personal phone with biometric lock, (b) sensitive data (competency records) sync to server promptly, (c) compliance data is not PII beyond names and lesson details.
- GPS coordinates stored with signatures add tamper-evidence but are not required for ACT Government compliance. Absence of GPS does not invalidate a lesson record.

---

*SPEC-12 complete. Implementation ready for Phase 3 (Weeks 13–20). Build sequence within Phase 3: Start with IndexedDB setup + Service Worker (offline foundation), then Today view, then lesson recording form, then signature capture, then student view + private notes.*
