# SPEC-20: Competency Hub Content (C17)
### NexDrive Academy — Phase 5 Content & Authority
**Version:** 1.0  
**Date:** 22 February 2026  
**Status:** Ready for Implementation  
**Depends On:** SPEC-01 (Database Schema — `competency_tasks`, `student_competencies`); SPEC-08 (RAG Knowledge Engine — `rag_documents`, ingestion pipeline); SPEC-02 (Auth & RBAC — student session for progress injection); SPEC-17 (Student Portal — authenticated progress API)  
**Phase:** 5 (Content & Authority — Weeks 29–34)  
**Estimated Effort:** 8–12 days (content production + engineering)  
**Build Tools:** Cursor (engineering), Claude API (content generation per-task), manual review by Rob

---

## 1. Overview

The Competency Hub is NexDrive Academy's authoritative educational resource for ACT learner drivers completing the CBT&A (Competency Based Training & Assessment) program. It publishes 23 individual pages — one per official CBT&A task — each targeting ACT-specific SEO keywords, feeding content into the RAG knowledge engine (C07), and (for authenticated students) displaying live progress from the CBT&A Compliance Engine (C12).

**This is a self-contained implementation brief.** An AI coding agent should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **Content lives in MDX files** under `content/competency-hub/` — not in the database. The `competency_tasks.competency_hub_content_id` column links to the `rag_documents` table record created when the page is indexed.
2. **Progress injection is unauthenticated-safe.** Pages render fully for anonymous visitors. Student progress (badge, status) is an authenticated overlay — fetch client-side via `/api/v1/student/competencies` from SPEC-17. Never block page render on auth.
3. **Private notes never appear here.** This is a public page. Student competency `status` and `transmission` may be shown to the authenticated student only. Instructor comments from `private_notes` are never surfaced anywhere in this component.
4. **RAG ingestion is triggered automatically** on build/deploy via a server action or build script — not manually. Each task page produces one `rag_documents` record with `source_type = 'educational'`.
5. **ACT-specific accuracy.** All regulatory references must cite ACT Road Rules 2017 and the ACT Government CBT&A program. Do not reference interstate requirements.
6. **SEO is server-rendered.** All 23 pages use Next.js `generateStaticParams` + ISR (`revalidate: 86400`). No client-only rendering of primary content.
7. **Schema markup is required** on every task page (HowTo or EducationalOccupationalCredential — see §7).

---

## 2. File Structure

```
src/
├── app/
│   └── (public)/
│       └── competency-hub/
│           ├── layout.tsx                    # Hub layout: sidebar nav + breadcrumbs
│           ├── page.tsx                      # Hub index — category grid, intro, CTA
│           └── [slug]/
│               └── page.tsx                  # Dynamic task page (ISR)
├── components/
│   └── competency-hub/
│       ├── TaskPageTemplate.tsx              # Main template — renders MDX + all sections
│       ├── TaskSidebar.tsx                   # Task list sidebar with category grouping
│       ├── TaskProgressBadge.tsx             # Client component — student's status badge
│       ├── TaskPrerequisiteChain.tsx         # Visual prerequisite chain component
│       ├── TaskRelatedLinks.tsx              # Related tasks links
│       ├── TaskFAQ.tsx                       # Accordion FAQ section
│       ├── TaskPracticeTips.tsx              # Supervisor/parent practice guide
│       ├── TaskHubGrid.tsx                   # Index page — category grid
│       └── TaskProgressFilter.tsx            # Auth-only: filter sidebar by progress status
├── content/
│   └── competency-hub/
│       ├── task-01-pre-drive-procedure.mdx
│       ├── task-02-controls-and-instruments.mdx
│       ├── task-03-moving-off-and-stopping.mdx
│       ├── task-04-steering.mdx
│       ├── task-05-gear-changing.mdx
│       ├── task-06-low-speed-manoeuvres.mdx
│       ├── task-07-intersections-give-way-stop.mdx
│       ├── task-08-intersections-traffic-lights.mdx
│       ├── task-09-intersections-roundabouts.mdx
│       ├── task-10-lane-changing-and-overtaking.mdx
│       ├── task-11-speed-management.mdx
│       ├── task-12-gap-selection.mdx
│       ├── task-13-following-distance.mdx
│       ├── task-14-hazard-perception.mdx
│       ├── task-15-sharing-the-road.mdx
│       ├── task-16-night-driving.mdx
│       ├── task-17-review-assessment-1-17.mdx
│       ├── task-18-driving-in-traffic.mdx
│       ├── task-19-freeway-highway-driving.mdx
│       ├── task-20-rural-country-roads.mdx
│       ├── task-21-adverse-conditions.mdx
│       ├── task-22-review-assessment-18-22.mdx
│       └── task-23-final-drive-assessment.mdx
├── lib/
│   └── competency-hub/
│       ├── mdx.ts                            # MDX loader + frontmatter parser
│       ├── rag-sync.ts                       # Build-time RAG ingestion trigger
│       └── structured-data.ts               # JSON-LD schema markup generators
└── scripts/
    └── sync-competency-hub-to-rag.ts         # CLI: ingest all 23 MDX → rag_documents
```

---

## 3. URL Structure

```
/competency-hub                                     ← Hub index (category grid)
/competency-hub/task-1-pre-drive-procedure
/competency-hub/task-2-controls-and-instruments
/competency-hub/task-3-moving-off-and-stopping
/competency-hub/task-4-steering
/competency-hub/task-5-gear-changing
/competency-hub/task-6-low-speed-manoeuvres
/competency-hub/task-7-intersections-give-way-stop
/competency-hub/task-8-intersections-traffic-lights
/competency-hub/task-9-intersections-roundabouts
/competency-hub/task-10-lane-changing-and-overtaking
/competency-hub/task-11-speed-management
/competency-hub/task-12-gap-selection
/competency-hub/task-13-following-distance
/competency-hub/task-14-hazard-perception
/competency-hub/task-15-sharing-the-road
/competency-hub/task-16-night-driving
/competency-hub/task-17-review-assessment-1-17
/competency-hub/task-18-driving-in-traffic
/competency-hub/task-19-freeway-highway-driving
/competency-hub/task-20-rural-country-roads
/competency-hub/task-21-adverse-conditions
/competency-hub/task-22-review-assessment-18-22
/competency-hub/task-23-final-drive-assessment
```

**Slug format:** `task-{number}-{kebab-case-name}` — matches exactly the MDX filename minus extension.

---

## 4. MDX Content Format

### 4.1 Frontmatter Schema

Every `.mdx` file begins with YAML frontmatter. All fields are required unless marked optional.

```yaml
---
# ── Identity ─────────────────────────────────
taskNumber: 10                        # integer, 1–23 — must match competency_tasks.task_number
slug: "task-10-lane-changing-and-overtaking"
title: "CBT&A Task 10 — Lane Changing and Overtaking"
shortTitle: "Lane Changing & Overtaking"   # used in sidebar nav

# ── Category ─────────────────────────────────
category: "Traffic"                   # "Basic Control" | "Traffic" | "Complex" | "Review" | "Final"
categorySlug: "traffic"

# ── SEO ─────────────────────────────────────
metaTitle: "ACT CBT&A Task 10: Lane Changing & Overtaking | NexDrive Academy Canberra"
metaDescription: "Master lane changing and overtaking for your ACT CBT&A driving test. Learn what the instructor assesses, common mistakes, and how to practise safely in Canberra."
primaryKeyword: "ACT learner driver lane changing"
secondaryKeywords:
  - "CBT&A task 10 Canberra"
  - "lane changing driving test ACT"
  - "overtaking learner driver ACT"
  - "how to change lanes safely Australia"

# ── Structure ────────────────────────────────
prerequisites: [4, 7]                 # task numbers — must match DB
relatedTasks: [9, 11, 12, 13]        # task numbers shown as "See Also"
isReview: false
isFinalDrive: false
reviewRequiresTasks: []               # populated for task 17 and 22

# ── Schema Markup ────────────────────────────
schemaType: "HowTo"                   # "HowTo" | "EducationalOccupationalCredential"
estimatedTime: "PT3H"                 # ISO 8601 duration — approximate supervised practice time

# ── RAG ─────────────────────────────────────
ragEnabled: true                      # if false, page is not ingested into RAG
ragSourceType: "educational"          # always "educational" for competency hub pages

# ── Content Flags ─────────────────────────────
hasVideo: false                       # set true when video is produced (Phase 5 expansion)
lastReviewed: "2026-02-22"
reviewedBy: "Rob Harrison, ADI"
---
```

### 4.2 MDX Body Structure

The body contains 8 named sections, identified by `<Section id="...">` MDX components. The `TaskPageTemplate` renders these in fixed order. Authors write content in standard Markdown; only the section wrappers require MDX.

```mdx
<Section id="overview">

## What is Task 10 — Lane Changing and Overtaking?

[2–4 sentence plain-English intro. What this task is, when learners encounter it, 
why it matters. Written for a nervous 17-year-old and their parent.]

</Section>

<Section id="official-description">

## Official CBT&A Description

> [Verbatim description from the ACT CBT&A program — matches `competency_tasks.description`]

*Source: ACT Government CBT&A Program*

</Section>

<Section id="what-youll-learn">

## What You'll Learn

[Bulleted list: 4–8 specific skills the student will develop. Written as student-facing 
outcomes: "You will be able to...". Matches what Rob teaches.]

</Section>

<Section id="what-instructor-assesses">

## What the Instructor Assesses

[Numbered list: specific observable behaviours the instructor watches for during 
assessment. Written precisely — mirrors the Form 10.044 sign-off criteria. 
Examples: mirror checks, signal timing, blind spot head check, smooth steering input.]

</Section>

<Section id="common-challenges">

## Common Challenges

[3–5 most common errors learners make on this task. For each: name the error, 
why it happens, what it looks like from the instructor's seat. 
Written in empathetic, non-scary tone.]

</Section>

<Section id="practice-tips">

## Tips for Supervised Practice

[Guide for parents/supervisors — how to practise this task on the road outside 
of professional lessons. Includes: recommended road types in ACT, suggested 
routes/conditions, how to give feedback, safety notes, minimum suggested hours 
on this skill before booking next lesson. Written to parent, not student.]

<PracticeRouteSuggestion 
  areaName="Belconnen to City via Barry Drive"
  description="Multi-lane arterial with consistent lane-change opportunities"
  difficulty="beginner"
/>

</Section>

<Section id="faq">

## Frequently Asked Questions

<FAQ question="How many times can I fail a task?">
[Answer...]
</FAQ>

<FAQ question="Do I need to practise lane changing before my next lesson?">
[Answer...]
</FAQ>

[3–6 FAQ items per page]

</Section>

<Section id="prerequisite-note">

## Before You Start This Task

[1–2 sentences explaining the prerequisite dependency — why those tasks must 
be signed off first. Links to prerequisite pages.]

</Section>
```

---

## 5. Task Page Template — `TaskPageTemplate.tsx`

### 5.1 Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Breadcrumb: Home › Competency Hub › Task 10                    │
├──────────────────────┬──────────────────────────────────────────┤
│  SIDEBAR             │  MAIN CONTENT                            │
│                      │                                          │
│  Category Groups:    │  [TaskProgressBadge — client, auth-only] │
│  ■ Basic Control     │                                          │
│    Tasks 1–6         │  H1: Task 10 — Lane Changing and         │
│  ■ Traffic           │       Overtaking                         │
│    ► Task 10 ←       │                                          │
│  ■ Complex           │  [Official CBT&A Description]            │
│    Tasks 14–16,18–21 │  [What You'll Learn]                     │
│  ■ Review            │  [What the Instructor Assesses]          │
│    Tasks 17, 22      │  [Common Challenges]                     │
│  ■ Final             │  [Practice Tips for Supervisors]         │
│    Task 23           │  [FAQ]                                   │
│                      │                                          │
│  [ProgressFilter     │  [TaskPrerequisiteChain]                 │
│   — auth-only]       │  [TaskRelatedLinks]                      │
│                      │                                          │
│                      │  [Book a Lesson CTA]                     │
└──────────────────────┴──────────────────────────────────────────┘
```

### 5.2 Static Generation

```typescript
// src/app/(public)/competency-hub/[slug]/page.tsx

import { getAllTaskSlugs, getTaskBySlug } from '@/lib/competency-hub/mdx';
import { TaskPageTemplate } from '@/components/competency-hub/TaskPageTemplate';
import { generateTaskJsonLd } from '@/lib/competency-hub/structured-data';
import type { Metadata } from 'next';

export const revalidate = 86400; // ISR: revalidate once per day

export async function generateStaticParams() {
  const slugs = await getAllTaskSlugs(); // reads MDX filenames from content/competency-hub/
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const task = await getTaskBySlug(params.slug);
  if (!task) return {};
  
  return {
    title: task.frontmatter.metaTitle,
    description: task.frontmatter.metaDescription,
    keywords: [task.frontmatter.primaryKeyword, ...task.frontmatter.secondaryKeywords],
    openGraph: {
      title: task.frontmatter.metaTitle,
      description: task.frontmatter.metaDescription,
      url: `https://nexdriveacademy.com.au/competency-hub/${params.slug}`,
      type: 'article',
    },
    alternates: {
      canonical: `https://nexdriveacademy.com.au/competency-hub/${params.slug}`,
    },
  };
}

export default async function TaskPage({ params }: { params: { slug: string } }) {
  const task = await getTaskBySlug(params.slug);
  if (!task) notFound();
  
  const jsonLd = generateTaskJsonLd(task);
  
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <TaskPageTemplate task={task} />
    </>
  );
}
```

### 5.3 TaskProgressBadge — Client Component

This component is the **only** client-side authenticated element on the page. It fetches independently after page load — page is fully rendered without it.

```typescript
// src/components/competency-hub/TaskProgressBadge.tsx
'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';

type CompetencyStatus = 'not_started' | 'taught' | 'assessed' | 'competent' | 'not_yet_competent';

interface TaskProgressBadgeProps {
  taskNumber: number;
}

export function TaskProgressBadge({ taskNumber }: TaskProgressBadgeProps) {
  const { isSignedIn, getToken } = useAuth();
  const [status, setStatus] = useState<CompetencyStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isSignedIn) return;
    setLoading(true);
    
    getToken()
      .then((token) =>
        fetch(`/api/v1/student/competencies?task_number=${taskNumber}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      )
      .then((r) => r.json())
      .then((data) => setStatus(data.status ?? 'not_started'))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, [isSignedIn, taskNumber]);

  if (!isSignedIn || loading || !status) return null;

  const labels: Record<CompetencyStatus, string> = {
    not_started: 'Not Started',
    taught: 'Taught',
    assessed: 'Being Assessed',
    competent: '✓ Competent',
    not_yet_competent: 'Not Yet Competent',
  };

  const colours: Record<CompetencyStatus, string> = {
    not_started: 'bg-gray-100 text-gray-600',
    taught: 'bg-blue-100 text-blue-700',
    assessed: 'bg-yellow-100 text-yellow-700',
    competent: 'bg-green-100 text-green-700',
    not_yet_competent: 'bg-red-100 text-red-700',
  };

  return (
    <div className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium ${colours[status]}`}>
      Your status: {labels[status]}
    </div>
  );
}
```

**API endpoint required:** `GET /api/v1/student/competencies?task_number={n}` — returns `{ task_number, status, transmission, updated_at }`. This endpoint must be implemented in the Student Portal API (SPEC-17). It is already defined in SPEC-17 §5 as part of the competency progress endpoint. The competency-hub component calls it directly; no additional API work is needed in this spec.

---

## 6. Hub Index Page — `/competency-hub`

The index page renders the `TaskHubGrid` — 23 cards grouped by category, with a short intro and a CTA to book a lesson. It is fully static.

### 6.1 Category Groups (matches `competency_tasks.category`)

| Category | Tasks | Count |
|---|---|---|
| Basic Control | 1–6 | 6 |
| Traffic | 7–13 | 7 |
| Complex | 14–16, 18–21 | 7 |
| Review | 17, 22 | 2 |
| Final | 23 | 1 |

### 6.2 Index Page Metadata

```
metaTitle: "ACT CBT&A Competency Hub — 23 Driving Tasks Explained | NexDrive Academy"
metaDescription: "Complete guide to all 23 ACT CBT&A driving competency tasks. Learn what each task involves, what the instructor assesses, and how to practise. Canberra's NexDrive Academy."
canonicalUrl: https://nexdriveacademy.com.au/competency-hub
```

### 6.3 TaskProgressFilter (authenticated sidebar widget)

If the user is a signed-in student, the sidebar includes a progress filter that hides/shows tasks by status. This is a client-side filter on already-rendered DOM — no re-fetch needed once task statuses are loaded.

Filter options: All Tasks · Not Started · In Progress (Taught/Assessed) · Completed

---

## 7. SEO Strategy — All 23 Tasks

### 7.1 Primary Keyword Pattern

Each page targets a compound ACT-specific keyword, structured as:

`"ACT learner driver {task-topic}"` or `"CBT&A task {N} Canberra"` or `"ACT driving test {topic}"`

### 7.2 Full Keyword Map

| Task | Primary Keyword | Secondary Keywords |
|------|----------------|-------------------|
| 1 | ACT learner driver pre-drive checks | CBT&A task 1 Canberra, pre-drive procedure driving lesson ACT |
| 2 | car controls instruments learner driver ACT | CBT&A task 2 Canberra, vehicle instruments driving lesson |
| 3 | moving off stopping learner driver ACT | smooth take-off driving lesson Canberra, CBT&A task 3 |
| 4 | steering technique learner driver ACT | push-pull steering Canberra, CBT&A task 4 driving lesson |
| 5 | gear changing learner driver ACT | smooth gear changes Canberra, CBT&A task 5 manual |
| 6 | low speed manoeuvres ACT | parallel parking Canberra learner, 3-point turn driving test ACT |
| 7 | give way stop sign intersections ACT | CBT&A task 7 Canberra, intersection rules learner driver ACT |
| 8 | traffic lights learner driver ACT | traffic light turning Canberra driving test, CBT&A task 8 |
| 9 | roundabouts learner driver ACT | Canberra roundabout rules, CBT&A task 9 roundabout driving |
| 10 | ACT learner driver lane changing | CBT&A task 10 Canberra, overtaking learner driver ACT |
| 11 | speed management learner driver ACT | school zones ACT driving, speed limits Canberra learner |
| 12 | gap selection learner driver ACT | judging gaps traffic Canberra, CBT&A task 12 |
| 13 | following distance ACT driving | 3-second rule learner driver Canberra, CBT&A task 13 |
| 14 | hazard perception learner driver ACT | ACT hazard perception driving test, CBT&A task 14 Canberra |
| 15 | sharing the road cyclists ACT | vulnerable road users learner driver Canberra, CBT&A task 15 |
| 16 | night driving learner ACT | driving in the dark Canberra learner, CBT&A task 16 |
| 17 | CBT&A review assessment 1-17 ACT | driving review lesson Canberra, tasks 1-17 assessment ACT |
| 18 | driving in traffic learner ACT | multi-lane roads Canberra learner, CBT&A task 18 |
| 19 | freeway driving learner ACT | highway merging Canberra learner driver, CBT&A task 19 |
| 20 | rural country road driving ACT | country driving learner Canberra, CBT&A task 20 |
| 21 | driving in rain fog ACT | adverse conditions learner driver Canberra, CBT&A task 21 |
| 22 | CBT&A review assessment 18-22 ACT | final review driving Canberra, tasks 18-22 assessment |
| 23 | final drive assessment ACT | CBT&A final assessment Canberra, ACT driving test requirements |

### 7.3 Internal Linking Rules

- Every task page links to its **prerequisite tasks** in the "Before You Start This Task" section.
- Review tasks (17 and 22) link to **all tasks they require** with a "Prerequisites for this review" block.
- Task 23 links to both Task 17 and Task 22.
- Each task includes a "See Also" section linking to `relatedTasks` from frontmatter.
- The hub index links to all 23 task pages.
- Every task page links back to the hub index via breadcrumb.
- The booking CTA at the bottom of each page links to `/book`.

### 7.4 On-Page SEO Checklist (per task page)

- H1 includes task number and name with "ACT" or "Canberra" signal
- First 100 words contain primary keyword naturally
- One `<strong>` element for key term in first paragraph
- Alt text on any images: "NexDrive Academy — CBT&A Task {N} — {description}"
- Canonical URL set in `generateMetadata`
- OpenGraph title/description set
- JSON-LD schema (see §8)

---

## 8. Schema Markup (JSON-LD)

### 8.1 Standard Task Pages — HowTo Schema

Use `HowTo` for tasks 1–16 and 18–21 (skills the learner actively learns to do).

```typescript
// src/lib/competency-hub/structured-data.ts

export function generateHowToSchema(task: TaskMdxData) {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: task.frontmatter.title,
    description: task.frontmatter.metaDescription,
    estimatedCost: {
      '@type': 'MonetaryAmount',
      currency: 'AUD',
      value: '0',                         // this page is free educational content
    },
    totalTime: task.frontmatter.estimatedTime,
    tool: [
      {
        '@type': 'HowToTool',
        name: 'Licensed motor vehicle',
      },
      {
        '@type': 'HowToTool',
        name: 'Supervising driver (licensed 2+ years)',
      },
    ],
    step: task.frontmatter.assessmentCriteria.map((criterion, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: criterion.title,
      text: criterion.description,
    })),
    provider: {
      '@type': 'LocalBusiness',
      name: 'NexDrive Academy',
      url: 'https://nexdriveacademy.com.au',
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Canberra',
        addressRegion: 'ACT',
        addressCountry: 'AU',
      },
    },
  };
}
```

### 8.2 Review & Final Assessment Pages — EducationalOccupationalCredential

Use for tasks 17, 22, and 23.

```typescript
export function generateCredentialSchema(task: TaskMdxData) {
  return {
    '@context': 'https://schema.org',
    '@type': 'EducationalOccupationalCredential',
    name: task.frontmatter.title,
    description: task.frontmatter.metaDescription,
    credentialCategory: 'Assessment',
    recognizedBy: {
      '@type': 'GovernmentOrganization',
      name: 'ACT Government — Transport Canberra and City Services',
      url: 'https://www.transport.act.gov.au',
    },
    educationalLevel: 'Learner Driver',
    competencyRequired: task.frontmatter.reviewRequiresTasks.map((n) => ({
      '@type': 'DefinedTerm',
      name: `CBT&A Task ${n}`,
      url: `https://nexdriveacademy.com.au/competency-hub/task-${n}-${taskSlugMap[n]}`,
    })),
  };
}
```

### 8.3 Dispatch Logic

```typescript
export function generateTaskJsonLd(task: TaskMdxData) {
  if (task.frontmatter.isReview || task.frontmatter.isFinalDrive) {
    return generateCredentialSchema(task);
  }
  return generateHowToSchema(task);
}
```

---

## 9. RAG Integration

### 9.1 Content → RAG Pipeline

Each MDX task page is ingested into the RAG engine as a single `rag_documents` record with `source_type = 'educational'`. The `competency_hub_content_id` column on the `competency_tasks` table stores the resulting `rag_documents.id`, linking the DB task record to its RAG document.

```
MDX file
  → build-time script (scripts/sync-competency-hub-to-rag.ts)
    → extract sections as structured text
    → call POST /api/internal/rag/index (from SPEC-08)
    → receive rag_documents.id
    → UPDATE competency_tasks SET competency_hub_content_id = {id}
         WHERE task_number = {frontmatter.taskNumber}
```

### 9.2 Ingestion Script — `scripts/sync-competency-hub-to-rag.ts`

```typescript
import { getAllTasks } from '@/lib/competency-hub/mdx';
import { db } from '@/db';
import { competencyTasks } from '@/db/schema';
import { eq } from 'drizzle-orm';

async function syncCompetencyHubToRag() {
  const tasks = await getAllTasks(); // returns all 23 MDX files parsed

  for (const task of tasks) {
    const { frontmatter, content } = task;

    // Build plain text for RAG (strip MDX components, keep prose)
    const plainText = extractRagText(content);

    // Structured metadata for chunk tagging (per SPEC-08 §4.3 metadata tagger)
    const metadata = {
      task_numbers: [frontmatter.taskNumber],
      category: frontmatter.category,
      is_review: frontmatter.isReview,
      is_final_drive: frontmatter.isFinalDrive,
      prerequisites: frontmatter.prerequisites,
      source_page: `https://nexdriveacademy.com.au/competency-hub/${frontmatter.slug}`,
    };

    // Call RAG ingestion API (SPEC-08 POST /api/internal/rag/index)
    const response = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/internal/rag/index`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.INTERNAL_API_SECRET!,
      },
      body: JSON.stringify({
        title: frontmatter.title,
        source_type: 'educational',
        content: plainText,
        metadata,
      }),
    });

    const { document_id } = await response.json();

    // Link back to competency_tasks table
    await db
      .update(competencyTasks)
      .set({ competencyHubContentId: document_id })
      .where(eq(competencyTasks.taskNumber, frontmatter.taskNumber));

    console.log(`✓ Task ${frontmatter.taskNumber} → RAG doc ${document_id}`);
  }
}

syncCompetencyHubToRag().catch(console.error);
```

### 9.3 RAG Query Metadata Filter

When the RAG engine (SPEC-08) receives a query about a specific task, it can filter chunks by `metadata->>'task_numbers'` to reduce noise. The RAG engine already supports this via its existing `task_number` filter (SPEC-08 §5.4).

### 9.4 Trigger Schedule

The sync script runs:
- **On first deploy** (post-Phase 5 launch): manually via `npm run sync:competency-rag`
- **On MDX content change**: triggered by a Vercel deploy hook (any push to `content/competency-hub/`)
- **Weekly reindex**: Vercel cron job at Sunday 02:00 AEST — calls `POST /api/internal/rag/reindex` for all `source_type = 'educational'` documents

---

## 10. Navigation Components

### 10.1 Hub Sidebar — `TaskSidebar.tsx`

```typescript
interface TaskSidebarProps {
  currentTaskNumber: number;
  studentStatuses?: Record<number, CompetencyStatus>; // injected if authenticated
}
```

Renders category groups in fixed order: Basic Control → Traffic → Complex → Review → Final. Each task entry is a link with:
- Task number badge
- Short task name
- If `studentStatuses` provided: coloured status indicator (dot)
- Current task highlighted with `aria-current="page"`

### 10.2 Mobile Navigation

On mobile (`< lg`), the sidebar collapses into a sticky bottom drawer triggered by a "All Tasks" button. The drawer renders the same `TaskSidebar` component.

### 10.3 Breadcrumbs

```
Home  ›  Competency Hub  ›  Task 10 — Lane Changing & Overtaking
```

Breadcrumbs include BreadcrumbList JSON-LD via the structured-data module.

### 10.4 Hub Index Category Grid

The `/competency-hub` index page shows five category cards, each expandable to list its tasks. This is a static `<details>`/`<summary>` accordion — no JS required.

---

## 11. MDX Loader — `lib/competency-hub/mdx.ts`

```typescript
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { compileMDX } from 'next-mdx-remote/rsc';
import { taskComponents } from '@/components/competency-hub/mdx-components';

const CONTENT_DIR = path.join(process.cwd(), 'content/competency-hub');

export async function getAllTaskSlugs(): Promise<string[]> {
  const files = await fs.readdir(CONTENT_DIR);
  return files
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.replace('.mdx', ''));
}

export async function getTaskBySlug(slug: string): Promise<TaskMdxData | null> {
  const filePath = path.join(CONTENT_DIR, `${slug}.mdx`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const { data, content } = matter(raw);
    const { content: compiled } = await compileMDX({
      source: content,
      components: taskComponents,
      options: { parseFrontmatter: false },
    });
    return {
      frontmatter: data as TaskFrontmatter,
      content: compiled,
      rawContent: content,   // kept for RAG ingestion text extraction
      slug,
    };
  } catch {
    return null;
  }
}

export async function getAllTasks(): Promise<TaskMdxData[]> {
  const slugs = await getAllTaskSlugs();
  const tasks = await Promise.all(slugs.map(getTaskBySlug));
  return tasks
    .filter(Boolean)
    .sort((a, b) => a!.frontmatter.taskNumber - b!.frontmatter.taskNumber) as TaskMdxData[];
}
```

**MDX Components map** (`taskComponents`): `Section`, `FAQ`, `PracticeRouteSuggestion`. These are the only custom MDX components. All other content is standard Markdown.

---

## 12. Content Brief — All 23 Tasks

The following table defines the content requirement for each task page. All pages follow the MDX template in §4.2. Each page requires approximately 600–900 words of body content (excluding frontmatter and component props). **Content must be reviewed and approved by Rob before publish.**

| Task | Name | What Instructor Assesses (key items) | Practice Tip Focus | Unique FAQ Topics |
|------|------|--------------------------------------|-------------------|-------------------|
| 1 | Pre-Drive Procedure | Seatbelt, mirrors, headrest, select P/N, handbrake | Check items in sequence every time — make it a habit before touching controls | When does this get assessed? Do I need to do it every time? |
| 2 | Controls & Instruments | Identifies gauges correctly, knows instrument panel, explains warning lights | Point at each control and explain to supervisor aloud — teaches by explaining | What happens if a warning light comes on mid-lesson? |
| 3 | Moving Off & Stopping | Smooth clutch release (manual), no kangaroo starts, stopping distance appropriate | Empty car park for first sessions — find the biting point slowly | How many practice hours on this before next lesson? |
| 4 | Steering | Correct hand position, smooth inputs, no crossing hands at speed | Stay in carparks, count hand movements, avoid death-grip | Is hand-over-hand ever OK? |
| 5 | Gear Changing | Smooth transitions, no crunching, selects correct gear for road speed | Manual: practise on quiet flat roads, focus on smooth clutch not speed | Does auto transmission count for this task? |
| 6 | Low Speed Manoeuvres | Reference points for park, turns completed safely, observations | Find a quiet industrial estate, practise reverse park 20+ times | Which type of parking is hardest — does it matter which I learn first? |
| 7 | Give Way / Stop Signs | Full stop at stop signs, gives way correctly, position in intersection | Drive routes with stop signs in Belconnen — practise decision-making | What's the most common fail point on this task? |
| 8 | Traffic Lights | Responds to amber correctly, turns legally on arrows, watches pedestrians | Find a route with multiple traffic light intersections — observe timing | What if the lights are broken? |
| 9 | Roundabouts | Signals correctly, gives way to right, selects lane for exit | Multi-lap practice at quiet roundabout — City Hill or Dickson precinct | Canberra has a lot of roundabouts — is this extra important here? |
| 10 | Lane Changing & Overtaking | Mirror–signal–mirror–blind spot–move sequence, smooth steering, correct speed | Northbourne Ave / Flemington Rd for consistent multi-lane practice | How do I know when it's safe to change lanes? |
| 11 | Speed Management | Stays in zone, adjusts for conditions, responds to school zone times | Vary routes — get exposure to 40, 50, 60, 80, 100 km/h zones in ACT | What are the school zone times in ACT? |
| 12 | Gap Selection | Waits for safe gap, doesn't rush, judges speed of oncoming traffic | T-intersections on moderately busy roads — Hibberson St, Tuggeranong Pky entries | How big does a gap need to be? Is there a rule? |
| 13 | Following Distance | Maintains 3-second gap, adjusts in wet, drops back for large vehicles | Highway driving, Tuggeranong or Barton Highway — count seconds aloud | Does it need to be exactly 3 seconds? |
| 14 | Hazard Perception | Scans ahead, identifies and responds to hazards early, commentary driving | Commentary driving — narrate what they see. City runs at peak hour | Can I practise hazard perception at home? (HPT app) |
| 15 | Sharing the Road | Passes cyclists safely, gives pedestrians right of way, adjusts for trucks | City routes: Civic, Kingston, Braddon — high vulnerable-user exposure | How much space do I need to give cyclists in ACT? |
| 16 | Night Driving | Correct beam use, reduces speed, adapts to reduced visibility | Pick 2–3 familiar routes and drive them after dark — don't add new challenges | Do I need a certain number of night hours for my logbook? |
| 17 | Review Assessment 1–17 | Cumulative — all tasks 1–16 assessed in one continuous drive | Treat it like a real assessment — no prompting from supervisor during review | What happens if I don't pass the review? Can I redo it? |
| 18 | Driving in Traffic | Merges, manages heavy flow, positions correctly in lanes | Drakeford Drive, Tuggeranong Pkwy during peak — sustained complex traffic | Is city traffic harder than suburban? |
| 19 | Freeway / Highway Driving | Merges at speed, exits safely, maintains highway speed, no hesitation | Barton Highway to Yass and back — entry/exit ramps are the key skill | Is the Tuggeranong Pkwy considered a freeway for this task? |
| 20 | Rural / Country Roads | Adjusts for unsealed surfaces, overtakes safely, manages fatigue risk | Bungendore or Murrumbateman run — unsealed section and single-lane bridge | Do I have to go on an unsealed road? Where near Canberra? |
| 21 | Adverse Conditions | Reduced speed in rain, uses wipers/lights correctly, adjusts following distance | Can't be manufactured — plan 2–3 rainy day drives deliberately | What if it doesn't rain during my log hours? |
| 22 | Review Assessment 18–22 | Cumulative — tasks 18–21 in one continuous drive including variety of roads | Pre-review lesson recommended — discuss any uncertainties with Rob first | What's the difference between Review 2 and the Final Drive? |
| 23 | Final Drive Assessment | 45 min minimum, unfamiliar roads, all competencies live, dual assessment | Spend at least 2 lessons on unfamiliar routes before booking final drive | What roads are considered "unfamiliar"? Who decides? |

---

## 13. Parent/Supervisor Section — Per-Task Practice Guides

Every task page includes a `<Section id="practice-tips">` (§4.2) written specifically for parents and supervising drivers. The guide answers:

1. **Where to practise** — ACT-specific road/suburb recommendations matching the skill level
2. **How to give feedback** — tone, timing, language (e.g., "say X, not Y")
3. **How long to practise** — suggested supervised hours before next professional lesson
4. **What to watch for** — 2–3 observable safety concerns the supervisor should note
5. **When to stop** — signs that the session should end early

**Tone note:** Written as if Rob is talking to the parent after a lesson — warm, practical, specific to Canberra roads.

### Practice Route Suggestions Component

```typescript
interface PracticeRouteSuggestionProps {
  areaName: string;         // e.g., "Belconnen Town Centre"
  description: string;      // e.g., "Multiple roundabouts and give-way intersections"
  difficulty: 'beginner' | 'intermediate' | 'advanced';
}
```

The component renders as a callout card with a map pin icon. It is static — no map API call required. Authors add 1–3 per page where relevant.

---

## 14. Dependencies & Integration Points

| System | What C17 Needs | Source |
|--------|---------------|--------|
| Student Portal API (SPEC-17) | `GET /api/v1/student/competencies?task_number={n}` — returns status for authenticated student | SPEC-17 §5 |
| RAG Engine (SPEC-08) | `POST /api/internal/rag/index` — ingests page content on build | SPEC-08 §6.3 |
| RAG Engine (SPEC-08) | `POST /api/internal/rag/reindex` — weekly re-index cron | SPEC-08 §6.4 |
| DB — `competency_tasks` | `UPDATE competency_hub_content_id` after ingestion | SPEC-01 §5.13 |
| Clerk (SPEC-02) | `useAuth()` in `TaskProgressBadge` — read-only session check | SPEC-02 §4 |
| Booking Widget (C02) | Embedded CTA at bottom of each task page → `/book` | Static link |

---

## 15. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| LCP | < 2.0s (all pages static/ISR) |
| SEO — Indexed | All 23 pages crawlable and indexed within 2 weeks of deploy |
| Accessibility | WCAG 2.1 AA — semantic headings, skip nav, keyboard nav for sidebar |
| Mobile | Fully responsive — sidebar collapses on mobile, bottom drawer for task nav |
| RAG sync lag | Content changes reflected in RAG within 24 hours (weekly cron max lag) |
| Analytics | Page view events via PostHog — `competency_hub_page_viewed` with `task_number` property |

---

## 16. Analytics Events

```typescript
// Emit via PostHog (posthog.capture) in TaskPageTemplate useEffect

posthog.capture('competency_hub_page_viewed', {
  task_number: taskFrontmatter.taskNumber,
  task_name: taskFrontmatter.shortTitle,
  category: taskFrontmatter.category,
  is_authenticated: isSignedIn,
  student_status: studentStatus ?? 'unauthenticated',
});
```

Track on hub index: `competency_hub_index_viewed`.  
Track category group expand: `competency_hub_category_expanded` with `{ category }`.

---

## 17. Content Production Workflow

1. **Generate draft** — Use Claude API (claude-sonnet-4-5) with this prompt template per task:
   ```
   You are Rob Harrison, an ADI-certified driving instructor in Canberra ACT.
   Write the competency hub content for CBT&A Task {N}: {task_name}.
   Official description: {description}
   Target reader: ACT learner drivers aged 17–25 and their supervising parents.
   Tone: warm, practical, Canberra-specific. Australian English. No jargon.
   Output: MDX body sections in the order: overview, official-description, what-youll-learn,
   what-instructor-assesses, common-challenges, practice-tips, faq, prerequisite-note.
   Length: 700–900 words total body.
   ```

2. **Rob reviews** — each page reviewed for accuracy and ADI compliance before commit
3. **Commit to `content/competency-hub/`** — triggers Vercel deploy
4. **RAG sync** — runs automatically post-deploy
5. **SEO review** — check Search Console indexing within 2 weeks of launch

---

## 18. Acceptance Criteria

- [ ] All 23 MDX files exist and pass frontmatter schema validation (`npm run validate:competency-hub`)
- [ ] All 23 pages render at correct URLs with correct metadata
- [ ] `generateStaticParams` returns all 23 slugs; `next build` succeeds with no missing params
- [ ] `TaskProgressBadge` renders correct status for a signed-in test student; renders nothing for anonymous visitor
- [ ] JSON-LD validates via Google Rich Results Test for at least 5 task pages
- [ ] Hub index page displays all 23 tasks in correct category groups
- [ ] Sidebar highlights current task with `aria-current="page"`
- [ ] All 23 pages ingested into `rag_documents` with `status = 'indexed'`; `competency_tasks.competency_hub_content_id` populated for all 23 rows
- [ ] RAG query for "what is task 14" returns content from the task-14 MDX
- [ ] Mobile sidebar drawer works at 375px viewport
- [ ] All 23 pages score ≥ 90 Lighthouse SEO
- [ ] `competency_hub_page_viewed` PostHog event fires on each page load
- [ ] Internal links: every page links to its prerequisites; review tasks link to all required tasks

---

*SPEC-20 v1.0 — NexDrive Academy Competency Hub Content*  
*Phase 5 Component | Weeks 29–34 | Estimated: 8–12 days*  
*Depends on: SPEC-01, SPEC-02, SPEC-08, SPEC-17*
