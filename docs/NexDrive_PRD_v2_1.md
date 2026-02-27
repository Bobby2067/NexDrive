# NexDrive Academy — Product Requirements Document
### BMAD Phase 2 | Product Manager Agent
**Version:** 2.0  
**Date:** 20 February 2026  
**Status:** Complete  
**Depends On:** Product Brief v2.0, System Architecture v1.1  
**Project Complexity:** Level 3 (Enterprise)

**v2.0 Changelog:**
- Replaced BookitLive SaaS integration with custom booking engine (per ADR-007)
- Replaced Supabase Auth with Clerk authentication (per ADR-001)
- Replaced Supabase RLS with application-level RBAC (per ADR-004)
- Replaced Pinecone with pgvector in Neon (per ADR-005)
- Updated API contracts to reflect Clerk webhooks and custom booking endpoints
- Updated BMAD phase status (Phase 3 complete)
- Aligned all references to Architecture v1.1 stack decisions

---

## 1. Document Purpose

This PRD translates the NexDrive Academy Product Brief into implementable requirements. Every feature is expressed as user stories with acceptance criteria, grouped by module and prioritized by implementation phase. Technical specifications, API contracts, and data models are included where they constrain implementation decisions.

---

## 2. Scope & Boundaries

### In Scope
- 10 platform modules as defined in the Product Brief
- 4 user roles: Prospect, Student, Parent/Supervisor, Instructor (Rob), Admin
- ACT CBT&A compliance for 23 competency tasks + 2 reviews + Final Drive
- AI/RAG chatbot with 3 modes (prospect, student, parent)
- Custom booking engine + Stripe + PayPal integration
- Mobile-first instructor workstation with offline capability
- Australian data residency (Sydney region)

### Out of Scope (Future Consideration)
- Multi-instructor support (Rob is sole instructor for v1)
- Native iOS/Android apps for students (web app with PWA for v1; React Native for instructor only)
- White-label or franchise model
- International markets or non-ACT regulatory compliance
- Full LMS with graded assessments
- Real-time video/telehealth lessons

### Assumptions
1. Rob is the sole instructor and primary admin user for launch
2. Custom booking engine handles all scheduling, availability, and booking lifecycle natively within the platform
3. ACT Government does not mandate a specific digital system — digital records are accepted if audit-compliant
4. Students have smartphones with modern browsers (Chrome/Safari, last 2 versions)
5. Parents may use desktop or mobile; no assumption of technical sophistication
6. Internet connectivity is available for most operations; instructor workstation must handle offline gracefully

---

## 3. Global Non-Functional Requirements

### NFR-1: Performance
| Metric | Target | Measurement |
|--------|--------|-------------|
| Page load (LCP) | <2.5s | Lighthouse, all pages |
| Time to Interactive | <3.5s | Lighthouse |
| API response (p95) | <500ms | Server-side monitoring |
| AI chatbot response | <3s | End-to-end, including RAG retrieval |
| Offline sync resolution | <10s | After connectivity restored |

### NFR-2: Availability
- **Target:** 99.5% uptime (excluding scheduled maintenance)
- **Scheduled maintenance window:** Tuesday 2:00-4:00 AM AEST
- **Degraded mode:** If any external service is unavailable, display cached data where possible + fallback contact form

### NFR-3: Security
- All data encrypted at rest (AES-256) and in transit (TLS 1.3)
- Authentication via Clerk with session tokens, MFA, and passkey support
- Role-Based Access Control enforced at application layer (service-level middleware)
- Session timeout: 30 minutes inactive (student/parent), 8 hours (instructor during active lesson day), configurable
- Rate limiting: 100 req/min unauthenticated, 300 req/min authenticated (Upstash Redis)
- OWASP Top 10 compliance verified pre-launch

### NFR-4: Accessibility
- WCAG 2.1 AA compliance on all public pages
- Keyboard navigation for all interactive elements
- Screen reader compatible (ARIA labels)
- Minimum contrast ratio 4.5:1
- Touch targets ≥44x44px on mobile

### NFR-5: Data Residency & Privacy
- Primary database: Neon PostgreSQL, Sydney region (ap-southeast-2)
- File storage: Cloudflare R2, Sydney
- No data leaves Australian jurisdiction without explicit consent
- Privacy policy with granular consent management
- Right to data export (JSON/CSV) for any user
- Right to deletion with audit trail exception (competency records retained per ACT requirements)

### NFR-6: Browser & Device Support
- **Desktop:** Chrome, Firefox, Safari, Edge (last 2 versions)
- **Mobile:** iOS Safari 15+, Chrome Android 100+
- **Instructor Workstation:** Optimized for iPhone 12+ and Samsung Galaxy S21+ (Rob's likely devices)
- **Minimum viewport:** 320px width

---

## 4. Data Model (Core Entities)

### Entity Relationship Summary

```
User (1) ──────── (M) Booking
  │                      │
  │ role: student         │ custom booking engine
  │ role: parent          │
  │ role: instructor      │
  │ role: admin           │
  │                      │
  ├──── (1) StudentProfile ────── (M) CompetencyRecord
  │         │                           │
  │         │                           ├── task_id (1-23)
  │         │                           ├── status: C/NYC
  │         │                           ├── instructor_signature
  │         │                           ├── student_signature
  │         │                           ├── hash (SHA-256)
  │         │                           └── metadata (GPS, time, device)
  │         │
  │         ├──── (M) LessonRecord
  │         │         ├── date, duration, type
  │         │         ├── tasks_covered[]
  │         │         ├── notes (instructor)
  │         │         ├── conditions (day/night, weather, road type)
  │         │         └── bridge_form_id
  │         │
  │         ├──── (M) LogbookEntry
  │         │         ├── date, start_time, end_time
  │         │         ├── supervisor_id
  │         │         ├── conditions
  │         │         └── hours_credited
  │         │
  │         └──── (1) ProgressSummary (materialized view)
  │                   ├── total_hours, night_hours
  │                   ├── professional_hours
  │                   ├── tasks_completed / 23
  │                   ├── review_1_17_status
  │                   ├── review_1_22_status
  │                   └── final_drive_eligible: boolean
  │
  ├──── (1) ParentProfile
  │         ├── linked_students[]
  │         └── resource_access_log[]
  │
  └──── (1) InstructorProfile
            ├── credentials
            ├── active_students[]
            └── schedule_config

Payment ──── Booking
  ├── stripe_payment_id
  ├── amount, currency (AUD)
  ├── status
  ├── package_id (nullable)
  └── invoice_url

Package
  ├── type (10-hour block, etc.)
  ├── total_hours, used_hours
  ├── credit_multiplier (3:1 for first 10)
  └── payment_id

BridgeForm
  ├── lesson_id
  ├── skills_covered[]
  ├── positives[]
  ├── improvements[]
  ├── supervisor_instructions
  └── focus_areas[]

ReviewAssessment
  ├── type: "1-17" | "1-22"
  ├── component_tasks[] with C/NYC
  ├── dual_signatures
  ├── hash (SHA-256)
  └── overall_result

FinalDrive
  ├── prerequisites_verified: boolean
  ├── route_description
  ├── duration_minutes (≥45)
  ├── road_types[]
  ├── result: Pass/Fail
  ├── detailed_feedback
  ├── dual_signatures
  └── hash (SHA-256)

ChatConversation
  ├── user_id (nullable for prospects)
  ├── mode: prospect | student | parent
  ├── messages[]
  ├── lead_captured: boolean
  └── handoff_requested: boolean

RAGDocument
  ├── source_file
  ├── chunk_id
  ├── embedding_vector
  ├── metadata (category, task_id, confidence)
  └── last_indexed
```

---

## 5. Module 1: Public Website & SEO Engine

### Epic 1.1: Core Website Structure

**US-1.1.1: Homepage**
> As a **prospect**, I want to land on a professional homepage that immediately communicates what makes NexDrive different, so I can decide whether to explore further.

**Acceptance Criteria:**
- [ ] Full-width hero with headline "Hours Build Familiarity. We Build Judgement.", subheadline, primary CTA ("Book Your First Lesson"), secondary link ("See How We Teach")
- [ ] Trust strip with 3-4 stats (e.g., "20+ Years Experience", "National Motorsport Competitor", "Train-the-Trainer Co-Lessons")
- [ ] "Our Approach" section with body copy from Content Library
- [ ] 6 feature cards (Real-World Teaching, Feel the Car, Patient & Calm, Honest Feedback, Maximum Value, Support for Home Practice)
- [ ] Co-Lessons highlight section with CTA
- [ ] 3 testimonial cards (placeholder initially, real when available)
- [ ] Final CTA section
- [ ] AI chatbot widget visible in bottom-right corner
- [ ] Page scores ≥90 on Lighthouse Performance
- [ ] All content matches NexDrive Website Content Library document

**US-1.1.2: About Rob Ogilvie**
> As a **prospect**, I want to learn about Rob's credentials and teaching philosophy so I can trust him with my (or my child's) instruction.

**Acceptance Criteria:**
- [ ] Hero statement with page headline and subheading
- [ ] Full bio copy from Content Library (motorsport background, teaching philosophy, founding story)
- [ ] Credentials snapshot as card grid (8 items: Licensed since 2002, AAMI Defensive Driving, motorsport career, Sandown 500 5th, rally top-10, vehicle dynamics, advanced driving, corporate training)
- [ ] Teaching Philosophy section (coaching vs assessing, communication, progressive challenge)
- [ ] Photo of Rob (placeholder until provided)
- [ ] CTA to book

**US-1.1.3: Services Page**
> As a **prospect**, I want to see all lesson types with transparent pricing so I can choose what suits me.

**Acceptance Criteria:**
- [ ] Service cards for each type: Learner Lessons (1hr/2hr), Co-Lessons, Pre-Test Preparation, Advanced/Refresher, Defensive Driving, Corporate Training, Confidence Coaching (Nervous Students)
- [ ] Pricing displayed per service (configurable via Admin Panel)
- [ ] Package options (10-hour blocks) with savings highlighted
- [ ] 3:1 credit explanation for first 10 professional hours
- [ ] Each service card links to booking flow (select service → view availability → book)
- [ ] "Most Popular" badge on recommended option

**US-1.1.4: For Supervising Drivers Page**
> As a **parent**, I want to understand why and how NexDrive supports me as a supervisor so I feel confident choosing them.

**Acceptance Criteria:**
- [ ] Addresses parent reality (anxiety, conflict, uncertainty)
- [ ] Explains what NexDrive gives supervisors (Lesson Bridge Forms, co-lessons, coaching resources, video library)
- [ ] Five Principles of effective supervising (from Content Library)
- [ ] Co-lesson CTA prominently placed
- [ ] Link to Parent Resource Center (authenticated section)
- [ ] Emotional tone: empathetic, non-judgmental, reassuring

**US-1.1.5: FAQ Page**
> As a **prospect**, I want answers to common questions without needing to call or chat.

**Acceptance Criteria:**
- [ ] Minimum 20 FAQ items covering: booking, pricing, cancellation policy, what to bring, lesson structure, logbook credit, CBT&A process, nervous students, co-lessons, test preparation, payment options, coverage areas
- [ ] Accordion UI with smooth expand/collapse
- [ ] Schema.org FAQPage structured data markup
- [ ] Search/filter functionality
- [ ] CTA at bottom ("Still have questions? Chat with us" → opens chatbot)

**US-1.1.6: Contact / Book Page**
> As a **prospect**, I want to book a lesson with minimal friction.

**Acceptance Criteria:**
- [ ] Custom booking widget (4-step flow: select service → select date/time → enter details → confirm/pay)
- [ ] Booking widget built natively within the platform (no third-party embed)
- [ ] Fallback contact form if booking system is temporarily unavailable
- [ ] Phone number, email, business hours displayed
- [ ] Google Maps embed showing coverage area
- [ ] Service area suburbs listed

### Epic 1.2: SEO & Content Engine

**US-1.2.1: Blog/Content Section**
> As **the business**, I want a blog that targets long-tail driving school keywords so NexDrive ranks organically.

**Acceptance Criteria:**
- [ ] MDX-based blog with Next.js static generation
- [ ] Categories: Learning to Drive, For Parents, Road Rules, Test Preparation, Safety
- [ ] SEO metadata per post (title, description, OG image, canonical URL)
- [ ] Schema.org Article markup
- [ ] Author attribution (Rob Ogilvie)
- [ ] Related posts section
- [ ] Social sharing buttons
- [ ] RSS feed

**US-1.2.2: Free SEO Tools**
> As **the business**, I want free interactive tools that attract organic traffic and demonstrate expertise.

**Acceptance Criteria:**
- [ ] ACT Driver Knowledge Test practice quiz (minimum 50 questions, randomized, scored)
- [ ] Hazard Perception Test explainer with sample scenarios
- [ ] "Am I Ready for My Test?" self-assessment checklist
- [ ] Each tool has its own URL, page title, and meta description for SEO
- [ ] Lead capture optional ("Get your results emailed" → email collection)
- [ ] Schema.org markup for rich snippets

**US-1.2.3: Technical SEO**
> As **the business**, I want the site technically optimized for Google.

**Acceptance Criteria:**
- [ ] Server-side rendering (SSR) for all public pages
- [ ] Dynamic sitemap.xml auto-generated
- [ ] robots.txt configured
- [ ] Canonical URLs on all pages
- [ ] Open Graph and Twitter Card meta tags
- [ ] Schema.org LocalBusiness markup on homepage
- [ ] Schema.org FAQPage on FAQ
- [ ] Core Web Vitals: LCP <2.5s, FID <100ms, CLS <0.1
- [ ] Image optimization with next/image (WebP, lazy loading)
- [ ] Internal linking strategy between Competency Hub, Blog, Services

---

## 6. Module 2: AI/RAG Chatbot

### Epic 2.1: RAG Pipeline

**US-2.1.1: Document Ingestion & Indexing**
> As an **admin**, I want to upload documents to the RAG knowledge base so the chatbot can answer questions from authoritative sources.

**Acceptance Criteria:**
- [ ] Admin UI for uploading documents (PDF, DOCX, TXT, MD)
- [ ] Automatic text extraction and cleaning
- [ ] Text chunking: 512 tokens per chunk, 128 token overlap, respecting paragraph boundaries
- [ ] Embedding generation: OpenAI text-embedding-3-large (3072 dimensions)
- [ ] Vector storage in Neon pgvector (native PostgreSQL extension, Sydney region — co-located with application data)
- [ ] Metadata per chunk: source_file, category (road_rules | teaching_philosophy | cbta_task | parent_guide | faq | policy), task_id (if applicable), page_number
- [ ] Re-indexing capability (update existing document without duplicates)
- [ ] Index status dashboard showing document count, chunk count, last indexed date
- [ ] Initial corpus: 500+ documents minimum

**US-2.1.2: Query Processing & Retrieval**
> As a **user**, I want the chatbot to find relevant information quickly and accurately from the knowledge base.

**Acceptance Criteria:**
- [ ] User query → embedding → top-K semantic search (K=5, configurable)
- [ ] Similarity threshold: minimum cosine similarity 0.75 (configurable)
- [ ] Metadata filtering: if user is on a specific Competency Hub task page, bias retrieval toward that task's category
- [ ] Context assembly: retrieved chunks formatted with source attribution for LLM prompt
- [ ] If no chunks meet threshold → respond with "I don't have specific information about that, but I can help you contact Rob" (never hallucinate)
- [ ] Query latency: <1s for retrieval step

**US-2.1.3: Response Generation**
> As a **user**, I want accurate, helpful, and cited answers from the chatbot.

**Acceptance Criteria:**
- [ ] LLM: Claude API (claude-sonnet-4-20250514 for cost efficiency, claude-opus-4-6 for complex queries — configurable)
- [ ] System prompt enforces: answer ONLY from provided context, cite sources, maintain NexDrive brand voice (warm, patient, encouraging), never give medical/legal advice, escalate to human when uncertain
- [ ] Response includes source citations (e.g., "According to ACT CBT&A Task 12...")
- [ ] Confidence scoring: if LLM confidence <0.7, append "For specific guidance, I'd recommend discussing this with Rob during your next lesson"
- [ ] Maximum response length: 300 words (configurable)
- [ ] Streaming responses for perceived speed

### Epic 2.2: Chat Interface

**US-2.2.1: Webchat Widget (Public)**
> As a **prospect**, I want to ask questions via a chat bubble on the website and get instant answers.

**Acceptance Criteria:**
- [ ] Floating chat bubble (bottom-right, NexDrive brand color)
- [ ] Expand to chat window (400px wide × 500px tall, responsive on mobile)
- [ ] Welcome message: "Hi! I'm NexDrive's AI assistant. I can answer questions about lessons, pricing, the CBT&A process, or help you book. What would you like to know?"
- [ ] Text input with send button and Enter key support
- [ ] Typing indicator during response generation
- [ ] Streaming response display (word by word)
- [ ] Conversation persisted in localStorage for session continuity
- [ ] "Talk to Rob" button triggers lead capture form (name, phone, email, question) OR direct transfer during business hours
- [ ] Available on ALL public pages

**US-2.2.2: Authenticated Chat (Student Mode)**
> As a **student**, I want the chatbot to know my progress and give me personalized answers.

**Acceptance Criteria:**
- [ ] When logged in, chatbot has access to: student's completed tasks, current task in progress, lesson history, upcoming bookings, logbook hours
- [ ] Contextual responses: "You've completed 14 of 23 tasks. Your next focus is Task 15 — Lane Changing. Here's what you need to know..."
- [ ] Can answer "What should I practice before my next lesson?" based on last Lesson Bridge Form
- [ ] Can answer "Am I ready for my test?" based on competency completion status
- [ ] Chat history persisted in database (not just localStorage)
- [ ] Full chat interface in Student Portal sidebar

**US-2.2.3: Authenticated Chat (Parent Mode)**
> As a **parent**, I want the chatbot to help me understand how to support my learner.

**Acceptance Criteria:**
- [ ] When logged in as linked parent, chatbot has access to: linked student's progress, recent Lesson Bridge Forms, recommended practice areas
- [ ] Can answer "What should we practice this week?" based on latest Bridge Form
- [ ] Can explain coaching techniques: "Instead of saying 'slow down', try asking 'what speed feels safe for this road?'"
- [ ] Routes complex questions to Parent Resource Center content
- [ ] Lead capture for co-lesson booking when relevant

### Epic 2.3: Lead Capture & Handoff

**US-2.3.1: Prospect Lead Capture**
> As **the business**, I want the chatbot to capture prospect information when they show booking intent.

**Acceptance Criteria:**
- [ ] Detect booking intent keywords ("book", "price", "available", "start", "how much")
- [ ] Offer: "I can help you book! Would you like to: (1) Book online now, or (2) Have Rob call you back?"
- [ ] Option 1 → redirect to booking page (custom booking flow)
- [ ] Option 2 → collect: name, phone, email, preferred callback time, brief question
- [ ] Lead stored in CRM with source="chatbot", timestamp, conversation_id
- [ ] Notification to Rob via email + SMS for new leads
- [ ] If outside business hours: "Rob is unavailable right now, but I've captured your details. He'll contact you within 24 hours."

**US-2.3.2: Human Handoff**
> As a **user**, I want to speak to Rob when the chatbot can't help me.

**Acceptance Criteria:**
- [ ] "Talk to a human" option always visible in chat menu
- [ ] During business hours: attempt live chat transfer (if Rob is available) or schedule callback
- [ ] Outside business hours: lead capture form with callback scheduling
- [ ] Handoff preserves conversation context (Rob sees what was discussed)
- [ ] Handoff reason categorized: booking, technical question, complaint, other

---

## 7. Module 3: Instructor Digital Workstation

### Epic 3.1: Competency Sign-Off System

**US-3.1.1: Task List & Progressive Locking**
> As **Rob (instructor)**, I want to see all 23 CBT&A tasks for a student with clear status so I can sign off competencies efficiently.

**Acceptance Criteria:**
- [ ] Student selector (search by name, view active students)
- [ ] Task list displays all 23 tasks with: task number, task name, status (Not Started / In Progress / NYC / Competent), date last assessed, lesson number
- [ ] Progressive locking: Task N cannot be marked Competent until Task N-1 is Competent (configurable by admin — Rob may want to override for opportunistic teaching)
- [ ] Override mechanism: instructor can unlock any task with a reason note (logged in audit trail)
- [ ] Visual progress bar showing X/23 tasks complete
- [ ] Color coding: grey (not started), amber (NYC/in progress), green (Competent)
- [ ] Tap a task → opens sign-off form

**US-3.1.2: Individual Task Sign-Off**
> As **Rob**, I want to mark a task as Competent or NYC with notes and collect signatures.

**Acceptance Criteria:**
- [ ] Task sign-off form contains:
  - Task name and number (read-only)
  - Status toggle: C (Competent) / NYC (Not Yet Competent)
  - Free-text notes field (min 0 chars, max 2000 chars)
  - Lesson number (auto-incremented or manually adjustable)
  - Date (auto-populated, adjustable)
  - Conditions checkboxes: Day/Night, Dry/Wet, Light Traffic/Heavy Traffic, Urban/Rural/Highway, speed zones encountered
- [ ] If C selected → require dual e-signatures (instructor + student)
- [ ] If NYC selected → signatures optional, notes recommended (prompt: "What does the student need to work on?")
- [ ] On submit: auto-capture metadata — GPS coordinates, device ID, timestamp (ISO 8601 UTC), app version
- [ ] SHA-256 hash computed over: task_id + student_id + status + timestamp + GPS + signatures + notes
- [ ] Hash stored alongside record; previous record's hash included in computation (chain)
- [ ] Record becomes immutable after both signatures collected
- [ ] Confirmation screen: "Task 12 — Intersections marked Competent for [Student Name]. Both signatures captured."
- [ ] Optimistic local save (offline support) → sync when connectivity available

**US-3.1.3: E-Signature Capture**
> As **Rob**, I want legally valid digital signatures captured on my phone.

**Acceptance Criteria:**
- [ ] HTML5 Canvas signature pad (minimum 300×150px, scales to device width)
- [ ] Touch and stylus input supported
- [ ] Pressure sensitivity captured where available (future-proofing)
- [ ] Clear/redo button
- [ ] Signature saved as PNG (base64) + SVG vector
- [ ] Each signature record includes: signer_role (instructor/student), signer_name, timestamp, GPS coordinates, device_id (user agent + screen resolution hash), IP address
- [ ] Signatures stored in Cloudflare R2 with immutable object lock
- [ ] Signature cannot be reused across tasks — fresh capture required each time
- [ ] Visual confirmation: "Signature captured ✓" with thumbnail preview

**US-3.1.4: Audit Trail & Hash Chain**
> As **the business**, I want tamper-evident records that satisfy ACT Government auditors.

**Acceptance Criteria:**
- [ ] Every competency record has a SHA-256 hash
- [ ] Hash inputs: task_id + student_id + instructor_id + status + timestamp + gps_lat + gps_lon + device_id + notes_hash + instructor_sig_hash + student_sig_hash + previous_record_hash
- [ ] Hash chain: each record includes the hash of the previous record for that student (genesis record uses null hash)
- [ ] Any modification to a signed record is BLOCKED at application level (immutability middleware enforced in service layer; append-only database constraint on competency records)
- [ ] Correction workflow: if an error is found post-signing, a new "amendment" record is created referencing the original, with reason for change — original record remains untouched
- [ ] Audit export: generate PDF report for any student containing all tasks, signatures, hashes, timestamps, GPS data, organized chronologically
- [ ] Admin can trigger audit simulation: system verifies entire hash chain integrity and reports any breaks
- [ ] All audit actions logged (who exported, when, which student)

### Epic 3.2: Review Assessments

**US-3.2.1: Tasks 1-17 Review Assessment**
> As **Rob**, I want to conduct the 1-17 Review efficiently with pre-populated data.

**Acceptance Criteria:**
- [ ] Triggered only when Tasks 1-17 are ALL marked Competent
- [ ] Auto-populated form showing each task (1-17) with last competency date
- [ ] Each task gets a C/NYC assessment for the review session
- [ ] Single session — all 17 tasks assessed in one form submission
- [ ] Dual e-signatures required
- [ ] Overall result: All C = Review Passed; any NYC = Review Not Passed (specific tasks flagged)
- [ ] If Not Passed: system identifies which tasks need remediation and unlocks them for re-assessment
- [ ] SHA-256 hash chain integration (review record linked to individual task records)
- [ ] Metadata captured: date, time, GPS, device, duration of review session

**US-3.2.2: Tasks 1-22 Review Assessment**
> As **Rob**, I want to conduct the 1-22 Review with speed zone verification.

**Acceptance Criteria:**
- [ ] Triggered only when Tasks 1-22 are ALL marked Competent AND 1-17 Review Passed
- [ ] Auto-populated form showing each task (1-22)
- [ ] Additional requirement: speed zones 40, 50, 60, 70, 80, 90, 100 km/h must all be verified as experienced
- [ ] Speed zone checklist with date each was first experienced (auto-populated from lesson conditions data where available)
- [ ] Dual e-signatures, SHA-256 hash, full metadata
- [ ] Same pass/fail logic as 1-17 Review

### Epic 3.3: Final Drive (Task 23)

**US-3.3.1: Final Drive Gated Workflow**
> As **Rob**, I want the system to verify all prerequisites before I can conduct a Final Drive.

**Acceptance Criteria:**
- [ ] Final Drive form is LOCKED until ALL of these are true:
  - Tasks 1-22: ALL Competent
  - 1-17 Review: Passed
  - 1-22 Review: Passed
  - Student logbook hours meet minimum (system checks but allows override with reason — some students may have hours in other systems)
- [ ] Pre-flight checklist displayed to instructor:
  - "All 22 competencies verified ✓"
  - "1-17 Review passed on [date] ✓"
  - "1-22 Review passed on [date] ✓"
  - "Total professional hours: X"
  - "Total logbook hours: X (if tracked in system)"
- [ ] Instructor confirms checklist and begins Final Drive
- [ ] Drive must be ≥45 minutes on unfamiliar roads (timer starts on form open, system records duration)
- [ ] Route description field (text, required)
- [ ] Road types checklist: residential, arterial, highway, roundabouts, intersections, school zones, pedestrian crossings
- [ ] Result: Pass / Fail
- [ ] If Pass: detailed positive feedback required (text, min 50 chars)
- [ ] If Fail: detailed feedback required with specific remediation areas flagged
- [ ] Dual e-signatures, SHA-256 hash, full metadata
- [ ] On Pass: student status updated to "CBT&A Complete" — triggers congratulations notification to student and linked parent

### Epic 3.4: Lesson Management

**US-3.4.1: Lesson Recording**
> As **Rob**, I want to quickly record lesson details on my phone between students.

**Acceptance Criteria:**
- [ ] Quick-entry form: student (pre-selected if from booking), lesson type (dropdown), duration, tasks covered (multi-select from 23), conditions (checkboxes), notes (free text)
- [ ] Auto-populated from booking data where available (student name, lesson type, scheduled duration)
- [ ] Save draft capability (complete later)
- [ ] Voice-to-text for notes field (browser speech recognition API)
- [ ] Timestamp and GPS auto-captured
- [ ] Links to competency sign-offs completed during this lesson

**US-3.4.2: Lesson Bridge Form Generation**
> As **Rob**, I want to auto-generate a Bridge Form after each lesson to send to the supervising driver.

**Acceptance Criteria:**
- [ ] Generated from lesson record data + competency assessments from that lesson
- [ ] Sections:
  - **Skills Covered Today:** auto-populated from tasks assessed
  - **Specific Positives:** free text (required, min 20 chars — "What did the student do well?")
  - **Small Changes for Big Difference:** free text (required — "What one thing should improve?")
  - **Instructions for Supervising Driver:** free text (recommended practice activities)
  - **Focus Areas for Next Lesson:** auto-suggested based on NYC tasks or next sequential task
- [ ] Preview before sending
- [ ] Delivery: push notification to linked parent via app, email, and available in Student Portal
- [ ] PDF export available
- [ ] Bridge Form linked to lesson record in database

**US-3.4.3: Offline Mode**
> As **Rob**, I want the workstation to work without internet and sync later.

**Acceptance Criteria:**
- [ ] Service Worker caches app shell and critical data (student list, task definitions)
- [ ] All form submissions saved to IndexedDB when offline
- [ ] Visual indicator: "Offline Mode — data will sync when connected"
- [ ] On connectivity restored: automatic background sync
- [ ] Conflict resolution: if same record modified on server during offline period, flag for manual review (unlikely with solo instructor but future-proof)
- [ ] Signatures and photos saved locally until sync
- [ ] Sync status dashboard: X records pending sync

---

## 8. Module 4: Student Portal

### Epic 4.1: Dashboard

**US-4.1.1: Progress Dashboard**
> As a **student**, I want to see my overall progress at a glance when I log in.

**Acceptance Criteria:**
- [ ] Visual competency map: 23 tasks displayed as grid/pathway with color status (grey/amber/green)
- [ ] Progress ring or bar: "14/23 tasks complete (61%)"
- [ ] Logbook hours summary: total hours, night hours, professional hours (with 3:1 credit calculated), remaining hours estimate
- [ ] Next lesson card: date, time, type, suggested preparation ("Review Task 15 — Lane Changing before your lesson")
- [ ] Recent lesson card: last Lesson Bridge Form summary with "View Full Details" link
- [ ] Milestone celebrations: "🎉 You just completed Task 10!" (triggered on login after new competency)
- [ ] Conditions tracker: visual showing which conditions have been covered (night, rain, highway, etc.)

**US-4.1.2: Competency Detail View**
> As a **student**, I want to see details of each competency task and my assessment history.

**Acceptance Criteria:**
- [ ] Tap any task on the map → detail view
- [ ] Shows: task name, description, assessment history (dates, C/NYC, instructor notes), current status
- [ ] Link to Competency Hub content for that task (educational material)
- [ ] If NYC: shows instructor's notes on what to improve
- [ ] If not yet assessed: shows what to expect and how to prepare
- [ ] Signature thumbnails visible (proof of sign-off)

### Epic 4.2: Digital Logbook

**US-4.2.1: Logbook Entry View**
> As a **student**, I want to see all my logged driving hours in one place.

**Acceptance Criteria:**
- [ ] Chronological list of all logged hours (professional lessons + supervised practice if entered)
- [ ] Each entry shows: date, duration, supervisor name, conditions, hours credited
- [ ] Professional hours distinguished from supervised practice hours
- [ ] 3:1 credit automatically calculated for first 10 professional hours
- [ ] Running totals: total hours, night hours, conditions breakdown
- [ ] Filter by: date range, type (professional/supervised), conditions
- [ ] Export to PDF (formatted for government submission if required)
- [ ] Export to CSV

**US-4.2.2: Self-Log Supervised Hours**
> As a **student**, I want to log my supervised practice hours so all my driving is tracked in one system.

**Acceptance Criteria:**
- [ ] Manual entry form: date, start time, end time, supervisor (select from linked supervisors), conditions, route description (optional), notes (optional)
- [ ] Supervisor verification: notification sent to linked parent to confirm hours (optional but encouraged)
- [ ] Validation: entry cannot exceed 4 hours in a single session, cannot overlap with existing entries
- [ ] Night hours auto-detected: entries between sunset and sunrise for Canberra location
- [ ] Entries clearly labeled as "Self-Reported — Pending Verification" until confirmed by supervisor

### Epic 4.3: Booking & Payments

**US-4.3.1: View & Manage Bookings**
> As a **student**, I want to see my upcoming and past lessons and manage them.

**Acceptance Criteria:**
- [ ] Upcoming lessons: date, time, type, duration, status (confirmed/pending)
- [ ] Past lessons: linked to lesson records and Bridge Forms
- [ ] Reschedule: respects cancellation policy (e.g., 24-hour notice required, configurable)
- [ ] Cancel: with policy enforcement and refund handling (if applicable)
- [ ] Book new lesson: integrated booking flow within the student portal
- [ ] Co-lesson coordination: "Invite your supervisor to join this lesson" → sends notification to linked parent

**US-4.3.2: Payment Management**
> As a **student**, I want to view my payments, invoices, and package balance.

**Acceptance Criteria:**
- [ ] Payment history: date, amount, description, status, receipt link
- [ ] Package balance: if prepaid, show remaining hours and expiry
- [ ] Invoices: downloadable PDF for each payment
- [ ] Payment methods: manage saved cards via Stripe Customer Portal
- [ ] Outstanding balance alerts
- [ ] Afterpay status (if applicable)

### Epic 4.4: Supervisor Linking

**US-4.4.1: Link Parent/Supervisor Account**
> As a **student**, I want to connect my parent's account so they can see my progress.

**Acceptance Criteria:**
- [ ] Generate invite link or code from Student Portal
- [ ] Parent receives link → creates account or logs in → confirms link
- [ ] Student approves the link request (consent-based)
- [ ] Linked parent can see: competency progress, logbook hours, lesson Bridge Forms, upcoming bookings
- [ ] Linked parent CANNOT see: chat history, private notes, payment details (unless student grants access)
- [ ] Multiple supervisors can be linked (e.g., both parents)
- [ ] Student can revoke link at any time

---

## 9. Module 5: Parent/Supervisor Resource Center

### Epic 5.1: Video Library

**US-5.1.1: Video Content Delivery**
> As a **parent**, I want to watch instructional videos on how to be a better supervising driver.

**Acceptance Criteria:**
- [ ] Video library page with categorized content:
  - **Getting Started:** "How to Be an Effective Supervising Driver" (10-15 min)
  - **Techniques:** "Understanding IPSGA — The System of Vehicle Control" (8-10 min)
  - **Practice Methods:** "How to Run a Commentary Driving Session" (8-10 min)
  - **Common Mistakes:** "What Parents Get Wrong (and How to Fix It)" (8-10 min)
  - **Stage Guides:** "What to Practice at Each Logbook Stage" (5 videos, 5-8 min each)
- [ ] Video player with: play/pause, speed control (0.75x-2x), fullscreen, captions/subtitles
- [ ] Progress tracking: "You've watched 3/8 videos"
- [ ] Videos hosted on Cloudflare Stream or Mux (not YouTube — keep users on-platform)
- [ ] Adaptive bitrate streaming for mobile/desktop
- [ ] Authenticated access only (parent must have account)
- [ ] Thumbnail previews with duration and description

**US-5.1.2: Video Production Specification**
> As **the business**, I want professional video content that reflects NexDrive's brand quality.

**Acceptance Criteria:**
- [ ] Videos feature Rob as presenter (on camera + voiceover + in-car footage)
- [ ] Production quality: professional audio, stabilized footage, simple graphics/overlays
- [ ] Each video has: intro (what you'll learn), main content, summary (key takeaways), CTA (book a co-lesson)
- [ ] Captions: auto-generated + human-reviewed for accuracy
- [ ] Thumbnail: branded with NexDrive colors, Rob's face, topic title
- [ ] Phase 5 deliverable — placeholder content acceptable for Phase 3-4 launch

### Epic 5.2: Coaching Technique Modules

**US-5.2.1: Client-Centered Coaching Module**
> As a **parent**, I want to learn questioning techniques that help my learner think instead of just giving commands.

**Acceptance Criteria:**
- [ ] Interactive module (scrollable page with embedded examples):
  - Concept introduction: coaching vs. commanding
  - Side-by-side comparisons: ❌ "Brake now!" → ✅ "What's a safe following distance for this speed?"
  - ❌ "You're going too fast" → ✅ "What speed limit is this zone?"
  - ❌ "Watch out for that car!" → ✅ "What do you notice about the car to our left?"
  - Minimum 10 example pairs covering common scenarios
- [ ] Why it works: brief explanation of cognitive engagement vs. reactive compliance
- [ ] Practice scenarios: "Your learner is approaching a roundabout too fast. What coaching question could you ask?"
- [ ] Printable cheat sheet (PDF download) with top 20 coaching phrases
- [ ] Link to related Competency Hub tasks

**US-5.2.2: Commentary Driving Module**
> As a **parent**, I want to learn how to run a Commentary Driving session.

**Acceptance Criteria:**
- [ ] Explainer: what Commentary Driving is (learner verbalizes everything they observe and plan)
- [ ] Video demonstration (Rob models it with a student)
- [ ] Step-by-step guide for parents: how to start, what to listen for, how to give feedback, when to use it
- [ ] Sample commentary script for a typical suburban drive
- [ ] Common mistakes: "Don't interrupt mid-commentary", "Let them self-correct"
- [ ] Recommended frequency: "Try 5 minutes of commentary driving at the start of every practice session"

**US-5.2.3: Golden Rules Module**
> As a **parent**, I want simple principles to follow that make practice sessions productive and positive.

**Acceptance Criteria:**
- [ ] The Five Golden Rules:
  1. Stay Calm — your tension transmits instantly
  2. Never Yell — it creates anxiety, not learning
  3. Be Specific — "check your mirrors" not "be careful"
  4. Celebrate Wins — acknowledge progress, even small things
  5. Focus on Small Changes — one improvement per session, not ten
- [ ] Each rule has: explanation, real-world example, what happens when broken, Rob's perspective
- [ ] Printable poster/card (PDF) for the fridge or car dashboard
- [ ] Self-assessment: "Rate yourself on each Golden Rule" (interactive slider, non-judgmental)

### Epic 5.3: Downloadable Resources

**US-5.3.1: Resource Library**
> As a **parent**, I want downloadable guides and checklists I can reference offline.

**Acceptance Criteria:**
- [ ] Resources available:
  - Parent-Teen Driving Contract (PDF, fillable) — rules for car use, phone use, curfews, consequences
  - First Drive Checklist (PDF) — car park session guide for absolute beginners
  - Supervising Driver Quick Guide (PDF) — condensed version of Golden Rules + coaching techniques
  - Lesson Bridge Form template (PDF) — blank version for parent's own notes
  - CBT&A Task Overview (PDF) — all 23 tasks summarized in parent-friendly language
  - Practice Session Planner (PDF) — weekly schedule template
- [ ] Each resource has: preview image, description, file size, download button
- [ ] Downloads tracked for analytics (which resources are most popular)
- [ ] Resources accessible from parent dashboard + Resource Center page

---

## 10. Module 6: Competency Hub

### Epic 6.1: Task Content Structure

**US-6.1.1: Individual Task Pages**
> As a **student or parent**, I want deep educational content for each CBT&A task so I can prepare effectively.

**Acceptance Criteria:**
- [ ] 23 task pages, each containing:
  - **Overview:** What this competency covers, why it matters for safe driving, GDE Matrix level placement
  - **Assessment Criteria:** Exact ACT Government performance standard (quoted/referenced)
  - **Training Tips:** Minimum 3 different explanations for different learning styles (verbal, visual, analogical)
  - **Opportunistic Teaching Strategies:** Real-world scenarios and triggers ("When you approach a busy roundabout, that's a natural time to practice IPSGA")
  - **Common Mistakes:** Top 3-5 errors learners make, with specific corrections ("Instead of braking and changing gears simultaneously, complete your braking first, then select gear")
  - **For Supervisors:** Parent-friendly coaching questions for this task, what to reinforce during home practice
  - **Visual Aids:** Minimum 1 diagram or illustration per task (intersection layouts, mirror positions, gap selection diagrams)
- [ ] Content sourced from RAG knowledge base and verified by Rob
- [ ] Internal linking: each task links to related tasks, relevant blog posts, parent resources
- [ ] Public access (SEO value) with authenticated users seeing personalized progress overlay
- [ ] Task pages optimized for SEO (unique meta title/description per task)

**US-6.1.2: IPSGA Deep-Dive (Task 21 Featured)**
> As a **student**, I want an interactive exploration of the IPSGA System of Vehicle Control.

**Acceptance Criteria:**
- [ ] Interactive diagram showing each IPSGA phase:
  - **I**nformation (what you see, hear, feel)
  - **P**osition (road positioning for the maneuver)
  - **S**peed (appropriate speed selection and braking)
  - **G**ear (correct gear for the speed and situation)
  - **A**cceleration (smooth application to exit)
- [ ] Animated sequence through a roundabout showing each phase highlighted
- [ ] Video demonstration from driver's perspective (Rob demonstrates)
- [ ] Common error spotlight: "Brake-gear overlap" — explained with simple physics (braking transfers weight forward; changing gears while braking = competing inputs)
- [ ] Practice scenarios: roundabouts, T-intersections, curves, school zones
- [ ] Commentary Driving script template specific to IPSGA
- [ ] Links to UK Roadcraft source material for further reading

### Epic 6.2: GDE Matrix Integration

**US-6.2.1: GDE Matrix Explorer**
> As a **student**, I want to understand where each competency fits in the bigger picture of driver education.

**Acceptance Criteria:**
- [ ] Visual GDE Matrix display (4 levels × learning domains):
  - Level 4: Goals for Life → AI Risk Awareness prompts, self-calibration tools
  - Level 3: Goals of Driving → Competency Hub conditions modules, parent coaching
  - Level 2: Traffic Mastery → Tasks 12-22, IPSGA, Commentary Driving
  - Level 1: Vehicle Control → Tasks 1-11, vehicle dynamics
- [ ] Interactive: click a level → see which tasks belong to it
- [ ] Student's progress overlaid on the matrix (completed tasks highlighted)
- [ ] Explanation of why all 4 levels matter (not just Level 1-2)
- [ ] Content: age-appropriate for 16-19 year olds (accessible language, not academic)

---

## 11. Module 7: Voice Assistant (Phase 5)

### Epic 7.1: In-Car Voice Interface

**US-7.1.1: Voice Query & Response**
> As a **student practicing at home**, I want to ask driving questions by voice while my parent drives/supervises.

**Acceptance Criteria:**
- [ ] Activated via wake word or button press in PWA/app
- [ ] Speech-to-Text: OpenAI Whisper or Deepgram (latency <1s)
- [ ] Same RAG pipeline as chatbot (shared knowledge base)
- [ ] Text-to-Speech: ElevenLabs or Play.ht (natural Australian English voice, configurable)
- [ ] Response length: maximum 30 seconds of speech (concise answers)
- [ ] GPS-aware safety mode: when vehicle speed >5km/h, voice-only interaction (no visual display changes)
- [ ] When stationary: visual + voice response

**US-7.1.2: Parent Coaching Mode**
> As a **parent**, I want the voice assistant to give me coaching prompts during practice sessions.

**Acceptance Criteria:**
- [ ] Parent activates "Coaching Mode" via voice or button
- [ ] System knows student's current task progression
- [ ] Provides contextual coaching prompts: "Your learner is working on lane changing. A good question to ask before they change lanes: 'What do you need to check before moving over?'"
- [ ] Prompts delivered at appropriate intervals (not constant — configurable, default every 3-5 minutes)
- [ ] Can be paused/resumed by voice command

### Epic 7.2: Call Answer System

**US-7.2.1: Inbound Call Handling**
> As **the business**, I want an AI system to answer calls when Rob is unavailable.

**Acceptance Criteria:**
- [ ] Inbound call → IVR greeting: "Hi, you've reached NexDrive Academy. I'm NexDrive's AI assistant. I can help with booking inquiries, answer questions, or connect you with Rob."
- [ ] Booking inquiries → capture details (name, phone, preferred times) → schedule callback or redirect to online booking
- [ ] General questions → RAG-powered answers with source citations
- [ ] Urgent/emergency → immediate transfer to Rob's mobile
- [ ] Voicemail: if caller prefers, record message → transcribe → route to Rob with priority flag
- [ ] Call summary emailed to Rob after each interaction

---

## 12. Module 8: CRM & Booking System

### Epic 8.1: Custom Booking Engine

**US-8.1.1: Availability & Scheduling**
> As **the business**, I want a booking engine that manages instructor availability, slot selection, and booking lifecycle natively within the platform.

**Acceptance Criteria:**
- [ ] Instructor availability managed via recurring schedule rules (e.g., Mon-Fri 8am-5pm, Sat 9am-1pm) with overrides for holidays and blocked time
- [ ] Available slots computed dynamically: schedule rules minus existing bookings minus blocked times
- [ ] Public availability API returns open slots for next N weeks (configurable, default 4 weeks)
- [ ] Slot reservation: 10-minute hold when prospect starts booking, released if not confirmed
- [ ] Booking states: pending → confirmed → in_progress → completed | cancelled | no_show | rescheduled
- [ ] Cancellation policy enforcement: configurable notice period (default 24 hours), late cancellation fee option
- [ ] Booking confirmation triggers: confirmation email/SMS, calendar event, student notification
- [ ] If student doesn't exist in NexDrive → create pending student record (name, email, phone) → send account creation invitation via Clerk
- [ ] Buffer time between bookings (configurable, default 15 minutes for travel)

**US-8.1.2: Service Configuration**
> As **Rob**, I want to manage my service types and pricing.

**Acceptance Criteria:**
- [ ] Admin panel: CRUD for service types
- [ ] Fields per service: name, description, duration (minutes), price (AUD), category, active/inactive
- [ ] Service types (initial):
  - Learner Lesson — 1 Hour ($XX)
  - Learner Lesson — 2 Hours ($XX)
  - Co-Lesson with Supervisor ($XX)
  - Pre-Test Preparation ($XX)
  - Advanced/Refresher Course ($XX)
  - Defensive Driving ($XX)
  - Confidence Coaching (Nervous Students) ($XX)
  - Corporate Training (quote)
- [ ] Package configuration: create hour-block packages with discount pricing
- [ ] Pricing changes reflected on website within 5 minutes (ISR revalidation)

**US-8.1.3: Booking Notifications & Lifecycle**
> As **the business**, I want automated booking lifecycle management.

**Acceptance Criteria:**
- [ ] Booking created → confirmation email + SMS to student, notification to instructor
- [ ] 24 hours before → reminder SMS to student
- [ ] 1 hour before → reminder SMS (optional, configurable)
- [ ] Booking cancelled → cancellation confirmation, slot released, refund triggered if applicable
- [ ] No-show handling: instructor marks no-show from workstation → student notified, no-show fee applied if configured
- [ ] Rescheduling: respects cancellation policy, releases old slot, books new slot atomically

### Epic 8.2: CRM

**US-8.2.1: Client Records**
> As **Rob**, I want a complete view of each client's history and status.

**Acceptance Criteria:**
- [ ] Client record contains: name, email, phone, date of birth, learner permit number (optional), address, emergency contact, linked parent/supervisor, source (how they found NexDrive), notes
- [ ] Activity timeline: all bookings, payments, competency sign-offs, chat interactions, emails sent
- [ ] Tags: active, inactive, prospect, graduated, referred-by, referral-given
- [ ] Search and filter by: name, status, tag, date range, tasks completed
- [ ] Export: CSV/Excel with configurable columns (up to 145+ fields)
- [ ] Student progression summary: tasks completed, hours logged, estimated completion date

**US-8.2.2: Automated Communications**
> As **the business**, I want automated messages at key touchpoints.

**Acceptance Criteria:**
- [ ] Triggered communications:
  - Booking confirmation (email + SMS)
  - 24-hour lesson reminder (SMS)
  - 1-hour lesson reminder (SMS, optional)
  - Post-lesson follow-up with Bridge Form link (email, 2 hours after lesson)
  - Competency milestone (email: "Congratulations! You've completed Task X!")
  - Inactive student nudge (email: 14 days since last lesson)
  - Review invitation (email: after 5 lessons, request Google review)
  - Birthday message (email, optional)
  - Test preparation checklist (email: when 20/23 tasks complete)
  - CBT&A completion congratulations (email + SMS)
- [ ] Each template: customizable, unsubscribe-compliant, NexDrive branded
- [ ] SMS via Twilio, Email via Resend
- [ ] Communication log visible in client record

**US-8.2.3: Lead Scoring & Referral Tracking**
> As **the business**, I want to prioritize follow-up and reward referrals.

**Acceptance Criteria:**
- [ ] Lead scoring: prospects scored based on: visited pricing page (+10), opened chatbot (+5), asked about booking (+20), submitted contact form (+30), started booking but didn't complete (+25)
- [ ] Lead dashboard: sorted by score, with last activity date and source
- [ ] Referral tracking: unique referral codes per graduated student, track: who referred, who converted, reward eligibility
- [ ] Referral reward: configurable (e.g., $20 credit for referrer when referee completes first lesson)

---

## 13. Module 9: Payment Processing

### Epic 9.1: Payment Integration

**US-9.1.1: Stripe Payment Flow**
> As a **student**, I want to pay for lessons securely with my card.

**Acceptance Criteria:**
- [ ] Stripe Checkout or Elements integration (PCI-compliant — no card data touches NexDrive servers)
- [ ] Supported: Visa, Mastercard, Amex, Apple Pay, Google Pay
- [ ] Single lesson payment and package purchase flows
- [ ] Deposit collection for new students (configurable amount)
- [ ] Webhook handling: payment_intent.succeeded, payment_intent.failed, charge.refunded
- [ ] Receipt emailed automatically via Stripe
- [ ] Payment linked to booking record

**US-9.1.2: Package Management**
> As a **student**, I want to buy lesson packages and track my remaining balance.

**Acceptance Criteria:**
- [ ] Package types: configurable (e.g., 10-Hour Block at discounted rate)
- [ ] Package purchase creates: total hours, used hours (0), expiry date (configurable, e.g., 12 months), payment reference
- [ ] Each lesson booking deducts from package balance
- [ ] Student portal shows: "Package: 7 of 10 hours remaining (expires 20 Feb 2027)"
- [ ] Low balance alert: notification when ≤2 hours remaining
- [ ] Package renewal: prompt to repurchase when expired or depleted
- [ ] 3:1 credit: first 10 professional hours count as 30 logbook hours — displayed in student portal

**US-9.1.3: Afterpay / Payment Plans**
> As a **student**, I want flexible payment options.

**Acceptance Criteria:**
- [ ] Afterpay integration for lesson packages ≥$200 (Afterpay's minimum)
- [ ] Payment plan option: split package cost into 2-4 installments via Stripe Payment Links or manual invoicing
- [ ] Clear display of payment plan terms before purchase
- [ ] Failed payment handling: 3-day grace period, then booking hold, notification to student and admin

**US-9.1.4: Refund Management**
> As **Rob**, I want to process refunds according to policy.

**Acceptance Criteria:**
- [ ] Refund initiation from admin panel: select payment → refund (full or partial)
- [ ] Reason required (cancellation, complaint, policy, other)
- [ ] Refund processed via Stripe API
- [ ] Refund record linked to original payment
- [ ] Student notified of refund via email
- [ ] Package balance adjusted if refunding package hours

---

## 14. Module 10: Admin Panel

### Epic 10.1: Business Dashboard

**US-10.1.1: KPI Overview**
> As **Rob**, I want to see my business performance at a glance.

**Acceptance Criteria:**
- [ ] Dashboard cards:
  - Revenue: this week, this month, this quarter, YTD (with trend arrows)
  - Bookings: upcoming count, this week's schedule, cancellation rate
  - Students: active count, new this month, graduated this month
  - Conversion: prospect → booked (funnel), chatbot → lead, lead → student
  - Competency: average tasks completed per active student, average time to completion
  - NPS: latest score (when surveys implemented)
- [ ] Date range selector (custom, presets: today, this week, this month, this quarter, YTD)
- [ ] Charts: revenue over time (line), bookings by type (bar), student progression distribution (histogram)
- [ ] Exportable (PDF, CSV)

**US-10.1.2: Booking Calendar**
> As **Rob**, I want a visual calendar of all my bookings.

**Acceptance Criteria:**
- [ ] Calendar views: day, week, month
- [ ] Each booking shows: student name, service type, time, duration, payment status
- [ ] Color coding by service type
- [ ] Click booking → view/edit details
- [ ] Real-time sync with custom booking engine (same database — no external sync needed)
- [ ] Availability management: block out times (holidays, personal), set working hours
- [ ] Drag to reschedule (updates booking record, notifies student)

### Epic 10.2: System Administration

**US-10.2.1: RAG Corpus Management**
> As **Rob**, I want to manage what the AI knows.

**Acceptance Criteria:**
- [ ] Upload interface: drag-and-drop documents
- [ ] Corpus status: list of all indexed documents with chunk count, last indexed date, category
- [ ] Re-index individual documents
- [ ] Delete document from corpus (removes all chunks from vector store)
- [ ] Test query interface: enter a question, see retrieved chunks and generated response (for verification)
- [ ] Analytics: most asked questions, questions with low confidence scores (indicating corpus gaps), total queries per day

**US-10.2.2: Communication Templates**
> As **Rob**, I want to customize automated messages.

**Acceptance Criteria:**
- [ ] Template editor for each automated communication
- [ ] Variables: {{student_name}}, {{lesson_date}}, {{task_name}}, {{instructor_name}}, {{booking_link}}, etc.
- [ ] Preview before saving
- [ ] Toggle individual communications on/off
- [ ] Test send to Rob's email/phone

**US-10.2.3: Analytics Integration**
> As **the business**, I want comprehensive analytics.

**Acceptance Criteria:**
- [ ] PostHog integration: event tracking for all key actions (page views, booking started, booking completed, chatbot opened, chatbot question asked, resource downloaded, video watched, task signed off)
- [ ] GA4 integration: marketing attribution, traffic sources, conversion tracking
- [ ] Custom events: funnel from homepage → services → booking → payment
- [ ] Heatmaps and session recordings (PostHog, anonymized)
- [ ] Weekly automated report email to Rob

---

## 15. API Contract Summary

### 15.1 Internal API Routes

#### Authentication (Clerk-Managed)

Authentication is handled entirely by Clerk. No custom auth endpoints needed.

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/v1/webhooks/clerk` | Clerk webhook receiver (user.created, user.updated, user.deleted → profile sync) |
| GET | `/api/v1/auth/me` | Get current user profile (from Clerk session + DB lookup) |

All authenticated routes use Clerk middleware to verify session tokens and extract `userId`, `role`, and entity IDs from session claims.

#### Students
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/v1/students` | List students (admin/instructor) |
| GET | `/api/v1/students/:id` | Get student detail |
| GET | `/api/v1/students/:id/progress` | Get competency progress summary |
| GET | `/api/v1/students/:id/logbook` | Get logbook entries |
| POST | `/api/v1/students/:id/logbook` | Create logbook entry (self-log) |
| GET | `/api/v1/students/:id/bookings` | Get student's bookings |
| POST | `/api/v1/students/:id/link-supervisor` | Generate supervisor link |

#### Competency
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/v1/competency/:studentId` | Get all task records for student |
| POST | `/api/v1/competency/:studentId/tasks/:taskId` | Sign off a task (C/NYC) |
| POST | `/api/v1/competency/:studentId/review` | Submit review assessment (1-17 or 1-22) |
| POST | `/api/v1/competency/:studentId/final-drive` | Submit Final Drive result |
| GET | `/api/v1/competency/:studentId/audit` | Generate audit export (PDF) |
| POST | `/api/v1/competency/:studentId/verify-chain` | Verify hash chain integrity |

#### Lessons
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/v1/lessons` | List lessons (filtered by student, date) |
| POST | `/api/v1/lessons` | Create lesson record |
| PUT | `/api/v1/lessons/:id` | Update lesson record |
| POST | `/api/v1/lessons/:id/bridge-form` | Generate bridge form |
| GET | `/api/v1/lessons/:id/bridge-form` | Get bridge form |

#### Chat / RAG
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/v1/chat/message` | Send message, get AI response (streaming) |
| GET | `/api/v1/chat/conversations` | List user's conversations |
| GET | `/api/v1/chat/conversations/:id` | Get conversation history |
| POST | `/api/v1/chat/lead` | Capture prospect lead |
| POST | `/api/v1/chat/handoff` | Request human handoff |

#### Bookings (Custom Engine)
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/v1/booking/availability` | Get available slots (public) |
| GET | `/api/v1/booking/services` | List bookable services (public) |
| POST | `/api/v1/booking/reserve` | Reserve a slot (10-min hold) |
| POST | `/api/v1/booking/confirm` | Confirm booking (after payment intent) |
| GET | `/api/v1/bookings` | List bookings (role-scoped) |
| GET | `/api/v1/bookings/:id` | Get booking detail |
| PATCH | `/api/v1/bookings/:id` | Update booking (reschedule) |
| POST | `/api/v1/bookings/:id/cancel` | Cancel booking |
| POST | `/api/v1/bookings/:id/no-show` | Mark as no-show (instructor/admin) |

#### Payments (Stripe)
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/v1/payments/create-checkout` | Create Stripe Checkout session |
| POST | `/api/v1/webhooks/stripe` | Stripe webhook receiver |
| GET | `/api/v1/payments/:studentId` | Get payment history |
| POST | `/api/v1/payments/refund` | Process refund (admin) |
| GET | `/api/v1/packages/:studentId` | Get package balance |

#### Admin
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/v1/admin/dashboard` | Get KPI data |
| GET | `/api/v1/admin/reports/:type` | Generate report (revenue, students, competency) |
| POST | `/api/v1/admin/rag/upload` | Upload document to corpus |
| DELETE | `/api/v1/admin/rag/documents/:id` | Remove document from corpus |
| GET | `/api/v1/admin/rag/test` | Test RAG query |
| PUT | `/api/v1/admin/services` | Update service configuration |
| PUT | `/api/v1/admin/templates/:id` | Update communication template |

### 15.2 External API Integrations

| Service | API | Auth Method | Endpoints Used |
|---------|-----|------------|----------------|
| Clerk | REST + Webhooks | Secret Key | User management, session verification, webhook events |
| Stripe | REST API v2 | Secret Key | Checkout, PaymentIntents, Customers, Webhooks, Refunds |
| PayPal | REST API | Client ID/Secret | Orders, Capture, Webhooks |
| Claude API | REST | API Key | Messages (chat completions with streaming) |
| OpenAI | REST | API Key | Embeddings (text-embedding-3-large) |
| Twilio | REST | Account SID/Token | SMS send |
| Resend | REST | API Key | Email send |
| PostHog | JS SDK + REST | Project Key | Event capture, feature flags |
| ElevenLabs | REST + WebSocket | API Key | TTS generation, streaming (Phase 5) |
| Whisper | REST (OpenAI) | API Key | Audio transcription (Phase 5) |

---

## 16. Prioritized Feature Matrix

### P0 — Must Have (MVP, Phases 1-2)
Features required for launch. Without these, the platform cannot operate.

| Feature | Module | Phase |
|---------|--------|-------|
| Public website with all core pages | 1 | 1 |
| Custom booking flow (public + authenticated) | 1, 8 | 1 |
| User authentication via Clerk (all roles) | Global | 1 |
| Competency sign-off (23 tasks) | 3 | 2 |
| E-signatures with hash chain | 3 | 2 |
| Review Assessments (1-17, 1-22) | 3 | 2 |
| Final Drive gated workflow | 3 | 2 |
| Audit export (PDF) | 3 | 2 |
| Lesson recording | 3 | 2 |
| Bridge Form generation | 3 | 2 |
| Offline mode (instructor) | 3 | 2 |
| Stripe payment processing | 9 | 2 |

### P1 — Should Have (Phases 3-4)
Features that create the differentiated experience.

| Feature | Module | Phase |
|---------|--------|-------|
| Student dashboard | 4 | 3 |
| Digital logbook | 4 | 3 |
| Booking management (student) | 4 | 3 |
| Payment history & packages | 4, 9 | 3 |
| Supervisor linking | 4 | 3 |
| AI chatbot (prospect mode) | 2 | 4 |
| AI chatbot (student mode) | 2 | 4 |
| RAG pipeline & corpus ingestion | 2 | 4 |
| Competency Hub (23 task pages) | 6 | 4 |
| Admin dashboard | 10 | 3 |
| CRM with client records | 8 | 3 |
| Automated communications | 8 | 3 |

### P2 — Nice to Have (Phases 5-6)
Features that complete the ecosystem.

| Feature | Module | Phase |
|---------|--------|-------|
| AI chatbot (parent mode) | 2 | 5 |
| Voice assistant | 7 | 5 |
| Call answer system | 7 | 5 |
| Video library | 5 | 5 |
| Coaching technique modules | 5 | 5 |
| Downloadable resources | 5 | 5 |
| IPSGA interactive deep-dive | 6 | 5 |
| GDE Matrix explorer | 6 | 5 |
| Blog/content engine | 1 | 6 |
| Free SEO tools | 1 | 6 |
| Lead scoring & referrals | 8 | 6 |
| Afterpay integration | 9 | 6 |
| VR/360° modules | 6 | 6 |
| PostHog heatmaps/recordings | 10 | 6 |

---

## 17. Acceptance Testing Strategy

### 17.1 Smoke Tests (Every Deployment)
1. Homepage loads in <3s
2. Custom booking flow completes end-to-end (select service → pick slot → pay → confirmation)
3. User can authenticate via Clerk, access role-appropriate dashboard
4. Instructor can sign off a task with dual signatures
5. Hash chain verifies correctly after sign-off
6. Student portal shows updated progress after sign-off
7. Chatbot returns a cited response to a CBT&A question
8. Payment processes successfully in Stripe test mode

### 17.2 Audit Simulation Test (Pre-Launch, Monthly)
1. Select random student → export full audit PDF
2. Verify all task records present with timestamps, GPS, signatures
3. Run hash chain verification → expect 0 breaks
4. Verify immutability: attempt to modify a signed record → expect block
5. Verify amendment workflow: create amendment record → original unchanged
6. Verify PDF export matches database records exactly

### 17.3 User Acceptance Testing (Beta)
- 3-5 current students + their parents for 2-week beta
- Rob uses instructor workstation for all lessons during beta
- Feedback collected via structured survey + open comments
- Critical bugs: fix within 24 hours
- UX issues: prioritize for Phase 6 polish

---

## 18. Release Strategy

### Phase 1-2 Launch (MVP)
- **Audience:** Rob + existing students only
- **Features:** Website, instructor workstation, booking engine, basic payments
- **Marketing:** None — internal validation
- **Success gate:** Rob completes 20 lessons using digital workstation without reverting to paper

### Phase 3-4 Launch (Soft Launch)
- **Audience:** All new students auto-enrolled, existing students migrated
- **Features:** Student portal, chatbot, Competency Hub
- **Marketing:** Updated Google Business listing, social media announcement
- **Success gate:** >80% student portal adoption, chatbot resolves >70% queries

### Phase 5-6 Launch (Public Launch)
- **Audience:** Full public marketing campaign
- **Features:** Complete platform including voice, parent center, VR
- **Marketing:** SEO campaign, Google Ads, Facebook/Instagram ads, referral program
- **Success gate:** >15% booking conversion rate, NPS >70

---

## 19. BMAD Phase Status

| Phase | Document | Status |
|-------|----------|--------|
| Phase 1 | Product Brief | ✅ Complete (v2.0) |
| Phase 2 | Product Requirements Document (PRD) | ✅ Complete (v2.0) |
| Phase 3 | System Architecture | ✅ Complete (v1.1) |
| Phase 4 | Sprint Planning | ⏳ Next |
| Phase 5 | Developer Stories | ⬜ Pending |
| Phase 6 | Implementation | ⬜ Pending |

**Next Step:** Phase 4 — Sprint Planning with component specs and developer stories.

---

*Document generated by BMAD Product Manager Agent | NexDrive Academy Project*
