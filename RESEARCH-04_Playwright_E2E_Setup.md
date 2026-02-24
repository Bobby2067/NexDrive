# RESEARCH-04: Playwright E2E Setup
## NexDrive Academy — Testing Infrastructure Series

**Status:** Complete  
**Depends on:** RESEARCH-01 (CI/CD), RESEARCH-02 (mocking), RESEARCH-03 (DB integration)  
**Scope:** Playwright config for Next.js App Router, Clerk auth in E2E, offline/Service Worker testing, CI pipeline integration

---

## 1. Overview

Playwright handles what Vitest cannot:
- Full browser rendering of async Next.js Server Components
- Real Clerk authentication flows (using testing tokens)
- Service Worker lifecycle testing (offline instructor workstation)
- Cross-component user flows end-to-end

**Rule:** Playwright tests are expensive. Only write them for critical user paths. Keep the suite lean.

### Critical Paths to Test with Playwright

1. **Booking flow** — student books lesson end-to-end (widget → payment → confirmation email)
2. **Instructor login + lesson recording** — offline workstation, IndexedDB sync
3. **CBT&A lesson record** — instructor marks competency, e-signature capture, append-only enforcement
4. **Parent portal access** — parent cannot see private notes (defence-in-depth smoke test)
5. **SMS/voice agent booking** — webhook triggers booking confirmation

Everything else lives in Vitest.

---

## 2. Installation & Config

```bash
npm install -D @playwright/test @clerk/testing dotenv
npx playwright install chromium  # Only Chromium for offline/SW tests; cross-browser via CI if needed
```

### Directory Structure

```
e2e/
  global.setup.ts          # clerkSetup + auth state generation
  fixtures/
    clerk-auth.ts          # Extended test fixture with Clerk helpers
  tests/
    booking-flow.spec.ts
    instructor-workstation.spec.ts
    lesson-record.spec.ts
    parent-portal.spec.ts
  playwright/.clerk/         # gitignored auth state files
    instructor.json
    student.json
    parent.json
playwright.config.ts
```

```bash
mkdir -p e2e/fixtures e2e/tests playwright/.clerk
echo '\nplaywright/.clerk' >> .gitignore
```

### `playwright.config.ts`

```typescript
import { defineConfig, devices } from '@playwright/test'
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '.env.local') })

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,       // NexDrive suite is small; sequential is fine and simpler
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,            // 30s per test
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ...(process.env.CI ? [['github'] as ['github']] : []),
  ],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'on-first-retry',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow',  // Required for instructor workstation offline tests
  },

  webServer: {
    command: 'npm run build && npm run start',
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },

  projects: [
    // Step 1: Run global setup (Clerk init + auth state generation)
    {
      name: 'global setup',
      testMatch: /global\.setup\.ts/,
    },

    // Step 2: Public tests (no auth required)
    {
      name: 'public',
      testMatch: /booking-flow\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['global setup'],
    },

    // Step 3: Authenticated tests — instructor
    {
      name: 'instructor',
      testMatch: /(instructor-workstation|lesson-record)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.clerk/instructor.json',
      },
      dependencies: ['global setup'],
    },

    // Step 4: Authenticated tests — parent (access control smoke tests)
    {
      name: 'parent',
      testMatch: /parent-portal\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.clerk/parent.json',
      },
      dependencies: ['global setup'],
    },
  ],
})
```

---

## 3. Clerk Authentication in E2E

### 3.1 How It Works

Clerk's `@clerk/testing` package provides:
- `clerkSetup()` — fetches a testing token that bypasses bot detection
- `clerk.signIn()` — programmatic sign-in using the testing token
- `page.context().storageState()` — persists cookies/localStorage so subsequent tests skip login

This means: sign in once per role per CI run, reuse state for all tests in that role's project.

### 3.2 Environment Variables

```bash
# .env.local (never commit)
# Clerk keys
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...

# E2E test users — created in Clerk dashboard, dev instance only
E2E_INSTRUCTOR_USERNAME=rob@nexdrive-test.com.au
E2E_INSTRUCTOR_PASSWORD=...
E2E_STUDENT_USERNAME=student@nexdrive-test.com.au
E2E_STUDENT_PASSWORD=...
E2E_PARENT_USERNAME=parent@nexdrive-test.com.au
E2E_PARENT_PASSWORD=...

# For CI
PLAYWRIGHT_BASE_URL=https://preview-xxx.vercel.app
```

**Clerk Dashboard setup:** Create a dedicated "Testing" environment (separate dev instance). Never use production Clerk keys for E2E tests.

### 3.3 `global.setup.ts`

```typescript
import { clerk, clerkSetup } from '@clerk/testing/playwright'
import { test as setup } from '@playwright/test'
import path from 'path'

// Must run serially
setup.describe.configure({ mode: 'serial' })

// 1. Configure Clerk testing tokens
setup('configure clerk', async () => {
  await clerkSetup()
})

// 2. Generate instructor auth state
const instructorAuthFile = path.join(__dirname, '../playwright/.clerk/instructor.json')
setup('authenticate instructor', async ({ page }) => {
  await page.goto('/')
  await clerk.signIn({
    page,
    signInParams: {
      strategy: 'password',
      identifier: process.env.E2E_INSTRUCTOR_USERNAME!,
      password: process.env.E2E_INSTRUCTOR_PASSWORD!,
    },
  })
  // Verify protected route is accessible
  await page.goto('/instructor/dashboard')
  await page.waitForSelector('[data-testid="instructor-dashboard"]')
  await page.context().storageState({ path: instructorAuthFile })
})

// 3. Generate parent auth state
const parentAuthFile = path.join(__dirname, '../playwright/.clerk/parent.json')
setup('authenticate parent', async ({ page }) => {
  await page.goto('/')
  await clerk.signIn({
    page,
    signInParams: {
      strategy: 'password',
      identifier: process.env.E2E_PARENT_USERNAME!,
      password: process.env.E2E_PARENT_PASSWORD!,
    },
  })
  await page.goto('/parent/dashboard')
  await page.waitForSelector('[data-testid="parent-dashboard"]')
  await page.context().storageState({ path: parentAuthFile })
})
```

### 3.4 Custom Fixture for DRY Tests

```typescript
// e2e/fixtures/clerk-auth.ts
import { test as base } from '@playwright/test'
import { clerk } from '@clerk/testing/playwright'

// Extend base test with Clerk sign-out helper
export const test = base.extend({
  // Auto-fixture: signs out after each test (optional, per project)
  autoSignOut: [async ({ page }, use) => {
    await use(undefined)
    // Teardown
    try {
      await clerk.signOut({ page })
    } catch {
      // Already signed out — fine
    }
  }, { auto: false }],
})

export { expect } from '@playwright/test'
```

---

## 4. Test Examples

### 4.1 Booking Flow (Public — No Auth)

```typescript
// e2e/tests/booking-flow.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Booking Widget', () => {
  test('student can book a lesson from the website', async ({ page }) => {
    await page.goto('/book')

    // Select service
    await page.getByRole('button', { name: /60 minute lesson/i }).click()

    // Pick a date slot
    await page.getByTestId('calendar-day').first().click()
    await page.getByTestId('time-slot').first().click()

    // Fill student details
    await page.getByLabel(/first name/i).fill('Jane')
    await page.getByLabel(/last name/i).fill('Smith')
    await page.getByLabel(/email/i).fill('jane@example.com')
    await page.getByLabel(/phone/i).fill('0400000000')

    // Proceed to payment (payment itself tested separately)
    await page.getByRole('button', { name: /continue to payment/i }).click()

    await expect(page).toHaveURL(/\/book\/payment/)
    await expect(page.getByText(/60 minute lesson/i)).toBeVisible()
  })

  test('double-booking is prevented', async ({ page }) => {
    // Book slot A in one context
    // Attempt to book same slot in page
    // Assert slot is shown as unavailable
    await page.goto('/book')
    // ... (full flow not shown for brevity)
  })
})
```

### 4.2 Instructor Workstation (Authenticated + Offline)

```typescript
// e2e/tests/instructor-workstation.spec.ts
import { test, expect } from '@playwright/test'

// storageState loaded from playwright.config.ts project definition

test.describe('Instructor Workstation — Offline', () => {
  test('SW registers and activates on workstation page', async ({ page, context }) => {
    // Listen for SW registration
    const swPromise = context.waitForEvent('serviceworker')
    await page.goto('/instructor/workstation')
    const sw = await swPromise

    // Wait for SW to activate
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg?.active?.state === 'activated') return
      await new Promise<void>(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve())
      })
    })

    expect(sw.url()).toContain('sw.js')
  })

  test('lesson form saves to IndexedDB when offline', async ({ page, context }) => {
    await page.goto('/instructor/workstation')

    // Wait for SW to be ready
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

    // Simulate going offline
    await context.setOffline(true)

    // Fill lesson record form
    await page.getByLabel(/student/i).selectOption({ label: 'Test Student' })
    await page.getByLabel(/duration/i).fill('60')
    await page.getByTestId('competency-task-1').check()
    await page.getByRole('button', { name: /save lesson/i }).click()

    // Offline save confirmation
    await expect(page.getByText(/saved locally/i)).toBeVisible()
    await expect(page.getByText(/will sync when online/i)).toBeVisible()

    // Go back online
    await context.setOffline(false)

    // Verify Background Sync fires (poll for sync complete indicator)
    await expect(page.getByTestId('sync-status')).toHaveText(/synced/i, { timeout: 15_000 })
  })

  test('cached workstation loads when fully offline', async ({ page, context }) => {
    // First visit (online — primes cache)
    await page.goto('/instructor/workstation')
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

    // Go offline — page navigated to different URL first
    await context.setOffline(true)
    await page.goto('/instructor/workstation')

    // Should still load from SW cache
    await expect(page.getByTestId('workstation-form')).toBeVisible()
    await expect(page.getByText(/offline mode/i)).toBeVisible()
  })
})
```

### 4.3 CBT&A Lesson Record (Authenticated — Instructor)

```typescript
// e2e/tests/lesson-record.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Lesson Record — CBT&A', () => {
  test('instructor can record lesson with competency assessment', async ({ page }) => {
    await page.goto('/instructor/lessons/new')

    // Select student and booking
    await page.getByLabel(/student/i).selectOption('Jane Smith')
    await page.getByTestId('booking-select').selectOption({ index: 0 })

    // Mark competencies
    await page.getByTestId('task-1-introduced').click()
    await page.getByTestId('task-2-practiced').click()

    // Instructor notes (private)
    await page.getByLabel(/private notes/i).fill('Student struggled with mirrors')

    // Submit
    await page.getByRole('button', { name: /complete lesson/i }).click()

    // E-signature flow
    await expect(page.getByTestId('signature-pad')).toBeVisible()
    // Draw signature via mouse
    const pad = page.getByTestId('signature-pad')
    const box = await pad.boundingBox()!
    await page.mouse.move(box!.x + 20, box!.y + 50)
    await page.mouse.down()
    await page.mouse.move(box!.x + 100, box!.y + 80)
    await page.mouse.up()

    await page.getByRole('button', { name: /confirm signature/i }).click()

    // Success
    await expect(page.getByText(/lesson recorded/i)).toBeVisible()
    await expect(page).toHaveURL(/\/instructor\/lessons\/\d+/)
  })

  test('lesson record is append-only — no edit button shown', async ({ page }) => {
    // Navigate to completed lesson
    await page.goto('/instructor/lessons/1')
    await expect(page.getByRole('button', { name: /edit/i })).not.toBeVisible()
    await expect(page.getByRole('button', { name: /delete/i })).not.toBeVisible()
  })
})
```

### 4.4 Parent Portal — Access Control Smoke Test

```typescript
// e2e/tests/parent-portal.spec.ts
import { test, expect } from '@playwright/test'

// Uses parent storageState from playwright.config.ts

test.describe('Parent Portal — Access Control', () => {
  test('parent can see student progress', async ({ page }) => {
    await page.goto('/parent/dashboard')
    await expect(page.getByTestId('student-progress')).toBeVisible()
    await expect(page.getByTestId('competency-summary')).toBeVisible()
  })

  test('private notes are never visible to parent', async ({ page }) => {
    await page.goto('/parent/dashboard')

    // No private notes element anywhere in DOM
    await expect(page.getByTestId('private-notes')).not.toBeAttached()

    // Navigate to student lesson history
    await page.goto('/parent/lessons')
    await expect(page.getByTestId('private-notes')).not.toBeAttached()

    // Check API response directly — private_notes field must be absent
    const response = await page.request.get('/api/parent/lessons')
    const json = await response.json()
    for (const lesson of json.data ?? []) {
      expect(lesson).not.toHaveProperty('private_notes')
      expect(lesson).not.toHaveProperty('privateNotes')
    }
  })

  test('parent cannot access instructor routes', async ({ page }) => {
    const response = await page.request.get('/api/instructor/lessons')
    expect(response.status()).toBe(403)
  })
})
```

---

## 5. Service Worker Testing Strategy

### What Playwright Can Test (Chromium Only)

| Scenario | Method |
|---|---|
| SW registers | `context.waitForEvent('serviceworker')` |
| SW activates | `page.evaluate()` on serviceWorker.ready |
| Offline page loads from cache | `context.setOffline(true)` → navigate |
| Form saves to IndexedDB offline | `context.setOffline(true)` → form submit → check UI indicator |
| Background Sync fires on reconnect | `context.setOffline(false)` → poll for sync indicator |
| SW intercepts API calls | `browserContext.route()` with `request.serviceWorker()` check |

### What Playwright Cannot Test

- Firefox/Safari SW (Playwright limitation — Chromium only for SW)
- Push notifications (no API in Playwright for push subscription)
- Exact IndexedDB contents (use `page.evaluate()` to query IDB directly if needed)

### Checking IndexedDB in Tests

```typescript
// Verify lesson was saved to IndexedDB when offline
const savedLesson = await page.evaluate(async () => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nexdrive-lessons')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('pending-lessons', 'readonly')
      const store = tx.objectStore('pending-lessons')
      const getAll = store.getAll()
      getAll.onsuccess = () => resolve(getAll.result)
      getAll.onerror = () => reject(getAll.error)
    }
  })
})
expect((savedLesson as any[]).length).toBeGreaterThan(0)
```

---

## 6. CI/CD Integration

Slots into the RESEARCH-01 GitHub Actions workflow as a final job after integration tests pass.

### Additional Secrets Required

```
E2E_INSTRUCTOR_USERNAME
E2E_INSTRUCTOR_PASSWORD
E2E_STUDENT_USERNAME
E2E_STUDENT_PASSWORD
E2E_PARENT_USERNAME
E2E_PARENT_PASSWORD
```

These credentials belong to test users created in the Clerk dev instance — never production.

### GitHub Actions Job

```yaml
  e2e-tests:
    name: E2E Tests (Playwright)
    runs-on: ubuntu-latest
    needs: [db-integration-tests]   # Only run if unit + integration pass
    if: github.event_name == 'pull_request'

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install chromium --with-deps

      - name: Build Next.js
        run: npm run build
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL_PREVIEW }}   # Preview branch URL from db job
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.CLERK_PUBLISHABLE_KEY_TEST }}
          CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY_TEST }}

      - name: Run Playwright E2E tests
        run: npx playwright test
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL_PREVIEW }}
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.CLERK_PUBLISHABLE_KEY_TEST }}
          CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY_TEST }}
          E2E_INSTRUCTOR_USERNAME: ${{ secrets.E2E_INSTRUCTOR_USERNAME }}
          E2E_INSTRUCTOR_PASSWORD: ${{ secrets.E2E_INSTRUCTOR_PASSWORD }}
          E2E_PARENT_USERNAME: ${{ secrets.E2E_PARENT_USERNAME }}
          E2E_PARENT_PASSWORD: ${{ secrets.E2E_PARENT_PASSWORD }}

      - name: Upload Playwright report
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

### Notes on the Build Step

- E2E tests run against a real Next.js production build (`npm run build && npm run start`), not `next dev`. This catches build-time errors and ensures the SW is registered correctly (dev mode doesn't register SWs the same way).
- The `DATABASE_URL_PREVIEW` comes from the Neon branch created by the earlier `db-branch-create` job (RESEARCH-01). E2E tests hit the same preview DB as integration tests.
- Vercel preview deployments can also be targeted by setting `PLAYWRIGHT_BASE_URL` to the Vercel preview URL. Add a `wait-for-url` step if using Vercel previews.

---

## 7. Local Development Workflow

```bash
# Run all E2E tests (will start Next.js server automatically)
npx playwright test

# Run specific suite
npx playwright test e2e/tests/instructor-workstation.spec.ts

# Interactive UI mode (best for debugging)
npx playwright test --ui

# Debug a specific test
npx playwright test --debug e2e/tests/parent-portal.spec.ts

# View last HTML report
npx playwright show-report
```

### Reusing Auth State Locally

The `playwright/.clerk/*.json` files are generated on first `global setup` run and reused for subsequent runs (because `reuseExistingServer: true` in non-CI mode). No need to sign in every time.

To force re-authentication (e.g., after test user password change):
```bash
rm playwright/.clerk/*.json && npx playwright test
```

---

## 8. Summary of Decisions

| Decision | Choice | Rationale |
|---|---|---|
| E2E runner | Playwright | Best-in-class for 2025, SW support, storageState, App Router compatible |
| Browser | Chromium only (locally + CI) | SW testing requires Chromium; cross-browser optional later |
| Auth pattern | Clerk testing tokens + storageState | Sign in once per role; reuse across tests. Official Clerk recommendation |
| Clerk env | Separate dev instance | Never use production keys for E2E |
| Offline testing | `context.setOffline(true)` + SW | Official Playwright API; works with IndexedDB + Background Sync |
| E2E scope | 5 critical paths only | Testing pyramid — most coverage from Vitest; Playwright for end-to-end smoke |
| Build mode | Production build | SW registers correctly; catches build-time issues |
| Private notes test | API response inspection | Defence-in-depth: DOM check + raw API response field check |
| CI trigger | PR only (after integration tests) | Expensive; gate behind cheaper tests |

---

## 9. Complete Test Type Matrix (All 4 Research Documents)

| Layer | Tool | Auth | DB | External | Trigger | Speed |
|---|---|---|---|---|---|---|
| Unit | Vitest | Fake AuthContext | None | Fake adapters | Every push | ~5s |
| Integration | Vitest | Fake AuthContext | Neon branch | Fake adapters | Every PR | ~30s |
| E2E | Playwright | Real Clerk (test user) | Neon branch | Real app stack | Every PR (after integration) | ~3-5min |

---

*End of RESEARCH-04. This completes the testing infrastructure research series (RESEARCH-01 through RESEARCH-04). Ready to proceed to Phase 4: Sprint Planning.*
