# NexDrive Academy — Project Briefing for New Chat

## How to Use This
Paste this briefing into a new Claude chat, then upload the relevant document files as attachments. This gives Claude full context without re-explaining everything.

---

## PROJECT OVERVIEW

**NexDrive Academy** is a driving school platform for Rob Harrison's driving instruction business in Canberra, ACT, Australia. Built using **BMAD methodology** (Business Method Architecture Design).

**What it does:** Website + booking engine + AI voice/SMS/chat agent + digital lesson recording + CBT&A compliance tracking + student/parent portals + CRM + admin panel.

**Who it serves:**
- Rob (owner/instructor) — manages lessons, records competencies, runs the business
- Students — book lessons, track progress, digital lesson records
- Parents/supervisors — view linked student progress, receive bridge forms
- Prospects — find the business, ask questions via voice/SMS/chat, book online

**Scale:** 1-2 instructors, 20-30 active students. Solo operation growing to small team.

**Regulatory context:** ACT Government CBT&A (Competency Based Training & Assessment) system. 23 competency tasks. Digital Form 10.044 (lesson records). Lessons and competencies are append-only for audit compliance.

---

## BMAD PHASE STATUS

| Phase | Status | Document |
|-------|--------|----------|
| Phase 1: Product Brief | ✅ Complete | `product-brief-v2.md` |
| Phase 2: PRD | ✅ Complete | `prd-part1.md` + `prd-part2.md` |
| Phase 3: System Architecture | ✅ Complete (v1.1) | `system-architecture-v1.1.md` |
| Phase 4: Sprint Planning | ❌ NEXT | — |
| Phase 5: Component Specs | ❌ Not started | — |

---

## TECH STACK (decided)

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js 20 LTS, TypeScript 5.x | |
| Framework | Next.js 14.x (App Router) | TailwindCSS 3.x |
| Database | **Neon** (Serverless PostgreSQL 16+) | Sydney region, scale-to-zero, branching |
| Auth | **Clerk** | MFA, passkeys, pre-built UI, webhook sync |
| File Storage | **Cloudflare R2** | Sydney, S3-compatible, zero egress |
| ORM | Drizzle ORM | Neon serverless driver |
| Cache | Upstash Redis | Sydney, rate limiting, slot locks |
| AI/LLM | Claude API (claude-sonnet-4-5) | RAG engine |
| Embeddings | OpenAI text-embedding-3-large | pgvector in Neon |
| Voice Agent | Vapi.ai (eval target) | Adapter pattern for swap |
| SMS | Twilio | AU number |
| Email | Resend | Transactional |
| Payments | TBD (Stripe/Tyro/Square) | AU market |
| Hosting | Vercel | Frontend + API routes + cron |
| Analytics | PostHog + GA4 | |
| Errors | Sentry | |

---

## KEY ARCHITECTURE DECISIONS

1. **Neon + Clerk + R2 over Supabase** — best-of-breed, no single vendor lock-in
2. **Next.js monorepo** — right-sized for 1-2 instructors, not microservices
3. **Drizzle ORM** — SQL transparency, Neon serverless driver support
4. **Application-level RBAC via Clerk middleware** — not database-level RLS
5. **Append-only compliance tables** — lessons, competencies, signatures, audit log with hash chains
6. **Custom booking engine** — deep competency integration, data sovereignty
7. **Voice agent via specialist provider** — adapter pattern allows swap

---

## DATABASE (26 tables in Neon)

**User Management:** profiles, instructors, students, parents, parent_student_links
**CRM:** contacts (prospect→lead→qualified→enrolled→active→completed)
**Services & Availability:** services, availability_rules, availability_overrides
**Booking & Lessons:** bookings, lessons (append-only, digital Form 10.044)
**CBT&A Compliance:** competency_tasks (23 tasks), student_competencies (append-only)
**Signatures & Audit:** signatures (immutable), audit_log (append-only, hash chain)
**Payments:** payments, packages, student_packages, vouchers
**Communication:** conversations, messages, call_logs
**Instructor Tools:** private_notes (NEVER visible to students/parents), lesson_bridge_forms, self_assessments
**System:** notifications, rag_documents, rag_chunks (pgvector), waitlist

All user tables use `clerk_user_id` (TEXT) linking to Clerk — not database foreign keys to an auth table.

---

## API (80+ endpoints)

Auth, Booking Engine, Student Management, Lesson Recording, CBT&A Compliance, CRM, Payments, AI Communication (chat/SMS/voice webhooks), RAG Knowledge Engine, Admin Panel, Public Content, Notifications. Full contracts in the architecture doc.

---

## PHASE BUILD ORDER

- **Phase 0** (Weeks 1-2): Foundation — DB schema, Neon/Clerk/R2 setup, Next.js scaffold, CI/CD
- **Phase 1** (Weeks 3-6): Revenue Engine — Website, Booking, Widget, Payment, CRM, Notifications
- **Phase 2** (Weeks 7-12): Never Miss Lead — RAG, Voice, SMS, Web Chat
- **Phase 3** (Weeks 13-20): Digitise Paperwork — Workstation, CBT&A, E-Sign, Audit, Notes, Bridge Forms
- **Phase 4** (Weeks 21-28): Student/Parent Experience — Portals, Self-Assessment
- **Phase 5** (Weeks 29-34): Content & Authority — Competency Hub, Content expansion
- **Phase 6** (Weeks 35-42): Scale — Admin Panel, Multi-tenant RBAC, Analytics

---

## 25 COMPONENTS

C01 Website/CMS, C02 Booking Widget, C03 Student Portal, C04 Web Chat, C05 Voice Agent, C06 SMS Agent, C07 RAG Knowledge Engine, C08 Booking Engine, C09 CRM, C10 Payment Engine, C11 Instructor Workstation, C12 CBT&A Engine, C13 E-Signature, C14 Audit Trail, C15 Private Notes, C16 Parent Resources, C17 Competency Hub, C18 Notification Engine, C19 Admin Panel, C20 Multi-Instructor RBAC, C21 Analytics Dashboard, C22 Waitlist Manager, C23 Package Manager, C24 Self-Assessment Tool, C25 Lesson Bridge Forms

---

## WHAT TO UPLOAD TO NEW CHAT

Depending on what you're working on, upload these files:

**For Phase 4 (Sprint Planning):**
- This briefing (paste as text)
- `system-architecture-v1.1.md` (upload as file)
- `product-brief-v2.md` (upload as file)

**For Phase 5 (Component Specs):**
- This briefing (paste as text)
- `system-architecture-v1.1.md` (upload as file)
- The specific component section from the PRD

**For actual coding/building:**
- This briefing (paste as text)
- `system-architecture-v1.1.md` (upload as file)
- The specific component spec (once written)

---

## PENDING ACTION ITEMS (from Rob)

- Upload Driver Trainer tick-and-flick example (for C24 Self-Assessment design)
- Confirm exact pricing per service type (60/90/120 min, co-lesson, pre-test)
- Clarify if existing video content or all from scratch
- Provide any existing parent resources in draft form
- Confirm whether ACT Government accepts digital Certificate of Competency submission
- Typical daily schedule walkthrough (for voice agent availability logic)
