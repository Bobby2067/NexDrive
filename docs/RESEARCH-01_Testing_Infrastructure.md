# NexDrive Academy — Testing Infrastructure Research
## Research #1: Neon + Drizzle + Vitest CI/CD Strategy

**Status:** Research complete  
**Next:** Research #2 (Vitest advanced patterns), Research #3 (DB integration tests), Research #4 (Playwright)  
**References:** SPEC-01 (Database Schema), NexDrive_System_Architecture_v1_1.md

---

## Executive Summary

This document defines the testing infrastructure for NexDrive Academy. The strategy uses **Neon database branching** to give every CI run a real, ephemeral PostgreSQL database — no mocking, no sqlite shims. Migrations run via **Drizzle Kit** (generate + migrate, Option 3). Tests run in **Vitest**. The whole thing is wired into **GitHub Actions** with branch-per-PR isolation.

For a compliance-critical app with append-only tables, immutable audit trails, and hash chains, this is the only testing approach that gives genuine confidence.

---

## 1. Neon Branching Strategy

### Branch Taxonomy

```
main (production)
├── staging              ← long-lived, mirrors main
├── preview/pr-{N}-{branch}  ← ephemeral, created on PR open, deleted on PR close  
└── dev/{name}           ← optional, per developer (local dev override)
```

### Branching Rules

| Trigger | Action | Branch Name | Lifetime |
|---------|--------|-------------|----------|
| PR opened/reopened/synced | Create branch | `preview/pr-{N}-{branch}` | Until PR closed |
| PR merged | Delete preview + apply migrations to production | — | — |
| PR closed (no merge) | Delete preview branch | — | — |
| Nightly CI on main | Reset staging branch from main | staging | Permanent |

### Key Properties of Neon Branches

- **Copy-on-write** — a branch from main takes seconds, not minutes. It starts with main's schema + data but writes are isolated.
- **Separate connection string** — each branch gets its own `DATABASE_URL`. CI injects this as an env variable, app code doesn't change.
- **Auto-suspend** — branches scale to zero when not in use. Preview branches that live for a few hours cost essentially nothing.
- **Not available on Free tier** — you need at least the Launch plan. This is fine; NexDrive needs a paid Neon plan for Sydney (`ap-southeast-2`) anyway.

---

## 2. Drizzle Migration Workflow

### Chosen Approach: Option 3 — Generate + Migrate

```
TypeScript schema (source of truth)
    ↓  drizzle-kit generate
SQL migration files (committed to repo, version controlled)
    ↓  drizzle-kit migrate
Database (applied per environment)
```

**Why not `drizzle-kit push`?** Push is great for prototyping but doesn't produce an auditable migration history. For a compliance app with ACT Government CBT&A requirements, we need versioned SQL files you can review in a PR — that's Option 3.

**Why not runtime migrate (Option 4)?** Running migrations inside the serverless function on cold start is fragile and adds latency. We run them explicitly in CI before tests.

### drizzle.config.ts

```typescript
// drizzle.config.ts
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '.env.local' });

export default defineConfig({
  schema: './src/db/schema/index.ts',   // barrel export of all tables
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Strict mode: fail on destructive migrations without explicit confirmation
  // This is important for compliance — we never want accidental drops
  strict: true,
});
```

### package.json scripts

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "db:push": "drizzle-kit push"
  }
}
```

`db:push` is kept for local dev convenience when iterating on schema during early development, but **never used in CI or production**.

### Schema File Structure

```
src/
  db/
    schema/
      users.ts          ← profiles, instructors, students, parents, parent_student_links
      crm.ts            ← contacts
      services.ts       ← services, availability_rules, availability_overrides
      bookings.ts       ← bookings, lessons (append-only)
      cbta.ts           ← competency_tasks, student_competencies (append-only)
      compliance.ts     ← signatures, audit_log (append-only)
      payments.ts       ← payments, packages, student_packages, vouchers
      comms.ts          ← conversations, messages, call_logs
      instructor.ts     ← private_notes, lesson_bridge_forms, self_assessments
      system.ts         ← notifications, rag_documents, rag_chunks, waitlist
      index.ts          ← barrel export: export * from './users' etc.
    index.ts            ← db connection + Drizzle instance
    migrate.ts          ← standalone migration runner (for CI scripts)
```

### DB Connection (Neon serverless + Drizzle)

```typescript
// src/db/index.ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle(sql, { schema });
export type DB = typeof db;
```

**Important:** The Neon serverless driver (`@neondatabase/serverless`) uses HTTP connections, not persistent TCP. This is ideal for Vercel serverless functions (no connection pool management) but means you need the `neon-http` Drizzle adapter, NOT `node-postgres`.

For migrations (which run in a Node.js script in CI, not serverless), you use `drizzle-kit migrate` which uses its own connection internally — you just point it at `DATABASE_URL`.

---

## 3. Vitest Configuration

### Critical Limitation: Async Server Components

From Next.js official docs (updated Feb 2026): *"Vitest currently does not support async Server Components. We recommend using E2E tests for async components."*

**Implication for NexDrive:** Vitest tests will cover:
- Service layer functions (pure business logic — no React)
- Utility functions, validators, calculators
- Synchronous React components (Client Components, sync Server Components)
- API route handler logic (extracted to service functions, not the route itself)
- Database integration tests via a test helper that connects to a Neon branch

Async Server Components (most of the actual pages) get covered by Playwright E2E.

### Install

```bash
pnpm add -D vitest @vitejs/plugin-react vite-tsconfig-paths jsdom \
  @testing-library/react @testing-library/dom @testing-library/user-event \
  @vitest/coverage-v8
```

### vitest.config.mts (root)

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    // Two separate pools: jsdom for React component tests, node for service/DB tests
    workspace: [
      {
        // React component tests
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/**/*.db.test.{ts,tsx}'],
          environment: 'jsdom',
          globals: true,
        },
      },
      {
        // DB integration tests — run in Node against real Neon branch
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.db.test.{ts,tsx}'],
          environment: 'node',
          globals: true,
          // These are slower — run sequentially to avoid connection exhaustion
          pool: 'forks',
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
          // Longer timeout for DB tests
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: [
        'src/db/schema/**',  // Schema definitions — not logic
        '**/*.d.ts',
        '**/migrations/**',
      ],
    },
  },
});
```

### File Naming Conventions

| File Pattern | Pool | Environment | Purpose |
|---|---|---|---|
| `*.test.ts` | unit | node | Pure service layer tests |
| `*.test.tsx` | unit | jsdom | React component tests |
| `*.db.test.ts` | integration | node | DB integration (real Neon) |

### package.json test scripts

```json
{
  "scripts": {
    "test": "vitest",
    "test:unit": "vitest --project unit",
    "test:integration": "vitest --project integration",
    "test:ci": "vitest run --coverage",
    "test:ci:unit": "vitest run --project unit --coverage",
    "test:ci:integration": "vitest run --project integration"
  }
}
```

In CI, unit tests and integration tests run as separate jobs — unit tests run on every push, integration tests run only when DB-touching files change (or on PR to main).

---

## 4. GitHub Actions Workflow

This is the core of the CI/CD pipeline. It wires everything together.

### Secrets & Variables Required

| Name | Type | Value |
|---|---|---|
| `NEON_API_KEY` | Secret | Neon API key (auto-created by Neon GitHub integration) |
| `DATABASE_URL` | Secret | Production Neon connection string |
| `NEON_PROJECT_ID` | Variable | Neon project ID |

### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main, staging]
  pull_request:
    types: [opened, reopened, synchronize, closed]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # ─── Unit Tests (no DB, fast) ────────────────────────────────────────────
  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest
    if: github.event.action != 'closed'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:ci:unit

  # ─── Neon Branch Management + Integration Tests ──────────────────────────
  db-branch-create:
    name: Create Neon Preview Branch & Run DB Tests
    runs-on: ubuntu-latest
    if: |
      github.event_name == 'pull_request' && (
        github.event.action == 'opened' ||
        github.event.action == 'reopened' ||
        github.event.action == 'synchronize'
      )
    outputs:
      db_url: ${{ steps.create_branch.outputs.db_url }}
      branch_id: ${{ steps.create_branch.outputs.branch_id }}
    steps:
      - uses: actions/checkout@v4

      - name: Create Neon Branch
        id: create_branch
        uses: neondatabase/create-branch-action@v5
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch_name: preview/pr-${{ github.event.number }}-${{ github.head_ref }}
          api_key: ${{ secrets.NEON_API_KEY }}

      - uses: pnpm/action-setup@v3
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      # Run migrations on the preview branch
      - name: Run Migrations on Preview Branch
        run: pnpm db:migrate
        env:
          DATABASE_URL: ${{ steps.create_branch.outputs.db_url }}

      # Run DB integration tests against preview branch
      - name: Run DB Integration Tests
        run: pnpm test:ci:integration
        env:
          DATABASE_URL: ${{ steps.create_branch.outputs.db_url }}
          NODE_ENV: test

      # Post schema diff to PR
      - name: Post Schema Diff Comment
        uses: neondatabase/schema-diff-action@v1
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          compare_branch: preview/pr-${{ github.event.number }}-${{ github.head_ref }}
          api_key: ${{ secrets.NEON_API_KEY }}

  db-branch-cleanup:
    name: Delete Neon Preview Branch
    runs-on: ubuntu-latest
    if: |
      github.event_name == 'pull_request' &&
      github.event.action == 'closed'
    steps:
      - name: Delete Preview Branch
        uses: neondatabase/delete-branch-action@v3
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch: preview/pr-${{ github.event.number }}-${{ github.head_ref }}
          api_key: ${{ secrets.NEON_API_KEY }}

      # On merge: apply migrations to production
      - uses: actions/checkout@v4
        if: github.event.pull_request.merged == true

      - uses: pnpm/action-setup@v3
        if: github.event.pull_request.merged == true
        with:
          version: 9
      - uses: actions/setup-node@v4
        if: github.event.pull_request.merged == true
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
        if: github.event.pull_request.merged == true

      - name: Apply Migrations to Production
        if: github.event.pull_request.merged == true
        run: pnpm db:migrate
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

---

## 5. Database Integration Test Pattern

This is the heart of why we chose this stack. Here's how a compliance-critical integration test looks.

### Test Helper: `src/test/db-helpers.ts`

```typescript
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import * as schema from '../db/schema';

/**
 * Creates a Drizzle DB instance pointed at the test DATABASE_URL.
 * In CI: DATABASE_URL is the Neon preview branch connection string.
 * In local dev: DATABASE_URL should point to your own Neon dev branch.
 * 
 * DO NOT use the production or staging DATABASE_URL for tests.
 */
export function createTestDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set for integration tests');
  
  const sql = neon(url);
  return drizzle(sql, { schema });
}

/**
 * Clears test data from tables in reverse dependency order.
 * Only clears data — never drops tables or removes schema.
 * 
 * Note: append-only tables (lessons, student_competencies, signatures, audit_log)
 * are cleared here for test isolation but this truncation would never happen
 * in production code — the tests verify that the production service layer
 * correctly enforces append-only rules.
 */
export async function clearTestData(db: ReturnType<typeof createTestDb>) {
  // Clear in reverse FK dependency order
  await db.execute(/* sql */`
    TRUNCATE TABLE
      audit_log,
      signatures,
      student_competencies,
      lessons,
      call_logs,
      messages,
      conversations,
      notifications,
      private_notes,
      self_assessments,
      lesson_bridge_forms,
      payments,
      vouchers,
      student_packages,
      bookings,
      waitlist,
      rag_chunks,
      rag_documents,
      parent_student_links,
      students,
      parents,
      instructors,
      contacts,
      availability_overrides,
      availability_rules,
      services,
      packages,
      profiles
    RESTART IDENTITY CASCADE
  `);
}
```

### Example: Audit Trail Integration Test

```typescript
// src/services/audit/__tests__/audit-trail.db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, clearTestData } from '../../../test/db-helpers';
import { AuditService } from '../audit.service';
import { eq } from 'drizzle-orm';
import { auditLog } from '../../../db/schema';

describe('AuditTrail — integration', () => {
  const db = createTestDb();
  let auditService: AuditService;

  beforeAll(async () => {
    await clearTestData(db);
    auditService = new AuditService(db);
  });

  it('creates an audit log entry with a valid SHA-256 hash', async () => {
    const entry = await auditService.log({
      entityType: 'booking',
      entityId: 'booking-123',
      action: 'created',
      actorId: 'user-abc',
      instructorId: 'instr-1',
    });

    expect(entry.hash).toMatch(/^[a-f0-9]{64}$/);  // SHA-256 hex
    expect(entry.prevHash).toBeNull();               // First entry
  });

  it('chains hashes correctly across successive entries', async () => {
    const first = await auditService.log({
      entityType: 'booking',
      entityId: 'booking-456',
      action: 'created',
      actorId: 'user-abc',
      instructorId: 'instr-1',
    });

    const second = await auditService.log({
      entityType: 'booking',
      entityId: 'booking-456',
      action: 'status_changed',
      actorId: 'user-abc',
      instructorId: 'instr-1',
      metadata: { from: 'pending', to: 'confirmed' },
    });

    expect(second.prevHash).toBe(first.hash);
  });

  it('audit log entries are truly immutable — UPDATE fails', async () => {
    const entry = await auditService.log({
      entityType: 'lesson',
      entityId: 'lesson-789',
      action: 'completed',
      actorId: 'user-abc',
      instructorId: 'instr-1',
    });

    // Attempt raw UPDATE — should throw because of DB-level constraint or trigger
    await expect(
      db.execute(/* sql */`
        UPDATE audit_log SET action = 'tampered' WHERE id = ${entry.id}
      `)
    ).rejects.toThrow();
  });
});
```

This test can only pass if:
1. The real Postgres schema has the right constraints/triggers for immutability
2. The hash chain logic in `AuditService` is correct
3. The Neon branch was correctly migrated before tests ran

You cannot fake any of this with mocks.

---

## 6. Local Development Setup

Developers need a personal Neon dev branch. They don't share a dev database.

### Setup Steps (once per developer)

```bash
# 1. Install Neon CLI
npm install -g neonctl

# 2. Authenticate
neonctl auth

# 3. Create personal dev branch from main
neonctl branches create --name dev/your-name --project-id <NEON_PROJECT_ID>

# 4. Get connection string
neonctl connection-string --branch dev/your-name --project-id <NEON_PROJECT_ID>

# 5. Add to .env.local (gitignored)
DATABASE_URL=postgres://...your-dev-branch-url...
```

```bash
# Run migrations on your dev branch
pnpm db:migrate

# Run integration tests locally (uses .env.local DATABASE_URL)
pnpm test:integration
```

---

## 7. Migration Safety Rules

These apply to NexDrive specifically given the compliance requirements:

1. **Never write a migration that deletes or modifies compliance data.** If lessons, audit_log, signatures, or student_competencies need structural changes, add columns — never drop or alter existing ones.

2. **Migration filenames are immutable.** Once generated and pushed, a migration file must not be renamed or edited. If you need to fix a migration, write a new one.

3. **Schema diff in PR comments is mandatory** (enforced by CI). No DB-touching PR can be merged without a reviewer seeing what changed.

4. **Staging mirrors production.** After a PR merges, staging resets from main within 24 hours (handled by a nightly GitHub Actions cron that calls the Neon reset-branch action).

5. **Never `db:push` after Phase 0.** Push destroys migration history. It's only for early scaffolding before the first production deploy.

---

## 8. Environment Variable Map

| Variable | Where Set | Value |
|---|---|---|
| `DATABASE_URL` | `.env.local` (gitignored) | Dev branch connection string |
| `DATABASE_URL` | GitHub Secrets | Production connection string |
| `DATABASE_URL` | GitHub Actions job env | Preview branch URL (set by create-branch-action output) |
| `NEON_API_KEY` | GitHub Secrets | Neon API key (auto-set by Neon GitHub integration) |
| `NEON_PROJECT_ID` | GitHub Variables | Neon project ID |

---

## 9. What This Gives NexDrive

| Concern | How It's Addressed |
|---|---|
| Tests actually enforce append-only | Real Postgres constraints tested, no mocking |
| Hash chain integrity verified | DB integration test with real sequential inserts |
| Schema changes reviewed before merge | Schema diff posted automatically to every PR |
| No test pollution between PRs | Each PR gets an isolated Neon branch |
| Production migrations are safe | Migrations run on preview branch first, then production on merge |
| Developers don't need local Postgres | Personal Neon dev branches |
| Cost | Preview branches auto-suspend, cost ~$0 for a few-hour lifecycle |

---

## Next Research Steps

| # | Topic | Status |
|---|---|---|
| 1 | Neon + Drizzle + CI | ✅ This document |
| 2 | Vitest advanced patterns — service layer testing, mocking Clerk + external services | ❌ Next |
| 3 | DB integration test patterns — seeding strategies, transaction rollback vs truncate | ❌ |
| 4 | Playwright setup — Next.js App Router, Clerk auth, offline Service Worker | ❌ |
