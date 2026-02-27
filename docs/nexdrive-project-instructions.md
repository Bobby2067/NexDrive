# NexDrive Academy — Project Instructions

You are helping build NexDrive Academy, a driving school platform for Rob Harrison's driving instruction business in Canberra, ACT, Australia.

## BMAD Methodology
This project follows BMAD (Business Method Architecture Design) — a phased approach:
- Phase 1: Product Brief ✅ (product-brief-v2.md)
- Phase 2: PRD ✅ (prd-part1.md + prd-part2.md)  
- Phase 3: System Architecture ✅ v1.1 (system-architecture-v1.1.md)
- Phase 4: Sprint Planning ← NEXT
- Phase 5: Component Specs (21 specs, each references the architecture)

## Tech Stack (decided)
- **Runtime:** Node.js 20 LTS, TypeScript 5.x
- **Framework:** Next.js 14.x (App Router), TailwindCSS 3.x
- **Database:** Neon (Serverless PostgreSQL 16+, Sydney, scale-to-zero, branching)
- **Auth:** Clerk (MFA, passkeys, webhook sync to our DB)
- **File Storage:** Cloudflare R2 (Sydney, S3-compatible, zero egress)
- **ORM:** Drizzle ORM with @neondatabase/serverless driver
- **Cache:** Upstash Redis (Sydney)
- **AI/LLM:** Claude API (claude-sonnet-4-5) for RAG engine
- **Embeddings:** OpenAI text-embedding-3-large + pgvector in Neon
- **Voice Agent:** Vapi.ai (adapter pattern for swap)
- **SMS:** Twilio (AU number)
- **Email:** Resend
- **Payments:** TBD (Stripe/Tyro/Square, AU market)
- **Hosting:** Vercel (frontend + API routes + cron jobs)
- **Analytics:** PostHog + GA4, Sentry for errors

## Key Architecture Decisions
1. Neon + Clerk + R2 over Supabase — best-of-breed, no single vendor lock-in
2. Application-level RBAC via Clerk middleware (not database-level RLS)
3. Append-only compliance tables (lessons, competencies, signatures, audit log) with SHA-256 hash chains
4. Custom booking engine (not SaaS) — deep competency integration is core IP
5. Next.js monorepo (not microservices) — right-sized for 1-2 instructors, 20-30 students
6. Internal event bus (EventEmitter v1, swap to BullMQ/SQS when scaling)

## Business Context
- ACT Government CBT&A (Competency Based Training & Assessment) — 23 competency tasks
- Digital Form 10.044 (lesson records) — must be audit-compliant
- Instructor operates from car with unreliable connectivity — offline-capable workstation required
- Private notes (instructor coaching notes) must NEVER be visible to students or parents
- Parent access is permission-controlled via parent_student_links table

## Database: 26 tables across 8 groups
User Management (5), CRM (1), Services & Availability (3), Booking & Lessons (2), CBT&A Compliance (2), Signatures & Audit (2), Payments (4), Communication (3), Instructor Tools (3), System (2)

Full schema with SQL in system-architecture-v1.1.md.

## API: 80+ endpoints across 11 route groups
Auth, Booking, Students, Lessons, CBT&A, CRM, Payments, AI Communication, RAG, Admin, Public Content.

Full contracts in system-architecture-v1.1.md.

## When answering questions:
- Always reference the architecture document for database tables, API endpoints, and integration patterns
- Component specs must reference specific tables and endpoints from the architecture
- Follow BMAD phase order — don't skip ahead
- Rob is non-technical but sharp — explain decisions clearly without patronising
- All monetary values in integer cents (AUD)
- All timestamps UTC, display in AEST
- Australian English spelling