# NexDrive Academy — Master Todo List
**Last Updated:** February 2026  
**Branch:** dev/restructure  
**BMAD Phase:** 4 (Sprint Planning — next step)

> This file is updated every session. It is the single source of truth for project status.
> ✅ = Done | 🔵 = Ready to build | 🟣 = Spec written, not built | 🟠 = Blocked on decision | ⚪ = Future phase

---

## 🚨 DECISIONS NEEDED FROM ROB (Blocking)

| # | Decision | Notes |
|---|----------|-------|
| D1 | **Payment provider** — Stripe vs Tyro vs Square | Stripe recommended (easiest AU setup) |
| D2 | **Voice agent provider** — Vapi vs Bland vs Retell | Need eval session |
| D3 | **Domain name** — nexdriveacademy.com.au purchased? | Rob to check/buy |
| D4 | **Merge dev/restructure → main** | Recommend: do it now |
| D5 | **Website copy** — services list, pricing, Rob's bio | Needed before C01 can be built |
| D6 | **Lesson pricing** — what are the rates? | Needed to seed services table |
| D7 | **Knowledge base documents for RAG** | What does Rob want the AI to know? |

---

## ⚡ NEXT 10 ACTIONS (In Order)

- [ ] 1. Merge dev/restructure → main on GitHub (Rob, 2 mins)
- [ ] 2. Sign up for Clerk — create NexDrive application (Rob, 10 mins)
- [ ] 3. Sign up for Cloudflare — create R2 bucket (Rob, 10 mins)
- [ ] 4. Sign up for Upstash — create Redis instance Sydney (Rob, 5 mins)
- [ ] 5. Create .env.local with all credentials (Claude guides)
- [ ] 6. Connect GitHub repo to Vercel — first deploy (Rob + Claude)
- [ ] 7. Decide payment provider (Rob decision — D1)
- [ ] 8. Provide website content — services, pricing, bio (Rob — D5, D6)
- [ ] 9. Build C08 Booking Engine API (Claude builds)
- [ ] 10. Build C18 Notification Engine — email + SMS (Claude builds)

---

## SECTION 1 — Infrastructure & Foundation

### 1.1 Repository & Code
- [x] Clone repo + create dev/restructure branch
- [x] Remove Vite landing page (old nexdrive-app submodule)
- [x] Copy nexdrive-academy → nexdrive-platform/
- [x] Move all docs → docs/ folder
- [x] Push restructured repo to GitHub (dev/restructure)
- [x] Configure git identity (subscriptions@iondna.com.au)
- [x] Create TODO.md (this file)
- [ ] 🟠 Merge dev/restructure → main (D4)
- [ ] ⚪ Set up GitHub branch protection rules on main
- [ ] 🔵 Create .env.local from .env.example

### 1.2 Database (Neon)
- [x] Neon project created — Sydney ap-southeast-2 (ID: rough-bonus-24473548)
- [x] All 26 tables deployed
- [x] pgvector extension enabled
- [ ] 🔵 Create Neon dev branch (never develop on main)
- [ ] 🔵 Create Neon staging branch (before first deploy)
- [ ] 🔵 Add DATABASE_URL to .env.local
- [ ] 🔵 Seed competency_tasks (23 ACT CBT&A tasks)
- [ ] 🟠 Seed services table — needs Rob's pricing (D6)
- [ ] 🔵 Seed instructors table (Rob's profile — after Clerk setup)

### 1.3 Authentication (Clerk)
- [ ] 🔵 Create Clerk application (clerk.com)
- [ ] 🔵 Enable MFA + passkeys in Clerk dashboard
- [ ] 🔵 Configure custom roles: admin, instructor, student, parent
- [ ] 🔵 Add CLERK keys to .env.local
- [ ] 🔵 Set up Clerk webhook → /api/v1/webhooks/clerk
- [ ] 🔵 Install Clerk middleware (src/middleware.ts — scaffolded)
- [ ] 🔵 Create Rob's admin account in Clerk
- [ ] 🔵 Verify profile row created in Neon on signup

### 1.4 File Storage (Cloudflare R2)
- [ ] 🔵 Create R2 bucket in Cloudflare (Sydney/APAC)
- [ ] 🔵 Create R2 API token
- [ ] 🔵 Add R2 credentials to .env.local
- [ ] 🔵 Test file upload via adapter

### 1.5 Cache (Upstash Redis)
- [ ] 🔵 Create Upstash Redis instance (Sydney)
- [ ] 🔵 Add UPSTASH credentials to .env.local
- [ ] 🔵 Test rate limiting middleware

### 1.6 Hosting (Vercel)
- [ ] 🔵 Connect GitHub repo to Vercel
- [ ] 🔵 Set Vercel region to Sydney (syd1)
- [ ] 🔵 Add all environment variables to Vercel
- [ ] 🔵 Confirm first deploy succeeds
- [ ] 🟠 Connect custom domain (D3 — domain needed)
- [ ] ⚪ SSL certificate (auto after domain)

### 1.7 CI/CD & Monitoring
- [ ] 🔵 Set up Sentry project (sentry.io)
- [ ] ⚪ PostHog project (Phase 1 launch)
- [ ] ⚪ GA4 property (Phase 1 launch)
- [ ] ⚪ GitHub Actions: lint + typecheck on PR

---

## SECTION 2 — Phase 1: Revenue Engine (Weeks 3–6)

### Specs Written
- [x] 🟣 SPEC-01: Database Schema ERD
- [x] 🟣 SPEC-02: Auth & RBAC Design
- [x] 🟣 SPEC-03: Booking Engine API
- [x] 🟣 SPEC-04: Payment Engine API
- [x] 🟣 SPEC-05: CRM & Contacts API
- [x] 🟣 SPEC-06: Website Booking Widget
- [x] 🟣 SPEC-07: Notification Engine

### C01 — Website
- [ ] 🟠 Gather website copy (D5 — Rob to provide)
- [ ] 🟠 Services list + pricing (D6)
- [ ] ⚪ Build homepage (hero, services, CTA)
- [ ] ⚪ Build services page
- [ ] ⚪ Build about/instructor page
- [ ] ⚪ Build contact page
- [ ] ⚪ Connect booking widget
- [ ] ⚪ Mobile responsive pass
- [ ] ⚪ SEO: meta tags, sitemap, robots.txt
- [ ] ⚪ Google Business Profile (Rob does this in Google)

### C08 — Booking Engine API
- [ ] 🔵 Build availability service
- [ ] 🔵 Build slot generation
- [ ] 🔵 Build slot locking (Upstash Redis, 10-min hold)
- [ ] 🔵 POST /api/v1/bookings
- [ ] 🔵 GET /api/v1/availability
- [ ] 🔵 Booking confirmation logic
- [ ] 🔵 Cancellation + rescheduling
- [ ] ⚪ Rob's availability management UI
- [ ] ⚪ Calendar view for Rob
- [ ] ⚪ Automated reminder scheduling (needs C18)

### C02 — Booking Widget
- [ ] 🔵 Service selection step
- [ ] 🔵 Date picker
- [ ] 🔵 Time slot picker
- [ ] 🔵 Student details form
- [ ] 🔵 Payment step (needs C10)
- [ ] 🔵 Booking confirmation screen
- [ ] ⚪ Embed on website
- [ ] ⚪ Mobile optimisation

### C10 — Payment Engine
- [ ] 🟠 Decide provider: Stripe vs Tyro vs Square (D1)
- [ ] 🟠 Create merchant account
- [ ] 🟠 Build payment adapter
- [ ] ⚪ Payment intent creation
- [ ] ⚪ Webhook handler (payment → confirm booking)
- [ ] ⚪ Refund flow
- [ ] ⚪ Payment receipt emails

### C09 — CRM
- [ ] 🔵 Contact creation on booking
- [ ] 🔵 Contact list view for Rob
- [ ] 🔵 Contact detail view
- [ ] 🔵 Lead lifecycle status
- [ ] 🔵 Manual contact creation (phone bookings)
- [ ] ⚪ Search + filter

### C18 — Notification Engine
- [ ] 🔵 Set up Resend account + domain verification
- [ ] 🔵 Set up Twilio AU number
- [ ] 🔵 Booking confirmation email (student)
- [ ] 🔵 Booking confirmation SMS (student)
- [ ] 🔵 New booking alert to Rob
- [ ] 🔵 Lesson reminder email (24h before)
- [ ] 🔵 Lesson reminder SMS (2h before)
- [ ] ⚪ Cancellation confirmation email
- [ ] ⚪ Payment receipt email

---

## SECTION 3 — Phase 2: AI Agents (Weeks 7–12)

### Specs Written
- [x] 🟣 SPEC-08: RAG Knowledge Engine (v1.1)
- [x] 🟣 SPEC-09: Voice Agent Integration
- [x] 🟣 SPEC-10: SMS Chatbot
- [x] 🟣 SPEC-11: Web Chat Widget

### C07 — RAG Knowledge Engine
- [ ] ⚪ Document ingestion pipeline
- [ ] ⚪ OpenAI embeddings integration
- [ ] ⚪ Vector search endpoint
- [ ] ⚪ RAG query handler (Claude API)
- [ ] 🟠 Seed knowledge base (D7 — Rob to provide docs)

### C05 — Voice Agent
- [ ] 🟠 Evaluate + select voice provider (D2)
- [ ] ⚪ Build adapter
- [ ] ⚪ Connect to RAG engine
- [ ] ⚪ Call flow: greeting → enquiry → booking
- [ ] ⚪ Connect Twilio AU inbound number

### C06 — SMS Chatbot
- [ ] ⚪ Twilio inbound SMS webhook
- [ ] ⚪ Intent classification
- [ ] ⚪ RAG knowledge answers
- [ ] ⚪ Booking flow via SMS
- [ ] ⚪ Escalation to Rob

### C04 — Web Chat Widget
- [ ] ⚪ Chat bubble UI
- [ ] ⚪ RAG connection
- [ ] ⚪ Lead capture
- [ ] ⚪ Hand-off to booking widget

---

## SECTION 4 — Phase 3: Compliance (Weeks 13–20)

### Specs Written
- [x] 🟣 SPEC-12: Instructor Workstation
- [x] 🟣 SPEC-13: CBT&A Compliance Engine (v2.1)
- [x] 🟣 SPEC-14: E-Signature Service
- [x] 🟣 SPEC-15: Audit Trail
- [x] 🟣 SPEC-16: Lesson Bridge Forms

### C11 — Instructor Workstation
- [ ] ⚪ Offline PWA (Service Worker + IndexedDB)
- [ ] ⚪ Lesson recording screen
- [ ] ⚪ CBT&A checklist (23 tasks inline)
- [ ] ⚪ Background sync
- [ ] ⚪ Private notes field
- [ ] ⚪ Today's lesson queue

### C12 — CBT&A Compliance Engine
- [ ] 🔵 Seed 23 competency tasks (ACT codes)
- [ ] ⚪ Competency recording API (append-only)
- [ ] ⚪ Progress calculation per student
- [ ] ⚪ Competency dashboard for Rob
- [ ] ⚪ Form 10.044 digital record
- [ ] ⚪ PDF export for ACT submission

### C13 — E-Signature Service
- [ ] ⚪ Student signs lesson record
- [ ] ⚪ Instructor signs lesson record
- [ ] ⚪ Store signatures in R2
- [ ] ⚪ Signature hash in signatures table
- [ ] ⚪ Signature canvas (finger-friendly iPhone)

### C14 — Audit Trail
- [ ] ⚪ Append-only audit_log writer
- [ ] ⚪ SHA-256 hash chain
- [ ] ⚪ Audit log viewer for Rob
- [ ] ⚪ Tamper detection endpoint

### C15 — Private Notes
- [ ] ⚪ Private notes API (instructor only)
- [ ] ⚪ Verify NEVER in student/parent responses
- [ ] ⚪ UI in instructor workstation

### C25 — Lesson Bridge Forms
- [ ] ⚪ Build bridge form
- [ ] ⚪ Student completes before next lesson
- [ ] ⚪ Rob views in workstation

---

## SECTION 5 — Phase 4: Portals (Weeks 21–28)

### Specs Written
- [x] 🟣 SPEC-17: Student Portal
- [x] 🟣 SPEC-18: Parent Resource Centre
- [x] 🟣 SPEC-19: Self-Assessment Module

### C03 — Student Portal
- [ ] ⚪ Student login (Clerk)
- [ ] ⚪ Upcoming lessons view
- [ ] ⚪ Lesson history
- [ ] ⚪ CBT&A competency progress
- [ ] ⚪ Bridge form submission
- [ ] ⚪ Booking cancellation/reschedule
- [ ] ⚪ Payment history

### C16 — Parent Resource Centre
- [ ] ⚪ Parent login (Clerk)
- [ ] ⚪ Link parent to student
- [ ] ⚪ View competency progress (read-only)
- [ ] ⚪ View upcoming lessons
- [ ] ⚪ Verify private notes NEVER shown to parents

### C24 — Self-Assessment Tool
- [ ] ⚪ Student questionnaire
- [ ] ⚪ Store in self_assessments table
- [ ] ⚪ Results visible to Rob in workstation

---

## SECTION 6 — Phase 5 & 6: Scale (Weeks 29–42)

### Specs Written
- [x] 🟣 SPEC-20: Competency Hub Content

### Phase 5 — Content (Weeks 29–34)
- [ ] ⚪ C17: Competency Hub (23 task explanations + videos)
- [ ] ⚪ C17: Quizzes per competency
- [ ] ⚪ C01 expansion: Blog / SEO content
- [ ] ⚪ Rob records video content

### Phase 6 — Scale (Weeks 35–42)
- [ ] ⚪ C19: Admin panel
- [ ] ⚪ C20: Multi-instructor RBAC
- [ ] ⚪ C23: Package manager (bulk lesson packs)
- [ ] ⚪ C21: Analytics dashboard
- [ ] ⚪ C22: Waitlist manager

---

## SESSION LOG

| Date | What Happened |
|------|--------------|
| Feb 2026 | Repo restructured — nexdrive-platform/, docs/ organised, pushed to dev/restructure |
| Feb 2026 | Neon database confirmed live — all 26 tables deployed, Sydney |
| Feb 2026 | NexDrive_Complete_Todo.docx created and committed to docs/ |
| Feb 2026 | TODO.md created — now the live project tracker |
