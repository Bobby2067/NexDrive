# NexDrive Academy — Testing Infrastructure Research
## Research #2: Vitest Service Layer & Mocking Patterns

**Status:** Research complete  
**Depends on:** RESEARCH-01 (Neon + Drizzle + Vitest CI/CD)  
**References:** NexDrive_System_Architecture_v1_1.md, Architecture Rule #8 (adapter pattern)

---

## Executive Summary

NexDrive talks to six external services: **Clerk** (auth), **Twilio** (SMS), **Resend** (email), **Vapi** (voice), **Anthropic** (Claude API), and **Upstash Redis** (rate limiting / slot locks). None of these should ever be called in unit tests. The architecture's "build for replacement" rule (adapter/interface pattern) is what makes this tractable — we mock our own adapter interfaces, not the SDKs themselves.

The key insight: **service layer tests never touch Clerk internals**. Auth is resolved before the service layer is reached. Tests inject a pre-resolved auth context directly.

---

## 1. Architecture That Makes This Work

### The Request Flow

```
HTTP Request
  → Clerk Middleware (validates JWT, attaches auth context)
  → Next.js Route Handler (calls auth(), extracts userId + role)
  → Service Layer (receives AuthContext, performs business logic)
  → Adapters (call external SDKs/APIs)
  → Database (Neon via Drizzle)
```

Unit tests enter at the **service layer**. They receive a fake `AuthContext` and call fake adapter implementations. No Clerk, no HTTP, no real DB.

Integration tests enter at the **service layer** too, but with a **real Neon branch DB** and fake adapters. The compliance-critical question is always "did the right rows get written?" — you can only answer that with a real database.

Route handler tests (thin layer) call the route function directly with a mock `NextRequest` and mock the service layer entirely.

---

## 2. Core Abstractions to Define Once

### 2.1 AuthContext Type

Every service function receives this instead of calling `auth()` directly:

```typescript
// src/types/auth.ts
export interface AuthContext {
  userId: string;        // Clerk user ID
  clerkUserId: string;   // same, explicit alias
  role: 'instructor' | 'student' | 'parent' | 'admin';
  instructorId?: string; // resolved from DB profile
  studentId?: string;
  tenantId: string;      // instructor_id for multi-tenant scoping
}
```

Services never call `auth()` from `@clerk/nextjs/server`. That's only done in route handlers. This one decision eliminates the entire Clerk-in-Vitest problem.

### 2.2 Adapter Interfaces

Defined once, used throughout. Architecture rule #8 mandated these — they pay off in testing:

```typescript
// src/lib/adapters/email.adapter.ts
export interface EmailAdapter {
  send(opts: {
    to: string;
    subject: string;
    html: string;
    from?: string;
  }): Promise<{ id: string }>;
}

// src/lib/adapters/sms.adapter.ts
export interface SmsAdapter {
  send(opts: {
    to: string;      // E.164 format: +61...
    body: string;
    from?: string;
  }): Promise<{ sid: string }>;
}

// src/lib/adapters/voice.adapter.ts
export interface VoiceAdapter {
  initiateCall(opts: {
    to: string;
    assistantId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ callId: string }>;
  endCall(callId: string): Promise<void>;
}

// src/lib/adapters/llm.adapter.ts
export interface LlmAdapter {
  complete(opts: {
    systemPrompt: string;
    userMessage: string;
    maxTokens?: number;
  }): Promise<string>;
  
  embed(text: string): Promise<number[]>;
}

// src/lib/adapters/cache.adapter.ts
export interface CacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  // For slot locking:
  setNX(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}
```

### 2.3 Adapter Registry / DI Container

Simple function-based DI — no framework needed at this scale:

```typescript
// src/lib/adapters/registry.ts
import type { EmailAdapter } from './email.adapter';
import type { SmsAdapter } from './sms.adapter';
import type { VoiceAdapter } from './voice.adapter';
import type { LlmAdapter } from './llm.adapter';
import type { CacheAdapter } from './cache.adapter';

export interface AdapterRegistry {
  email: EmailAdapter;
  sms: SmsAdapter;
  voice: VoiceAdapter;
  llm: LlmAdapter;
  cache: CacheAdapter;
}

// Production registry — lazy-loaded real implementations
let _registry: AdapterRegistry | null = null;

export function getAdapters(): AdapterRegistry {
  if (!_registry) {
    // Lazy import real implementations
    const { ResendEmailAdapter } = require('./impl/resend.email');
    const { TwilioSmsAdapter } = require('./impl/twilio.sms');
    const { VapiVoiceAdapter } = require('./impl/vapi.voice');
    const { AnthropicLlmAdapter } = require('./impl/anthropic.llm');
    const { UpstashCacheAdapter } = require('./impl/upstash.cache');

    _registry = {
      email: new ResendEmailAdapter(process.env.RESEND_API_KEY!),
      sms: new TwilioSmsAdapter(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!),
      voice: new VapiVoiceAdapter(process.env.VAPI_API_KEY!),
      llm: new AnthropicLlmAdapter(process.env.ANTHROPIC_API_KEY!),
      cache: new UpstashCacheAdapter(process.env.UPSTASH_REDIS_REST_URL!, process.env.UPSTASH_REDIS_REST_TOKEN!),
    };
  }
  return _registry;
}

// Test helper — inject fake adapters
export function setAdapters(registry: AdapterRegistry): void {
  _registry = registry;
}

export function resetAdapters(): void {
  _registry = null;
}
```

---

## 3. Fake Adapter Implementations for Tests

Live in `src/lib/adapters/fakes/`. Checked in, reused across all tests. Much cleaner than per-test `vi.fn()` setups.

```typescript
// src/lib/adapters/fakes/fake.email.adapter.ts
import type { EmailAdapter } from '../email.adapter';

export interface SentEmail {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

export class FakeEmailAdapter implements EmailAdapter {
  sent: SentEmail[] = [];
  
  async send(opts: SentEmail): Promise<{ id: string }> {
    this.sent.push(opts);
    return { id: `fake-email-${this.sent.length}` };
  }

  reset(): void {
    this.sent = [];
  }

  assertSent(to: string, subjectContains: string): void {
    const found = this.sent.find(
      e => e.to === to && e.subject.includes(subjectContains)
    );
    if (!found) {
      throw new Error(
        `Expected email to "${to}" with subject containing "${subjectContains}". ` +
        `Sent: ${JSON.stringify(this.sent.map(e => ({ to: e.to, subject: e.subject })))}`
      );
    }
  }
}
```

```typescript
// src/lib/adapters/fakes/fake.sms.adapter.ts
import type { SmsAdapter } from '../sms.adapter';

export interface SentSms {
  to: string;
  body: string;
}

export class FakeSmsAdapter implements SmsAdapter {
  sent: SentSms[] = [];
  shouldFail = false;

  async send(opts: { to: string; body: string }): Promise<{ sid: string }> {
    if (this.shouldFail) throw new Error('SMS delivery failed');
    this.sent.push(opts);
    return { sid: `fake-sms-${this.sent.length}` };
  }

  reset(): void {
    this.sent = [];
    this.shouldFail = false;
  }
}
```

```typescript
// src/lib/adapters/fakes/fake.cache.adapter.ts
import type { CacheAdapter } from '../cache.adapter';

export class FakeCacheAdapter implements CacheAdapter {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.store.has(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  reset(): void {
    this.store.clear();
  }
}
```

```typescript
// src/lib/adapters/fakes/index.ts — convenience factory
import { FakeEmailAdapter } from './fake.email.adapter';
import { FakeSmsAdapter } from './fake.sms.adapter';
import { FakeCacheAdapter } from './fake.cache.adapter';
import type { AdapterRegistry } from '../registry';

export function createFakeAdapters() {
  const email = new FakeEmailAdapter();
  const sms = new FakeSmsAdapter();
  const cache = new FakeCacheAdapter();

  const registry: AdapterRegistry = {
    email,
    sms,
    voice: { initiateCall: vi.fn().mockResolvedValue({ callId: 'fake-call' }), endCall: vi.fn() },
    llm: { complete: vi.fn().mockResolvedValue('Fake LLM response'), embed: vi.fn().mockResolvedValue(new Array(3072).fill(0)) },
    cache,
  };

  return { registry, email, sms, cache };
}
```

---

## 4. Test Helper: Auth Context Factory

```typescript
// src/test/helpers/auth.ts
import type { AuthContext } from '@/types/auth';

export function makeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user_test_instructor_01',
    clerkUserId: 'user_test_instructor_01',
    role: 'instructor',
    instructorId: 'inst_01',
    tenantId: 'inst_01',
    ...overrides,
  };
}

export function makeStudentAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return makeAuthContext({
    role: 'student',
    instructorId: undefined,
    studentId: 'stu_01',
    tenantId: 'inst_01',
    ...overrides,
  });
}

export function makeParentAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return makeAuthContext({
    role: 'parent',
    instructorId: undefined,
    tenantId: 'inst_01',
    ...overrides,
  });
}
```

---

## 5. Global Test Setup

```typescript
// src/test/setup.ts
import { vi, afterEach } from 'vitest';
import { resetAdapters } from '@/lib/adapters/registry';

// Reset all mocks and adapter registry after every test
afterEach(() => {
  vi.restoreAllMocks();
  resetAdapters();
});

// Suppress noisy console.error in tests (spy to verify, not see)
vi.spyOn(console, 'error').mockImplementation(() => {});
```

Referenced in `vitest.config.ts`:
```typescript
setupFiles: ['./src/test/setup.ts'],
```

---

## 6. Unit Test Patterns

### 6.1 Service Layer Unit Test (Notification Service)

```typescript
// src/services/__tests__/notification.service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { NotificationService } from '../notification.service';
import { createFakeAdapters } from '@/test/helpers/adapters';
import { setAdapters } from '@/lib/adapters/registry';
import { makeAuthContext, makeStudentAuthContext } from '@/test/helpers/auth';

describe('NotificationService', () => {
  let notificationService: NotificationService;
  let fakeEmail: FakeEmailAdapter;
  let fakeSms: FakeSmsAdapter;

  beforeEach(() => {
    const { registry, email, sms } = createFakeAdapters();
    setAdapters(registry);
    fakeEmail = email;
    fakeSms = sms;
    notificationService = new NotificationService();
  });

  describe('sendBookingConfirmation', () => {
    it('sends email and SMS to student on booking confirmation', async () => {
      const auth = makeAuthContext();
      const booking = {
        id: 'book_01',
        studentEmail: 'jane@example.com',
        studentPhone: '+61412345678',
        studentName: 'Jane Smith',
        startTime: new Date('2025-06-01T09:00:00+10:00'),
        durationMinutes: 60,
      };

      await notificationService.sendBookingConfirmation(auth, booking);

      fakeEmail.assertSent('jane@example.com', 'Booking Confirmed');
      expect(fakeSms.sent).toHaveLength(1);
      expect(fakeSms.sent[0].to).toBe('+61412345678');
      expect(fakeSms.sent[0].body).toContain('confirmed');
    });

    it('still sends email if SMS fails (graceful degradation)', async () => {
      fakeSms.shouldFail = true;
      const auth = makeAuthContext();

      await notificationService.sendBookingConfirmation(auth, {
        id: 'book_02',
        studentEmail: 'jane@example.com',
        studentPhone: '+61412345678',
        studentName: 'Jane Smith',
        startTime: new Date('2025-06-01T09:00:00+10:00'),
        durationMinutes: 60,
      });

      // Email still sent despite SMS failure
      expect(fakeEmail.sent).toHaveLength(1);
    });
  });
});
```

### 6.2 Route Handler Unit Test

Route handlers are thin — they extract auth from Clerk, call the service, return JSON. Test them by mocking both Clerk and the service:

```typescript
// src/app/api/bookings/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock Clerk's auth() helper — hoisted to top of file by Vitest
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

// Mock the service layer
vi.mock('@/services/booking.service', () => ({
  BookingService: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    getById: vi.fn(),
  })),
}));

import { auth } from '@clerk/nextjs/server';
import { BookingService } from '@/services/booking.service';
import { POST } from '../route';

describe('POST /api/bookings', () => {
  beforeEach(() => {
    // Default: authenticated instructor
    vi.mocked(auth).mockResolvedValue({
      userId: 'user_test_01',
      sessionClaims: { role: 'instructor', instructorId: 'inst_01' },
    } as any);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as any);

    const req = new NextRequest('http://localhost/api/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc_01', startTime: '2025-06-01T09:00:00Z' }),
    });

    const response = await POST(req);
    expect(response.status).toBe(401);
  });

  it('returns 201 on successful booking creation', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ id: 'book_01', status: 'pending' });
    vi.mocked(BookingService).mockImplementation(() => ({ create: mockCreate } as any));

    const req = new NextRequest('http://localhost/api/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc_01', startTime: '2025-06-01T09:00:00Z' }),
    });

    const response = await POST(req);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBe('book_01');
  });

  it('returns 403 when student tries to create booking for another student', async () => {
    vi.mocked(auth).mockResolvedValue({
      userId: 'user_student_01',
      sessionClaims: { role: 'student', studentId: 'stu_01' },
    } as any);

    const req = new NextRequest('http://localhost/api/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc_01', startTime: '2025-06-01T09:00:00Z', studentId: 'stu_99' }),
    });

    const response = await POST(req);
    expect(response.status).toBe(403);
  });
});
```

### 6.3 Private Notes — Defence in Depth Test

This is a compliance test. Private notes must never appear in student/parent responses even if the service is called incorrectly:

```typescript
// src/services/__tests__/private-notes.service.test.ts
import { describe, it, expect } from 'vitest';
import { PrivateNotesService } from '../private-notes.service';
import { makeStudentAuthContext, makeParentAuthContext, makeAuthContext } from '@/test/helpers/auth';

describe('PrivateNotesService access control', () => {
  const service = new PrivateNotesService();

  it('throws ForbiddenError when student attempts to access private notes', async () => {
    const auth = makeStudentAuthContext();
    await expect(service.getForStudent(auth, 'stu_01')).rejects.toThrow('Forbidden');
  });

  it('throws ForbiddenError when parent attempts to access private notes', async () => {
    const auth = makeParentAuthContext();
    await expect(service.getForStudent(auth, 'stu_01')).rejects.toThrow('Forbidden');
  });

  it('allows instructor to access private notes for their student', async () => {
    const auth = makeAuthContext({ role: 'instructor', instructorId: 'inst_01' });
    // This would call DB in integration tests; in unit tests we test the auth guard only
    await expect(service.getForStudent(auth, 'stu_01')).resolves.toBeDefined();
  });

  it('response shapes for students never include private_notes field', async () => {
    // This tests the response DTO transformation, not DB access
    const studentView = service.toStudentResponseShape({
      id: 'stu_01',
      name: 'Jane',
      private_notes: 'CONFIDENTIAL: student struggles with anxiety',
      lessons_count: 5,
    });

    expect(studentView).not.toHaveProperty('private_notes');
    expect(studentView).toHaveProperty('lessons_count');
  });
});
```

### 6.4 Booking Slot Lock Test (Cache Adapter)

```typescript
// src/services/__tests__/booking-engine.service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { BookingEngineService } from '../booking-engine.service';
import { FakeCacheAdapter } from '@/lib/adapters/fakes/fake.cache.adapter';
import { createFakeAdapters } from '@/test/helpers/adapters';
import { setAdapters } from '@/lib/adapters/registry';

describe('BookingEngineService — slot locking', () => {
  let service: BookingEngineService;
  let fakeCache: FakeCacheAdapter;

  beforeEach(() => {
    const { registry, cache } = createFakeAdapters();
    fakeCache = cache;
    setAdapters(registry);
    service = new BookingEngineService();
  });

  it('acquires slot lock before confirming booking', async () => {
    const slotKey = 'slot:inst_01:2025-06-01T09:00:00Z';
    
    const result = await service.lockSlot('inst_01', new Date('2025-06-01T09:00:00Z'));
    
    expect(result.acquired).toBe(true);
    expect(await fakeCache.get(slotKey)).toBeTruthy();
  });

  it('rejects double-booking when slot is already locked', async () => {
    await service.lockSlot('inst_01', new Date('2025-06-01T09:00:00Z'));
    
    // Second attempt at same slot
    const result = await service.lockSlot('inst_01', new Date('2025-06-01T09:00:00Z'));
    
    expect(result.acquired).toBe(false);
  });
});
```

---

## 7. What Belongs in Unit vs Integration vs E2E

| Test Type | Runs Against | Auth | External Services | DB | When |
|-----------|-------------|------|------------------|-----|------|
| **Unit** | Service/util logic | Fake `AuthContext` | Fake adapters | None | Every push |
| **Integration** | Service layer end-to-end | Fake `AuthContext` | Fake adapters | Real Neon branch | Every PR |
| **E2E** | Full app in browser | Real Clerk (test user) | Fake adapters / MSW | Real Neon branch | Pre-merge |

Integration tests are unit tests with a real DB wired in. The service receives the same fake `AuthContext` and fake adapters — only the database is real.

---

## 8. Vitest Config Update

The config from Research #1 extended to include the setup file and path alias:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: [
        'src/lib/adapters/impl/**',  // Real adapter impls — tested via E2E
        'src/lib/adapters/fakes/**', // Fake adapters — not production code
        '**/*.config.*',
        '**/migrations/**',
      ],
    },
    workspace: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/**/*.db.test.{ts,tsx}'],
          environment: 'node',
          pool: 'forks',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.db.test.{ts,tsx}'],
          environment: 'node',
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },  // Sequential DB tests
          testTimeout: 30_000,
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
```

---

## 9. The Clerk Mocking Decision

**Why we don't mock Clerk inside service layer tests at all:**

The architecture deliberately keeps Clerk calls confined to route handlers (`auth()`, `currentUser()`). Route handlers extract the auth context and pass it as a plain TypeScript object to services. This means:

- Service layer has zero Clerk imports → nothing to mock
- Route handler tests mock `@clerk/nextjs/server` with `vi.mock()` (one import, clean)  
- Clerk's ESM/CommonJS packaging issues don't affect service tests

The only place Clerk needs mocking is route handler tests, and there the pattern is simple:

```typescript
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn().mockResolvedValue({
    userId: 'user_test_01',
    sessionClaims: { role: 'instructor', instructorId: 'inst_01' },
  }),
}));
```

This is stable, type-safe, and doesn't depend on Clerk's internal implementation.

---

## 10. MSW: When to Use It

Mock Service Worker is **not needed** for our service layer tests because we use adapter interfaces. MSW is useful when testing code that makes raw `fetch()` calls — we don't do that.

MSW would be added later for:
- E2E tests where the browser makes API calls (Playwright + MSW)
- Testing the real Twilio/Resend/Vapi adapter implementations in isolation

For now: fake adapters cover all unit and integration testing needs.

---

## Summary

| Concern | Solution |
|---------|----------|
| Clerk auth in service tests | Don't import Clerk in services. Inject `AuthContext`. |
| Clerk auth in route tests | `vi.mock('@clerk/nextjs/server', ...)` |
| Twilio / Resend / Vapi / Claude | Fake adapter classes implementing adapter interfaces |
| Upstash Redis | `FakeCacheAdapter` (in-memory Map) |
| Private note leakage | Unit test the DTO transformer + auth guard separately |
| Test isolation | `resetAdapters()` + `vi.restoreAllMocks()` in `afterEach` |
| Type safety | `vi.mocked()` for type-safe mock access |
| Real DB needed | Integration tests (`.db.test.ts`) against Neon branch |
