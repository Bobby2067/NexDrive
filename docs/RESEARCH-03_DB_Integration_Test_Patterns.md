# RESEARCH-03: Database Integration Test Patterns
### NexDrive Academy — Seeding, Isolation & Transaction Strategy

**Date:** 22 February 2026  
**Status:** Complete — Ready for implementation  
**Depends on:** RESEARCH-01 (Neon branching, Vitest config), RESEARCH-02 (adapter interfaces, service layer patterns)

---

## 1. The Core Problem

Integration tests need a real database. The question is how to keep tests fast, isolated, and trustworthy when the database has:

- Append-only compliance tables with DB-level triggers
- SHA-256 hash chains that span rows
- 26 tables with a complex FK dependency graph
- Seed data that must always be present (23 competency tasks, default services)

There are three isolation strategies in common use:

| Strategy | Mechanism | Speed | Parallel-safe | NexDrive fit |
|---|---|---|---|---|
| **Truncate + reseed** | TRUNCATE all tables before each test | Slow (7s/test) | ✅ With care | ❌ Too slow at scale |
| **Transaction rollback** | Wrap each test in a TX, rollback after | Fast (~5ms overhead) | ✅ One connection per test | ✅ Best fit |
| **Schema-per-test** | CREATE SCHEMA per test, DROP after | Medium | ✅ Fully isolated | ❌ Overkill for Neon |

**Decision: Transaction rollback is the strategy for NexDrive.**

Real-world benchmark (Prisma/Postgres, same concept applies): same test suite went from **2h 53m → 2m 39s** (98% faster) by switching from truncate+reseed to transaction rollback with a single upfront seed.

---

## 2. Critical Driver Split: HTTP vs WebSocket

This is the most important technical constraint in Research #3.

**Production** uses the Neon HTTP driver — fast, stateless, edge-compatible:
```typescript
// src/db/index.ts (production)
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });
```

**The HTTP driver does NOT support interactive transactions.** It only supports non-interactive (single-shot batch) transactions via `sql.transaction()`. You cannot do `BEGIN` → multiple queries → `ROLLBACK` over HTTP. The connection is stateless.

**Tests** must use the WebSocket (Pool) driver — stateful, supports interactive transactions:
```typescript
// src/test/db.ts (test helper only — never imported by production code)
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

// Required in Node.js — no native WebSocket
neonConfig.webSocketConstructor = ws;

export function createTestDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return drizzle(pool, { schema });
}
```

**Additional dependency required for tests only:**
```bash
npm install -D ws @types/ws
```

The two drivers use identical Drizzle APIs. The only difference is the connection method. Production code is unchanged.

---

## 3. Transaction Rollback Implementation

### 3.1 The Test DB Wrapper

Each integration test file gets its own database connection that wraps every test in a transaction:

```typescript
// src/test/helpers/test-db.ts
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '@/db/schema';

neonConfig.webSocketConstructor = ws;

export interface TestDb {
  db: ReturnType<typeof drizzle>;
  cleanup: () => Promise<void>;
}

/**
 * Creates a Drizzle instance for integration tests.
 * Every operation runs inside a transaction that is rolled back after the test.
 *
 * Usage: see withTestTransaction() below.
 */
export function createTestDb(): TestDb {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  return {
    db,
    cleanup: async () => {
      await pool.end();
    },
  };
}

/**
 * Wraps a test body in a Postgres transaction and rolls it back after.
 * The seed data placed by globalSetup is always present.
 * Any data created during the test is invisible to other tests and discarded.
 *
 * @example
 * it('creates a booking', () => withTestTransaction(async (db) => {
 *   await db.insert(bookings).values({ ... });
 *   const result = await db.select().from(bookings);
 *   expect(result).toHaveLength(1);
 * }));
 */
export async function withTestTransaction<T>(
  testFn: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>
): Promise<T> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  neonConfig.webSocketConstructor = ws;
  const testDb = drizzle(pool, { schema });

  let result: T;

  try {
    await pool.connect();
    await testDb.execute(sql`BEGIN`);

    result = await testFn(testDb);

  } finally {
    // Always rollback — even if the test throws.
    // This ensures no test data leaks regardless of pass/fail.
    try {
      await testDb.execute(sql`ROLLBACK`);
    } catch {
      // Ignore rollback errors
    }
    await pool.end();
  }

  return result!;
}
```

### 3.2 Using the Transaction Helper in Tests

```typescript
// src/test/integration/booking.db.test.ts
import { describe, it, expect } from 'vitest';
import { withTestTransaction } from '@/test/helpers/test-db';
import { bookings, lessons } from '@/db/schema';
import { BookingService } from '@/services/booking-service';
import { createFakeAdapters } from '@/lib/adapters/fakes';
import { makeAuthContext } from '@/test/helpers/auth';

describe('BookingService — DB integration', () => {
  it('creates a booking and associated lesson record', () =>
    withTestTransaction(async (db) => {
      const fakeAdapters = createFakeAdapters();
      const svc = new BookingService(db, fakeAdapters);

      const booking = await svc.createBooking(
        makeAuthContext({ role: 'instructor' }),
        {
          studentId: SEED_IDS.student,
          serviceId: SEED_IDS.service_60min,
          startsAt: new Date('2026-03-01T09:00:00Z'),
        }
      );

      expect(booking.id).toBeDefined();

      // Verify it's actually in the DB (within the transaction)
      const rows = await db.select().from(bookings)
        .where(eq(bookings.id, booking.id));
      expect(rows).toHaveLength(1);
    })
  );

  it('does not leak data between tests', () =>
    withTestTransaction(async (db) => {
      // The booking created in the test above was rolled back.
      // Only seed data is present.
      const rows = await db.select().from(bookings);
      expect(rows).toHaveLength(0); // seed data has no bookings
    })
  );
});
```

---

## 4. Append-Only Tables: No Conflict With Rollback

The compliance tables (`lessons`, `student_competencies`, `signatures`, `audit_log`) have DB-level triggers that REJECT UPDATE and DELETE statements. There is a common concern that transaction rollback conflicts with append-only enforcement. It does not.

**Why rollback is safe with append-only triggers:**

The trigger fires on the SQL statement, not on the transaction commit. Sequence:

1. Test begins transaction (`BEGIN`)
2. Test inserts a `lesson` record → INSERT succeeds, trigger validates and sets hash
3. Test tries to UPDATE the lesson → trigger fires, raises EXCEPTION, UPDATE is rejected ✅
4. Test asserts the exception was raised ✅
5. `ROLLBACK` — the INSERT from step 2 is undone, next test starts clean

The triggers are exercised correctly. The rollback simply means the test data never persists to disk. This is exactly what we want.

**Testing that triggers correctly block mutations:**
```typescript
// src/test/integration/compliance.db.test.ts
import { describe, it, expect } from 'vitest';
import { withTestTransaction } from '@/test/helpers/test-db';
import { lessons, auditLog } from '@/db/schema';
import { sql } from 'drizzle-orm';

describe('Append-only enforcement — DB triggers', () => {
  it('rejects UPDATE on lessons', () =>
    withTestTransaction(async (db) => {
      // Insert a lesson (allowed)
      const [lesson] = await db.insert(lessons).values({
        bookingId: SEED_IDS.booking,
        instructorId: SEED_IDS.instructor,
        studentId: SEED_IDS.student,
        lessonDate: new Date(),
        durationMinutes: 60,
        status: 'in_progress',
        odometerStart: 12000,
        // ... other fields
      }).returning();

      // Attempt UPDATE (must be rejected by trigger)
      await expect(
        db.execute(sql`UPDATE lessons SET status = 'completed' WHERE id = ${lesson.id}`)
      ).rejects.toThrow(); // Postgres raises an exception
    })
  );

  it('rejects DELETE on audit_log', () =>
    withTestTransaction(async (db) => {
      const [entry] = await db.insert(auditLog).values({
        eventType: 'TEST_EVENT',
        severity: 'info',
        details: { test: true },
        recordHash: 'placeholder',
      }).returning();

      await expect(
        db.execute(sql`DELETE FROM audit_log WHERE id = ${entry.id}`)
      ).rejects.toThrow();
    })
  );

  it('computes SHA-256 hash on audit_log insert', () =>
    withTestTransaction(async (db) => {
      const [entry] = await db.insert(auditLog).values({
        eventType: 'LESSON_CREATED',
        severity: 'info',
        details: { lessonId: SEED_IDS.lesson },
        recordHash: 'placeholder', // trigger overrides this
      }).returning();

      // Trigger should have replaced 'placeholder' with a real SHA-256
      expect(entry.recordHash).not.toBe('placeholder');
      expect(entry.recordHash).toMatch(/^[a-f0-9]{64}$/);
    })
  );

  it('verifies hash chain integrity across two entries', () =>
    withTestTransaction(async (db) => {
      const [first] = await db.insert(auditLog).values({
        eventType: 'CHAIN_TEST_1',
        severity: 'info',
        details: {},
        recordHash: 'placeholder',
      }).returning();

      const [second] = await db.insert(auditLog).values({
        eventType: 'CHAIN_TEST_2',
        severity: 'info',
        details: {},
        recordHash: 'placeholder',
        previousHash: first.recordHash,
      }).returning();

      expect(second.previousHash).toBe(first.recordHash);
      expect(second.recordHash).not.toBe(first.recordHash);
      expect(second.recordHash).toMatch(/^[a-f0-9]{64}$/);
    })
  );
});
```

---

## 5. Seeding Strategy

### 5.1 Two-tier Seed Design

| Tier | What | When | How |
|---|---|---|---|
| **Baseline seed** | Immutable reference data | Once per test run (globalSetup) | `src/db/seed.ts` |
| **Per-test data** | Test-specific records | Inside each `withTestTransaction()` | Inline in test |

The baseline seed is the only data that every test can assume is present. Tests must never assume the database state left by a previous test.

### 5.2 Baseline Seed Contents

The baseline seed is the same script as production (`src/db/seed.ts`). It contains:

```
Seeded entities                           Count
─────────────────────────────────────────────────
competency_tasks (23 ACT CBT&A tasks)        23
profiles (Rob Harrison — instructor)          1
instructors (Rob's instructor record)         1
services (60min, 90min, 2hr, assessment)      7
contacts (initial CRM seed — 0 real students) 0
students                                      0  ← tests create their own
bookings                                      0  ← tests create their own
lessons                                       0  ← tests create their own
```

Tests must carry `SEED_IDS` constants that reference the stable UUIDs planted by the seed:

```typescript
// src/test/helpers/seed-ids.ts
// These UUIDs match what src/db/seed.ts inserts.
// If seed.ts changes these UUIDs, update this file too.

export const SEED_IDS = {
  instructor: 'a1b2c3d4-0000-0000-0000-000000000001',
  instructor_clerk: 'user_rob_harrison_test_clerk_id',
  service_60min: 'a1b2c3d4-0000-0000-0000-000000000010',
  service_90min: 'a1b2c3d4-0000-0000-0000-000000000011',
  service_assessment: 'a1b2c3d4-0000-0000-0000-000000000012',
  competency_task_01: 'a1b2c3d4-0000-0000-0000-000000000100',
  // ... all 23 tasks
} as const;
```

Using hardcoded UUIDs in the seed (not `gen_random_uuid()`) makes the seed deterministic and allows `SEED_IDS` constants in tests.

**Update `src/db/seed.ts` to use fixed UUIDs:**
```typescript
// src/db/seed.ts (excerpt)
import { SEED_IDS } from '@/test/helpers/seed-ids';
// Note: seed-ids is imported by both seed.ts and tests.
// It's in /test/ but seed.ts can import it — it's not production code.

await db.insert(instructors).values({
  id: SEED_IDS.instructor,
  clerkUserId: SEED_IDS.instructor_clerk,
  name: 'Rob Harrison',
  email: 'rob@nexdriveacademy.com.au',
  phone: '+61412345678',
  licenceNumber: 'ADI-ACT-12345',
  isActive: true,
}).onConflictDoNothing();
```

### 5.3 Global Setup — Running the Seed Once

```typescript
// vitest.globalSetup.ts
import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './src/db/schema';
import { runSeed } from './src/db/seed';

export async function setup() {
  neonConfig.webSocketConstructor = ws;

  // DATABASE_URL is the Neon preview branch URL injected by GitHub Actions
  // (or the dev branch URL locally)
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set for integration tests');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  // Run seed (idempotent — uses onConflictDoNothing)
  await runSeed(db);

  await pool.end();
  console.log('✅ Test database seeded');
}

export async function teardown() {
  // Nothing to teardown — Neon branch is deleted by GitHub Action
  // Locally, the dev branch persists (that's intentional)
}
```

**`vitest.config.ts` update:**
```typescript
export default defineConfig({
  test: {
    globalSetup: './vitest.globalSetup.ts', // seed runs once per test run
    setupFiles: ['./src/test/setup.ts'],     // adapter cleanup runs per-test
    // ... rest of config from RESEARCH-01
  },
});
```

---

## 6. Test Data Factories

Rather than constructing raw insert objects in every test, factories produce valid records with sensible defaults. They use the Drizzle instance passed to them (the transactional one), so all data is rolled back.

```typescript
// src/test/factories/index.ts
import type { DrizzleDb } from '@/test/helpers/test-db';
import { students, profiles, bookings, lessons } from '@/db/schema';
import { SEED_IDS } from '@/test/helpers/seed-ids';

export function factories(db: DrizzleDb) {
  return {
    async createStudent(overrides: Partial<typeof students.$inferInsert> = {}) {
      const profileId = crypto.randomUUID();

      await db.insert(profiles).values({
        id: profileId,
        clerkUserId: `user_test_${profileId}`,
        role: 'student',
        firstName: 'Test',
        lastName: 'Student',
        email: `test+${profileId}@example.com`,
        phone: '+61400000000',
      });

      const [student] = await db.insert(students).values({
        profileId,
        instructorId: SEED_IDS.instructor,
        licenceType: 'car',
        licenceClass: 'C',
        logbookHours: 0,
        status: 'active',
        ...overrides,
      }).returning();

      return student;
    },

    async createBooking(studentId: string, overrides: Partial<typeof bookings.$inferInsert> = {}) {
      const [booking] = await db.insert(bookings).values({
        studentId,
        instructorId: SEED_IDS.instructor,
        serviceId: SEED_IDS.service_60min,
        startsAt: new Date('2026-03-01T09:00:00Z'),
        endsAt: new Date('2026-03-01T10:00:00Z'),
        status: 'confirmed',
        locationMeetingPoint: '123 Test St, Canberra ACT 2600',
        priceAtBookingCents: 9500,
        ...overrides,
      }).returning();

      return booking;
    },

    async createLesson(bookingId: string, studentId: string, overrides: Partial<typeof lessons.$inferInsert> = {}) {
      const [lesson] = await db.insert(lessons).values({
        bookingId,
        instructorId: SEED_IDS.instructor,
        studentId,
        lessonDate: new Date('2026-03-01'),
        durationMinutes: 60,
        status: 'in_progress',
        odometerStart: 12000,
        startLocation: 'Woden Town Centre',
        weatherConditions: 'clear',
        lightConditions: 'day',
        trafficConditions: 'light',
        ...overrides,
      }).returning();

      return lesson;
    },
  };
}
```

**Using factories in a test:**
```typescript
it('records a completed lesson', () =>
  withTestTransaction(async (db) => {
    const f = factories(db);
    const student = await f.createStudent();
    const booking = await f.createBooking(student.id);
    const lesson = await f.createLesson(booking.id, student.id);

    // Now exercise the service
    const svc = new LessonService(db, createFakeAdapters());
    const completed = await svc.completeLesson(
      makeAuthContext({ role: 'instructor' }),
      lesson.id,
      { odometerEnd: 12045, totalKm: 45, instructorNotes: 'Good lesson' }
    );

    expect(completed.status).toBe('completed');
    expect(completed.totalKm).toBe(45);
  })
);
```

---

## 7. What NOT to Test at the DB Layer

Integration tests are expensive relative to unit tests. Only write DB integration tests for things that cannot be verified without a real database:

| Test this at DB layer | Test this at service unit level |
|---|---|
| Trigger behaviour (append-only, hash chain) | Business rule enforcement |
| FK constraint violations | Role-based access control |
| Unique index enforcement | Notification sending logic |
| Generated column correctness (`total_km`) | Adapter calls (email, SMS) |
| Seed data presence (23 tasks) | Response shape / DTO transformation |
| Real Drizzle query correctness | Slot locking (use FakeCacheAdapter) |

Private note visibility is a **unit test** — test that `toStudentResponseShape()` strips the field. It does not need a real DB to verify that a TypeScript function omits a property.

---

## 8. Parallel Test Execution

Each test runs in its own connection (its own `Pool` instance) and its own transaction. Tests do not share a connection and cannot see each other's uncommitted data, so they are safe to run in parallel.

**Vitest config for integration tests (from RESEARCH-01, confirmed here):**
```typescript
// vitest.config.ts
{
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,  // allow parallel workers
      }
    },
    // Integration test files run sequentially within a worker
    // but multiple workers can run in parallel.
    testTimeout: 30_000,
  }
}
```

One caveat: **hash chain tests** are order-sensitive. Two tests that both insert into `audit_log` and check `previousHash` values must not run in parallel — the chain order is non-deterministic across concurrent transactions. Group hash chain tests in a single `describe` block and mark the file as single-threaded if needed:

```typescript
// vitest.config.ts integration pool override
{
  include: ['**/*.db.test.ts'],
  poolOptions: {
    forks: {
      singleFork: true  // hash chain safety — sequential execution for integration tests
    }
  }
}
```

This is a safe default. Integration tests are already fast with transaction rollback, so sequential execution at the file level is not a bottleneck.

---

## 9. Local Developer Workflow

```bash
# 1. Set your dev branch URL
# .env.local already has DATABASE_URL pointing to dev/{yourname} Neon branch

# 2. Run only unit tests (no DB needed)
npx vitest run --project unit

# 3. Run integration tests (hits your dev Neon branch)
npx vitest run --project integration

# 4. Run everything
npx vitest run

# 5. Watch mode during development
npx vitest --project unit  # fast feedback loop
```

The dev branch is seeded once when you first set it up. The seed is idempotent (`onConflictDoNothing`) so re-running it is safe. Transaction rollback means integration tests never dirty the dev branch.

---

## 10. CI/CD Integration

This slotsin cleanly with the GitHub Actions workflow from RESEARCH-01:

```yaml
# .github/workflows/ci.yml (integration-tests job, additions from RESEARCH-01)
- name: Run integration tests
  env:
    DATABASE_URL: ${{ steps.create-branch.outputs.db-url }}
    # The Neon preview branch URL contains credentials — treat as secret
  run: |
    npx vitest run --project integration
    # globalSetup seeds the branch before any test file runs
    # Transaction rollback ensures branch is clean after each test
    # Branch is deleted in the cleanup job (RESEARCH-01)
```

No additional steps needed. The `globalSetup` handles seeding, transaction rollback handles isolation, and the Neon branch cleanup job from RESEARCH-01 handles teardown.

---

## 11. Summary: Decisions Made

| Decision | Choice | Reason |
|---|---|---|
| Isolation strategy | Transaction rollback | 98% faster than truncate+reseed; safe with append-only triggers |
| Test driver | WebSocket Pool (`drizzle-orm/neon-serverless`) | HTTP driver cannot support interactive transactions |
| Production driver | HTTP (`drizzle-orm/neon-http`) | Unchanged — tests don't affect production code |
| Seed timing | Once per run (globalSetup) | Seed data is stable; rollback provides isolation |
| Seed UUIDs | Hardcoded deterministic UUIDs | Allows `SEED_IDS` constants in test helpers |
| Append-only conflict | No conflict | Triggers fire on SQL statement, not commit; rollback is transparent |
| Hash chain tests | Sequential (singleFork) | Chain order is non-deterministic if run in parallel |
| Test factories | Drizzle-aware factory functions | Operate inside the test transaction; rolled back automatically |
| Per-test data | Inline in test via factory | No shared mutable state between tests |

---

*End of RESEARCH-03: Database Integration Test Patterns*

*Next: RESEARCH-04 — Playwright setup (Next.js App Router, Clerk auth handling in E2E, offline Service Worker, CI pipeline)*
