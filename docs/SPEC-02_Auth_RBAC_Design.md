# SPEC-02: Auth & RBAC Design
### NexDrive Academy — Phase 0 Foundation
**Version:** 1.0  
**Date:** 20 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §3.1.1, §3.4, §6.1–6.6; PRD v2.1 NFR-3; SPEC-01 (Database Schema)  
**Phase:** 0 (Foundation — Week 1-2)  
**Estimated Effort:** 4-5 days  

---

## 1. Overview

This specification defines the complete authentication and role-based access control (RBAC) layer for NexDrive Academy. It covers Clerk application setup, webhook synchronisation with our Neon database, Next.js middleware, RBAC utility functions, rate limiting, session configuration, and the full access control matrix enforced in code.

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **Clerk owns identity.** Our database stores business data linked via `clerk_user_id` (TEXT). No passwords, sessions, or MFA tokens in our DB.
2. **No database-level RLS.** All access control is enforced in Clerk middleware + service layer (per ADR-004).
3. **Four roles:** `admin`, `instructor`, `student`, `parent`. Stored in `profiles.role` and mirrored in Clerk `publicMetadata`.
4. **Private notes are NEVER visible to students or parents.** Defence in depth: role check in service layer + excluded from response shapes entirely.
5. **Append-only tables cannot be modified** — `lessons`, `student_competencies`, `signatures`, `audit_log`. Auth layer must enforce this.
6. **Multi-tenant scoping** — every tenant-scoped query includes `instructor_id` filter for instructor role.
7. **Session timeouts** — 30 min inactive for student/parent, 8 hours for instructor (per NFR-3).
8. **Rate limiting** — 100 req/min unauthenticated, 300 req/min authenticated, 10 req/min mutations (per NFR-3 + §4.1).
9. **Australian data residency** — Clerk is global/edge but all business data stays in Sydney.

### 1.2 Roles & Permissions Summary

| Role | Description | Custom Claims |
|------|------------|---------------|
| `admin` | Platform owner (Rob). Full access to everything. | `role`, `profile_id`, `instructor_id`, `is_owner: true` |
| `instructor` | ADI-certified driving instructor. Sees own students + own data. | `role`, `profile_id`, `instructor_id` |
| `student` | Learner driver. Sees own data only. | `role`, `profile_id`, `student_id` |
| `parent` | Parent/guardian/supervisor. Sees linked student data per permissions. | `role`, `profile_id`, `parent_id` |

---

## 2. File Structure

```
src/
├── lib/
│   ├── auth/
│   │   ├── index.ts                    # Barrel export
│   │   ├── types.ts                    # AuthContext, Role, ClerkSessionClaims types
│   │   ├── context.ts                  # getAuthContext() — extract auth from Clerk
│   │   ├── require-role.ts             # requireRole() guard
│   │   ├── require-ownership.ts        # requireOwnership() guard
│   │   ├── scope-queries.ts            # scopeByInstructor(), scopeByStudent(), scopeByParentLink()
│   │   ├── access-control.ts           # Access control matrix enforcement
│   │   ├── private-notes-guard.ts      # Defence-in-depth for private notes
│   │   ├── errors.ts                   # AuthRequiredError, ForbiddenError
│   │   └── constants.ts                # Public routes, rate limit configs
│   ├── rate-limit/
│   │   ├── index.ts                    # Rate limiter factory
│   │   └── config.ts                   # Rate limit tiers
│   └── webhooks/
│       └── clerk.ts                    # Clerk webhook event handlers
├── middleware.ts                        # Next.js middleware (Clerk + route protection)
├── app/
│   └── api/
│       └── v1/
│           └── webhooks/
│               └── clerk/
│                   └── route.ts        # POST /api/v1/webhooks/clerk
└── __tests__/
    └── lib/
        └── auth/
            ├── require-role.test.ts
            ├── require-ownership.test.ts
            ├── scope-queries.test.ts
            ├── access-control.test.ts
            ├── private-notes-guard.test.ts
            └── rate-limit.test.ts
```

---

## 3. Dependencies

```bash
# Already installed via SPEC-01
# @clerk/nextjs, drizzle-orm, @neondatabase/serverless

# New dependencies for SPEC-02
npm install svix                      # Clerk webhook signature verification
npm install @upstash/ratelimit        # Rate limiting
npm install @upstash/redis            # Redis client for rate limiter
npm install zod                       # Input validation (if not already)
```

### 3.1 Environment Variables

Add to `.env.local` (and Vercel environment settings):

```env
# Clerk (from SPEC-01 setup)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_xxx
CLERK_SECRET_KEY=sk_live_xxx

# Clerk Webhook (new for SPEC-02)
CLERK_WEBHOOK_SECRET=whsec_xxx          # From Clerk Dashboard → Webhooks

# Upstash Redis (new for SPEC-02)
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxx...

# Domain (for CORS)
NEXT_PUBLIC_APP_URL=https://nexdriveacademy.com.au
```

---

## 4. Type Definitions

### File: `src/lib/auth/types.ts`

```typescript
// ============================================================
// NexDrive Academy — Auth Types
// Reference: System Architecture v1.1 §6.2
// ============================================================

/**
 * The four application roles.
 * Stored in profiles.role and mirrored in Clerk publicMetadata.
 */
export type Role = 'admin' | 'instructor' | 'student' | 'parent';

/**
 * Custom session claims set via Clerk's session token template.
 * These are available on every authenticated request via auth().sessionClaims.
 *
 * Clerk Dashboard → Sessions → Edit session token template:
 * {
 *   "role": "{{user.public_metadata.role}}",
 *   "instructor_id": "{{user.public_metadata.instructor_id}}",
 *   "student_id": "{{user.public_metadata.student_id}}",
 *   "parent_id": "{{user.public_metadata.parent_id}}",
 *   "is_owner": "{{user.public_metadata.is_owner}}",
 *   "profile_id": "{{user.public_metadata.profile_id}}"
 * }
 */
export interface ClerkSessionClaims {
  sub: string;              // clerk_user_id (e.g., 'user_2abc123')
  email: string;
  role: Role;
  instructor_id?: string;   // UUID from our instructors table
  student_id?: string;      // UUID from our students table
  parent_id?: string;       // UUID from our parents table
  is_owner?: boolean;       // Platform owner flag (Rob = true)
  profile_id: string;       // UUID from our profiles table
}

/**
 * Resolved auth context available to all service-layer functions.
 * Created by getAuthContext() from Clerk's auth() response.
 */
export interface AuthContext {
  clerkUserId: string;
  role: Role;
  profileId: string;
  instructorId?: string;
  studentId?: string;
  parentId?: string;
  isOwner: boolean;
}

/**
 * Clerk webhook event data shape for user events.
 * Subset of fields we actually use.
 */
export interface ClerkUserEventData {
  id: string;                 // clerk_user_id
  email_addresses: Array<{
    id: string;
    email_address: string;
  }>;
  primary_email_address_id: string;
  phone_numbers: Array<{
    id: string;
    phone_number: string;
  }>;
  primary_phone_number_id: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  public_metadata: Record<string, unknown>;
  created_at: number;         // Unix timestamp ms
  updated_at: number;
}

/**
 * Clerk webhook event wrapper.
 */
export interface ClerkWebhookEvent {
  type: string;
  data: ClerkUserEventData;
  object: 'event';
}

/**
 * Tables in the access control matrix.
 */
export type ProtectedTable =
  | 'profiles'
  | 'instructors'
  | 'students'
  | 'bookings'
  | 'lessons'
  | 'student_competencies'
  | 'signatures'
  | 'private_notes'
  | 'payments'
  | 'conversations'
  | 'call_logs'
  | 'audit_log'
  | 'contacts'
  | 'services'
  | 'availability_rules'
  | 'availability_overrides'
  | 'packages'
  | 'student_packages'
  | 'vouchers'
  | 'notifications'
  | 'competency_tasks'
  | 'lesson_bridge_forms'
  | 'self_assessments'
  | 'parent_student_links';

/**
 * Access levels for the matrix.
 */
export type AccessLevel = 'all' | 'own' | 'scoped' | 'read' | 'none';
```

---

## 5. Auth Context Extraction

### File: `src/lib/auth/context.ts`

```typescript
// ============================================================
// NexDrive Academy — Auth Context Extraction
// Wraps Clerk's auth() to produce a typed AuthContext.
// Reference: System Architecture v1.1 §6.2, §6.3
// ============================================================

import { auth } from '@clerk/nextjs/server';
import { AuthRequiredError } from './errors';
import type { AuthContext, Role } from './types';

/**
 * Extract and validate auth context from the current request.
 * Call this at the top of every authenticated API route handler.
 *
 * @throws AuthRequiredError if no valid session exists
 * @returns Typed AuthContext with all role-specific IDs
 *
 * @example
 * export async function GET(req: NextRequest) {
 *   const ctx = await getAuthContext();
 *   // ctx.role, ctx.clerkUserId, ctx.instructorId, etc.
 * }
 */
export async function getAuthContext(): Promise<AuthContext> {
  const { userId, sessionClaims } = await auth();

  if (!userId) {
    throw new AuthRequiredError();
  }

  const role = (sessionClaims?.role as Role) ?? null;
  if (!role) {
    // User exists in Clerk but has no role set in publicMetadata yet.
    // This happens if the webhook hasn't fired or role assignment is pending.
    throw new AuthRequiredError(
      'Account setup incomplete. Please contact support.'
    );
  }

  return {
    clerkUserId: userId,
    role,
    profileId: sessionClaims?.profile_id as string,
    instructorId: sessionClaims?.instructor_id as string | undefined,
    studentId: sessionClaims?.student_id as string | undefined,
    parentId: sessionClaims?.parent_id as string | undefined,
    isOwner: sessionClaims?.is_owner === true || sessionClaims?.is_owner === 'true',
  };
}

/**
 * Optional auth — returns null instead of throwing when unauthenticated.
 * Useful for routes that behave differently for authed vs unauthed users
 * (e.g., booking widget shows personalised data if logged in).
 */
export async function getOptionalAuthContext(): Promise<AuthContext | null> {
  try {
    return await getAuthContext();
  } catch {
    return null;
  }
}
```

---

## 6. Error Types

### File: `src/lib/auth/errors.ts`

```typescript
// ============================================================
// NexDrive Academy — Auth Error Types
// Reference: System Architecture v1.1 §4.3 (Error Codes)
// ============================================================

/**
 * Base class for API errors with structured response format.
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * Standard error response envelope per arch doc §4.3.
   */
  toResponse(): Response {
    return Response.json(
      {
        error: {
          code: this.code,
          message: this.message,
          ...(this.details && { details: this.details }),
        },
      },
      { status: this.httpStatus }
    );
  }
}

/**
 * 401 — Missing or invalid authentication token.
 * Arch doc error code: AUTH_REQUIRED
 */
export class AuthRequiredError extends ApiError {
  constructor(message = 'Authentication required.') {
    super('AUTH_REQUIRED', message, 401);
    this.name = 'AuthRequiredError';
  }
}

/**
 * 403 — Valid auth but insufficient permissions.
 * Arch doc error code: FORBIDDEN
 */
export class ForbiddenError extends ApiError {
  constructor(message = 'You do not have permission to access this resource.') {
    super('FORBIDDEN', message, 403);
    this.name = 'ForbiddenError';
  }
}

/**
 * 429 — Rate limit exceeded.
 * Arch doc error code: RATE_LIMITED
 */
export class RateLimitedError extends ApiError {
  constructor(retryAfterSeconds?: number) {
    super('RATE_LIMITED', 'Too many requests. Please try again later.', 429, {
      ...(retryAfterSeconds && { retry_after_seconds: retryAfterSeconds }),
    });
    this.name = 'RateLimitedError';
  }
}

/**
 * 404 — Resource not found.
 * Arch doc error code: NOT_FOUND
 */
export class NotFoundError extends ApiError {
  constructor(resource = 'Resource') {
    super('NOT_FOUND', `${resource} not found.`, 404);
    this.name = 'NotFoundError';
  }
}

/**
 * 422 — Validation error.
 * Arch doc error code: VALIDATION_ERROR
 */
export class ValidationError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 422, details);
    this.name = 'ValidationError';
  }
}
```

---

## 7. Role Guards

### File: `src/lib/auth/require-role.ts`

```typescript
// ============================================================
// NexDrive Academy — Role Requirement Guards
// Reference: System Architecture v1.1 §6.3
// ============================================================

import { getAuthContext } from './context';
import { ForbiddenError } from './errors';
import type { AuthContext, Role } from './types';

/**
 * Require the current user to have one of the specified roles.
 * Returns the full AuthContext if authorised.
 *
 * @param allowedRoles - One or more roles that are permitted
 * @throws AuthRequiredError if not authenticated
 * @throws ForbiddenError if authenticated but wrong role
 *
 * @example
 * // Only instructors and admins can access
 * const ctx = await requireRole('instructor', 'admin');
 *
 * // Any authenticated user
 * const ctx = await requireRole('admin', 'instructor', 'student', 'parent');
 */
export async function requireRole(
  ...allowedRoles: Role[]
): Promise<AuthContext> {
  const ctx = await getAuthContext();

  if (!allowedRoles.includes(ctx.role)) {
    throw new ForbiddenError(
      `This action requires one of the following roles: ${allowedRoles.join(', ')}.`
    );
  }

  return ctx;
}

/**
 * Require the current user to be an admin (platform owner).
 * Convenience wrapper for admin-only routes.
 */
export async function requireAdmin(): Promise<AuthContext> {
  return requireRole('admin');
}

/**
 * Require the current user to be an instructor or admin.
 * Most instructor-facing API routes use this.
 */
export async function requireInstructorOrAdmin(): Promise<AuthContext> {
  return requireRole('instructor', 'admin');
}

/**
 * Require any authenticated user.
 * Used for routes like GET /api/v1/me, notification preferences, etc.
 */
export async function requireAuthenticated(): Promise<AuthContext> {
  return requireRole('admin', 'instructor', 'student', 'parent');
}
```

---

## 8. Ownership Guards

### File: `src/lib/auth/require-ownership.ts`

```typescript
// ============================================================
// NexDrive Academy — Ownership Verification Guards
// Reference: System Architecture v1.1 §3.4, §6.4
// ============================================================

import { ForbiddenError, NotFoundError } from './errors';
import type { AuthContext } from './types';
import { db } from '@/db';
import { eq, and } from 'drizzle-orm';
import {
  students,
  parentStudentLinks,
} from '@/db/schema';

/**
 * Verify that the current instructor owns the specified student.
 * Admin bypasses this check.
 *
 * @param ctx - Current auth context
 * @param studentId - UUID of the student being accessed
 * @throws ForbiddenError if instructor doesn't own this student
 */
export async function requireStudentOwnership(
  ctx: AuthContext,
  studentId: string
): Promise<void> {
  // Admin sees all
  if (ctx.role === 'admin') return;

  if (ctx.role === 'instructor') {
    if (!ctx.instructorId) {
      throw new ForbiddenError('Instructor profile not configured.');
    }
    const student = await db
      .select({ id: students.id })
      .from(students)
      .where(
        and(eq(students.id, studentId), eq(students.instructorId, ctx.instructorId))
      )
      .limit(1);

    if (student.length === 0) {
      throw new ForbiddenError('You can only access your own students.');
    }
    return;
  }

  // Students can only access their own record
  if (ctx.role === 'student') {
    if (ctx.studentId !== studentId) {
      throw new ForbiddenError('You can only access your own data.');
    }
    return;
  }

  // Parents need an active link with the right permission
  if (ctx.role === 'parent') {
    // Parent ownership is handled by requireParentLink()
    // This function is for instructor/student ownership specifically
    throw new ForbiddenError();
  }

  throw new ForbiddenError();
}

/**
 * Verify that the current user is the student themselves.
 * Admin bypasses. Instructor does NOT pass (use requireStudentOwnership for instructors).
 *
 * @param ctx - Current auth context
 * @param studentId - UUID to check against
 */
export function requireSelfStudent(
  ctx: AuthContext,
  studentId: string
): void {
  if (ctx.role === 'admin') return;

  if (ctx.role === 'student' && ctx.studentId === studentId) return;

  throw new ForbiddenError('You can only access your own data.');
}

/**
 * Parent link permission columns from parent_student_links table.
 * Maps to the boolean columns that control what parents can see.
 */
export type ParentPermission =
  | 'can_view_progress'
  | 'can_view_bookings'
  | 'can_view_payments'
  | 'can_view_lesson_notes'
  | 'can_view_bridge_forms'
  | 'can_book_lessons';

/**
 * Verify that the current parent has an active link to the student
 * and the required permission is enabled.
 *
 * Privacy is controlled by the STUDENT, not the parent.
 *
 * @param ctx - Current auth context (must be parent role)
 * @param studentId - UUID of the student
 * @param permission - Which permission column to check
 * @throws ForbiddenError if no active link or permission denied
 */
export async function requireParentLink(
  ctx: AuthContext,
  studentId: string,
  permission: ParentPermission
): Promise<void> {
  // Admin sees all
  if (ctx.role === 'admin') return;

  if (ctx.role !== 'parent' || !ctx.parentId) {
    throw new ForbiddenError();
  }

  const links = await db
    .select()
    .from(parentStudentLinks)
    .where(
      and(
        eq(parentStudentLinks.parentId, ctx.parentId),
        eq(parentStudentLinks.studentId, studentId),
        eq(parentStudentLinks.status, 'active')
      )
    )
    .limit(1);

  if (links.length === 0) {
    throw new ForbiddenError(
      'No active link to this student. Ask the student to grant access.'
    );
  }

  const link = links[0];

  // Check the specific permission column
  const permissionGranted = link[permission];
  if (!permissionGranted) {
    throw new ForbiddenError(
      'The student has not granted you this permission.'
    );
  }
}

/**
 * Verify the current user owns the specified profile.
 * Every user can only edit their own profile.
 * Admin can edit any profile.
 *
 * @param ctx - Current auth context
 * @param profileId - UUID of the profile being accessed
 */
export function requireProfileOwnership(
  ctx: AuthContext,
  profileId: string
): void {
  if (ctx.role === 'admin') return;
  if (ctx.profileId === profileId) return;
  throw new ForbiddenError('You can only access your own profile.');
}

/**
 * Verify instructor owns the specified booking.
 * Admin bypasses. Student checks own booking.
 *
 * @param ctx - Current auth context
 * @param booking - Booking record with instructor_id and student_id fields
 */
export function requireBookingAccess(
  ctx: AuthContext,
  booking: { instructorId: string; studentId: string }
): void {
  if (ctx.role === 'admin') return;

  if (ctx.role === 'instructor') {
    if (ctx.instructorId === booking.instructorId) return;
    throw new ForbiddenError('You can only access your own bookings.');
  }

  if (ctx.role === 'student') {
    if (ctx.studentId === booking.studentId) return;
    throw new ForbiddenError('You can only access your own bookings.');
  }

  // Parent access to bookings handled separately via requireParentLink
  throw new ForbiddenError();
}
```

---

## 9. Query Scoping Functions

### File: `src/lib/auth/scope-queries.ts`

```typescript
// ============================================================
// NexDrive Academy — Query Scoping by Role
// Reference: System Architecture v1.1 §3.4, §6.4
//
// These functions add WHERE clauses to Drizzle queries based
// on the current user's role. Every tenant-scoped query MUST
// use one of these.
// ============================================================

import { eq, and, SQL, sql } from 'drizzle-orm';
import { ForbiddenError } from './errors';
import type { AuthContext } from './types';

/**
 * Scope a query by instructor_id.
 * Admin sees all. Instructor sees own records only.
 *
 * Usage: Apply to any table with an instructor_id column.
 *
 * @param ctx - Auth context
 * @param instructorIdColumn - The Drizzle column reference for instructor_id
 * @returns SQL condition to add to WHERE clause, or undefined (admin = no filter)
 *
 * @example
 * const condition = scopeByInstructor(ctx, lessons.instructorId);
 * const results = await db.select().from(lessons)
 *   .where(condition ? and(condition, otherConditions) : otherConditions);
 */
export function scopeByInstructor(
  ctx: AuthContext,
  instructorIdColumn: any // PgColumn type from Drizzle
): SQL | undefined {
  if (ctx.role === 'admin') {
    return undefined; // No filter — admin sees all
  }

  if (ctx.role === 'instructor') {
    if (!ctx.instructorId) {
      throw new ForbiddenError('Instructor profile not configured.');
    }
    return eq(instructorIdColumn, ctx.instructorId);
  }

  // Student and parent roles should not call this directly —
  // they use scopeByStudent or scopeByParentLink
  throw new ForbiddenError();
}

/**
 * Scope a query by student_id.
 * Admin sees all. Student sees own records only.
 *
 * @param ctx - Auth context
 * @param studentIdColumn - The Drizzle column reference for student_id
 * @returns SQL condition or undefined
 *
 * @example
 * const condition = scopeByStudent(ctx, bookings.studentId);
 */
export function scopeByStudent(
  ctx: AuthContext,
  studentIdColumn: any
): SQL | undefined {
  if (ctx.role === 'admin') {
    return undefined;
  }

  if (ctx.role === 'student') {
    if (!ctx.studentId) {
      throw new ForbiddenError('Student profile not configured.');
    }
    return eq(studentIdColumn, ctx.studentId);
  }

  // Instructor should use scopeByInstructor
  // Parent should use scopeByParentLink
  throw new ForbiddenError();
}

/**
 * Build a combined scope condition for tables that have both
 * instructor_id and student_id (e.g., lessons, student_competencies).
 *
 * - Admin: no filter
 * - Instructor: WHERE instructor_id = ctx.instructorId
 * - Student: WHERE student_id = ctx.studentId
 * - Parent: NOT handled here — use requireParentLink + scopeByStudent
 *
 * @param ctx - Auth context
 * @param instructorIdColumn - instructor_id column
 * @param studentIdColumn - student_id column
 */
export function scopeByRole(
  ctx: AuthContext,
  instructorIdColumn: any,
  studentIdColumn: any
): SQL | undefined {
  if (ctx.role === 'admin') return undefined;

  if (ctx.role === 'instructor') {
    if (!ctx.instructorId) throw new ForbiddenError('Instructor profile not configured.');
    return eq(instructorIdColumn, ctx.instructorId);
  }

  if (ctx.role === 'student') {
    if (!ctx.studentId) throw new ForbiddenError('Student profile not configured.');
    return eq(studentIdColumn, ctx.studentId);
  }

  // Parent must go through requireParentLink first
  throw new ForbiddenError();
}

/**
 * For parent access: returns student_id filter AFTER parent link
 * has been verified (call requireParentLink first!).
 *
 * This function does NOT verify the link — it just builds the
 * WHERE clause. Always call requireParentLink() before this.
 *
 * @param studentId - The verified student_id from the parent link
 * @param studentIdColumn - Drizzle column reference
 */
export function scopeByVerifiedParentLink(
  studentId: string,
  studentIdColumn: any
): SQL {
  return eq(studentIdColumn, studentId);
}
```

---

## 10. Access Control Matrix

### File: `src/lib/auth/access-control.ts`

This is the canonical implementation of the access matrix from System Architecture v1.1 §3.4.

```typescript
// ============================================================
// NexDrive Academy — Access Control Matrix
// Reference: System Architecture v1.1 §3.4
//
// CANONICAL MATRIX — all table-level access decisions live here.
// If it's not in this matrix, the role can't access it.
// ============================================================

import type { Role, ProtectedTable, AccessLevel } from './types';

/**
 * Access control matrix — exact replica of arch doc §3.4 table.
 *
 * Access levels:
 *   'all'    — Full CRUD, no scoping
 *   'own'    — CRUD scoped to own records (instructor_id, student_id, or profile_id match)
 *   'scoped' — Read-only, scoped via parent_student_links permissions
 *   'read'   — Read-only (e.g., student can read assigned instructor's public info)
 *   'none'   — No access whatsoever. Service layer must throw ForbiddenError.
 */
export const ACCESS_MATRIX: Record<ProtectedTable, Record<Role, AccessLevel>> = {
  // ─── User Management ───────────────────────────────
  profiles: {
    admin: 'all',
    instructor: 'own',      // Own profile only
    student: 'own',          // Own profile only
    parent: 'own',           // Own profile only
  },
  instructors: {
    admin: 'all',
    instructor: 'own',      // Own instructor record only
    student: 'read',         // Read assigned instructor's public info
    parent: 'none',
  },
  students: {
    admin: 'all',
    instructor: 'own',      // Own students (WHERE instructor_id = ?)
    student: 'own',          // Own record only
    parent: 'scoped',        // Linked students (if permitted)
  },
  parent_student_links: {
    admin: 'all',
    instructor: 'read',     // Can see links for own students
    student: 'own',          // Can manage own links (grant/revoke permissions)
    parent: 'own',           // Can see own links (read-only — student controls permissions)
  },

  // ─── Booking & Lessons ─────────────────────────────
  bookings: {
    admin: 'all',
    instructor: 'own',      // Own bookings (WHERE instructor_id = ?)
    student: 'own',          // Own bookings (WHERE student_id = ?)
    parent: 'scoped',        // Linked student's bookings (if can_view_bookings)
  },
  lessons: {
    admin: 'all',
    instructor: 'own',      // Own lessons (WHERE instructor_id = ?)
    student: 'own',          // Own lessons (WHERE student_id = ?)
    parent: 'scoped',        // Linked student's lessons (if can_view_lesson_notes)
  },

  // ─── CBT&A Compliance ─────────────────────────────
  competency_tasks: {
    admin: 'all',
    instructor: 'read',     // Read-only (reference data)
    student: 'read',         // Read-only
    parent: 'read',          // Read-only
  },
  student_competencies: {
    admin: 'all',
    instructor: 'own',      // Own students' competencies
    student: 'own',          // Own competencies only
    parent: 'scoped',        // Linked student (if can_view_progress)
  },

  // ─── Signatures & Audit ────────────────────────────
  signatures: {
    admin: 'all',
    instructor: 'own',      // Own signatures + own students' signatures
    student: 'own',          // Own signatures only
    parent: 'none',
  },
  audit_log: {
    admin: 'read',           // Read-only even for admin (append-only table)
    instructor: 'none',
    student: 'none',
    parent: 'none',
  },

  // ─── Private Notes — CRITICAL ──────────────────────
  private_notes: {
    admin: 'all',
    instructor: 'own',      // **Own notes ONLY** (WHERE instructor_id = ?)
    student: 'none',         // ██ NEVER ██ — Defence in depth
    parent: 'none',          // ██ NEVER ██ — Defence in depth
  },

  // ─── Payments ──────────────────────────────────────
  payments: {
    admin: 'all',
    instructor: 'none',     // Instructors don't manage payments
    student: 'own',          // Own payments only
    parent: 'scoped',        // Linked student's receipts (if can_view_payments)
  },
  packages: {
    admin: 'all',
    instructor: 'read',
    student: 'read',
    parent: 'read',
  },
  student_packages: {
    admin: 'all',
    instructor: 'none',
    student: 'own',
    parent: 'scoped',
  },
  vouchers: {
    admin: 'all',
    instructor: 'none',
    student: 'none',         // Validation endpoint is public (no read of voucher list)
    parent: 'none',
  },

  // ─── Communication ─────────────────────────────────
  conversations: {
    admin: 'all',
    instructor: 'none',
    student: 'own',          // Own conversations only
    parent: 'none',
  },
  call_logs: {
    admin: 'all',
    instructor: 'none',
    student: 'none',
    parent: 'none',
  },

  // ─── Instructor Tools ──────────────────────────────
  lesson_bridge_forms: {
    admin: 'all',
    instructor: 'own',      // Own students' bridge forms
    student: 'own',          // Own bridge forms (if is_visible_to_student)
    parent: 'scoped',        // Linked student (if can_view_bridge_forms)
  },
  self_assessments: {
    admin: 'all',
    instructor: 'read',     // Read own students' assessments
    student: 'own',          // Own assessments
    parent: 'none',
  },

  // ─── Services & Availability ───────────────────────
  services: {
    admin: 'all',
    instructor: 'read',
    student: 'read',
    parent: 'read',
  },
  availability_rules: {
    admin: 'all',
    instructor: 'own',      // Own rules only
    student: 'none',
    parent: 'none',
  },
  availability_overrides: {
    admin: 'all',
    instructor: 'own',      // Own overrides only
    student: 'none',
    parent: 'none',
  },

  // ─── CRM ───────────────────────────────────────────
  contacts: {
    admin: 'all',
    instructor: 'own',      // Own contacts (WHERE instructor_id = ?)
    student: 'none',
    parent: 'none',
  },

  // ─── Notifications ─────────────────────────────────
  notifications: {
    admin: 'all',
    instructor: 'own',      // Own notifications
    student: 'own',          // Own notifications
    parent: 'own',           // Own notifications
  },
};

/**
 * Check if a role has access to a table at a given level.
 *
 * @example
 * if (!hasAccess('student', 'private_notes')) {
 *   throw new ForbiddenError();
 * }
 */
export function hasAccess(
  role: Role,
  table: ProtectedTable
): boolean {
  return ACCESS_MATRIX[table][role] !== 'none';
}

/**
 * Get the access level for a role on a table.
 */
export function getAccessLevel(
  role: Role,
  table: ProtectedTable
): AccessLevel {
  return ACCESS_MATRIX[table][role];
}

/**
 * Assert access is not 'none'. Throws ForbiddenError if it is.
 */
export function assertAccess(
  role: Role,
  table: ProtectedTable
): AccessLevel {
  const level = ACCESS_MATRIX[table][role];
  if (level === 'none') {
    throw new ForbiddenError(`Access denied: ${role} cannot access ${table}.`);
  }
  return level;
}
```

---

## 11. Private Notes — Defence in Depth

### File: `src/lib/auth/private-notes-guard.ts`

This is the most security-critical module. Private notes are NEVER visible to students or parents, enforced at multiple layers.

```typescript
// ============================================================
// NexDrive Academy — Private Notes Defence in Depth
// Reference: System Architecture v1.1 §3.4, §6.4
//
// ██████████████████████████████████████████████████████████
// ██ CRITICAL: Private notes are NEVER visible to         ██
// ██ students or parents. This is enforced at:            ██
// ██   Layer 1: Access matrix (access-control.ts)         ██
// ██   Layer 2: This guard (role check before ANY query)  ██
// ██   Layer 3: Response shape exclusion (stripPrivateData)██
// ██   Layer 4: No API route exists for student/parent    ██
// ██████████████████████████████████████████████████████████
// ============================================================

import { ForbiddenError } from './errors';
import type { AuthContext } from './types';
import { db } from '@/db';
import { eq, and } from 'drizzle-orm';
import { privateNotes } from '@/db/schema';

/**
 * LAYER 2: Guard function — must be called before ANY private_notes query.
 * Only admin and instructor roles may proceed. All others get ForbiddenError.
 *
 * @param ctx - Auth context
 * @throws ForbiddenError for student, parent, or any non-admin/instructor role
 */
export function assertCanAccessPrivateNotes(ctx: AuthContext): void {
  if (ctx.role !== 'admin' && ctx.role !== 'instructor') {
    // Log this attempt — it should never happen in normal operation.
    // If it does, it indicates a bug in the calling code.
    console.error(
      `[SECURITY] Private notes access attempt by ${ctx.role} (clerk_user_id: ${ctx.clerkUserId})`
    );
    throw new ForbiddenError('Private notes are instructor-only.');
  }
}

/**
 * Get private notes for a student — with full RBAC enforcement.
 *
 * - Admin: sees all notes for the student
 * - Instructor: sees ONLY their own notes for the student
 * - Student/Parent: ALWAYS throws ForbiddenError
 *
 * @param ctx - Auth context
 * @param studentId - Target student UUID
 */
export async function getPrivateNotes(
  ctx: AuthContext,
  studentId: string
) {
  // Layer 2: Role gate
  assertCanAccessPrivateNotes(ctx);

  // Admin sees all notes for the student
  if (ctx.role === 'admin') {
    return db
      .select()
      .from(privateNotes)
      .where(eq(privateNotes.studentId, studentId))
      .orderBy(privateNotes.createdAt);
  }

  // Instructor sees only their own notes
  if (ctx.role === 'instructor' && ctx.instructorId) {
    return db
      .select()
      .from(privateNotes)
      .where(
        and(
          eq(privateNotes.studentId, studentId),
          eq(privateNotes.instructorId, ctx.instructorId)
        )
      )
      .orderBy(privateNotes.createdAt);
  }

  // Should never reach here due to assertCanAccessPrivateNotes
  throw new ForbiddenError();
}

/**
 * Create a private note — instructor only.
 *
 * @param ctx - Auth context (must be instructor or admin)
 * @param data - Note content
 */
export async function createPrivateNote(
  ctx: AuthContext,
  data: {
    studentId: string;
    lessonId?: string;
    note: string;
    noteType?: 'general' | 'lesson_specific' | 'safety_concern' | 'coaching_strategy' | 'personal_interest';
  }
) {
  assertCanAccessPrivateNotes(ctx);

  if (ctx.role !== 'instructor' && ctx.role !== 'admin') {
    throw new ForbiddenError();
  }

  const instructorId = ctx.role === 'admin'
    ? ctx.instructorId // Admin might also be an instructor
    : ctx.instructorId;

  if (!instructorId) {
    throw new ForbiddenError('No instructor profile linked. Cannot create private notes.');
  }

  return db.insert(privateNotes).values({
    instructorId,
    studentId: data.studentId,
    lessonId: data.lessonId ?? null,
    note: data.note,
    noteType: data.noteType ?? 'general',
  }).returning();
}

/**
 * LAYER 3: Strip private data from any response object before sending
 * to student or parent roles.
 *
 * Call this on ANY response that might accidentally include
 * private_notes data (e.g., a lesson detail with joined notes).
 *
 * This is a safety net — the query should never include private_notes
 * for these roles, but this ensures it even if a developer makes a mistake.
 *
 * @param data - Any data object or array
 * @param ctx - Auth context
 * @returns Data with private_notes fields removed for student/parent
 */
export function stripPrivateData<T>(data: T, ctx: AuthContext): T {
  // Admin and instructor get full data
  if (ctx.role === 'admin' || ctx.role === 'instructor') {
    return data;
  }

  // Student and parent: recursively remove private_notes
  return deepStripFields(data, [
    'private_notes',
    'privateNotes',
    'private_note',
    'privateNote',
    'instructor_notes',    // Extra safety — catch any naming variations
    'instructorNotes',
    'coaching_notes',
    'coachingNotes',
    'safety_concerns',     // Safety concern notes are also instructor-only
    'safetyConcerns',
  ]);
}

/**
 * Recursively strip specified fields from an object or array.
 */
function deepStripFields<T>(obj: T, fields: string[]): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => deepStripFields(item, fields)) as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (fields.includes(key)) {
      continue; // Strip this field entirely
    }
    result[key] = typeof value === 'object' ? deepStripFields(value, fields) : value;
  }
  return result as T;
}
```

---

## 12. Clerk Webhook Handler

### File: `src/app/api/v1/webhooks/clerk/route.ts`

```typescript
// ============================================================
// NexDrive Academy — Clerk Webhook Handler
// POST /api/v1/webhooks/clerk
//
// Reference: System Architecture v1.1 §6.3.1
//
// Receives Clerk events and syncs user data to our database.
// This is how Clerk user records become profiles/instructors/
// students/parents in our Neon database.
// ============================================================

import { headers } from 'next/headers';
import { Webhook } from 'svix';
import { db } from '@/db';
import { profiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { ClerkUserEventData, ClerkWebhookEvent } from '@/lib/auth/types';

// This route must NOT be behind Clerk auth — it's called BY Clerk.
// Rate limiting is handled by Clerk's retry policy.

export async function POST(req: Request) {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!WEBHOOK_SECRET) {
    console.error('[WEBHOOK] CLERK_WEBHOOK_SECRET not configured');
    return new Response('Webhook secret not configured', { status: 500 });
  }

  // ─── 1. Verify Svix Signature ──────────────────────
  const headerPayload = await headers();
  const svixId = headerPayload.get('svix-id');
  const svixTimestamp = headerPayload.get('svix-timestamp');
  const svixSignature = headerPayload.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    console.error('[WEBHOOK] Missing svix headers');
    return new Response('Missing webhook signature headers', { status: 400 });
  }

  const payload = await req.text();
  const wh = new Webhook(WEBHOOK_SECRET);

  let event: ClerkWebhookEvent;
  try {
    event = wh.verify(payload, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ClerkWebhookEvent;
  } catch (err) {
    console.error('[WEBHOOK] Signature verification failed:', err);
    return new Response('Invalid webhook signature', { status: 401 });
  }

  // ─── 2. Route Event to Handler ─────────────────────
  try {
    switch (event.type) {
      case 'user.created':
        await handleUserCreated(event.data);
        break;

      case 'user.updated':
        await handleUserUpdated(event.data);
        break;

      case 'user.deleted':
        await handleUserDeleted(event.data);
        break;

      default:
        // Log but don't fail for unknown event types
        console.log(`[WEBHOOK] Unhandled event type: ${event.type}`);
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error(`[WEBHOOK] Error handling ${event.type}:`, err);
    // Return 500 so Clerk retries
    return new Response('Internal error processing webhook', { status: 500 });
  }
}

// ─── Event Handlers ────────────────────────────────────

/**
 * Handle user.created — create a profile row in our database.
 *
 * At this point, the user has just signed up via Clerk. They don't
 * have a role yet. The role is assigned later by:
 *   a) Admin manually assigning via admin panel
 *   b) Self-service signup flow that calls our enrollment API
 *   c) Parent invitation flow
 *
 * We create the profile with a default role — it must be set
 * properly before the user can access anything meaningful.
 *
 * NOTE: For initial launch, Rob (admin) will set roles manually.
 * For student self-enrollment, the booking flow will assign the role.
 */
async function handleUserCreated(data: ClerkUserEventData): Promise<void> {
  const primaryEmail = data.email_addresses.find(
    (e) => e.id === data.primary_email_address_id
  );

  const primaryPhone = data.phone_numbers.find(
    (p) => p.id === data.primary_phone_number_id
  );

  // Determine initial role from publicMetadata (if set during sign-up)
  const role = (data.public_metadata?.role as string) || 'student'; // default to student

  // Check for existing profile (idempotent — handle duplicate webhooks)
  const existing = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.userId, data.id))
    .limit(1);

  if (existing.length > 0) {
    console.log(`[WEBHOOK] Profile already exists for ${data.id}, skipping create`);
    return;
  }

  await db.insert(profiles).values({
    userId: data.id,
    firstName: data.first_name ?? '',
    lastName: data.last_name ?? '',
    email: primaryEmail?.email_address ?? '',
    phone: primaryPhone?.phone_number ?? null,
    role: role as 'admin' | 'instructor' | 'student' | 'parent',
    avatarUrl: data.image_url ?? null,
    status: 'active',
  });

  console.log(`[WEBHOOK] Created profile for ${data.id} with role: ${role}`);

  // TODO: Emit PROFILE_CREATED event for CRM contact auto-creation
}

/**
 * Handle user.updated — sync profile data from Clerk.
 *
 * Only syncs fields that Clerk owns (name, email, phone, avatar).
 * Does NOT touch business-specific fields in our profiles table.
 */
async function handleUserUpdated(data: ClerkUserEventData): Promise<void> {
  const primaryEmail = data.email_addresses.find(
    (e) => e.id === data.primary_email_address_id
  );

  const primaryPhone = data.phone_numbers.find(
    (p) => p.id === data.primary_phone_number_id
  );

  const result = await db
    .update(profiles)
    .set({
      firstName: data.first_name ?? undefined,
      lastName: data.last_name ?? undefined,
      email: primaryEmail?.email_address ?? undefined,
      phone: primaryPhone?.phone_number ?? undefined,
      avatarUrl: data.image_url ?? undefined,
      // updatedAt is set automatically by trigger
    })
    .where(eq(profiles.userId, data.id));

  console.log(`[WEBHOOK] Updated profile for ${data.id}`);
}

/**
 * Handle user.deleted — soft delete the profile.
 *
 * We NEVER hard delete because:
 *   - Compliance records (lessons, competencies) must be retained
 *   - Audit trail must remain intact
 *   - The profile is just marked inactive
 */
async function handleUserDeleted(data: ClerkUserEventData): Promise<void> {
  await db
    .update(profiles)
    .set({
      status: 'inactive',
      deletedAt: new Date(),
    })
    .where(eq(profiles.userId, data.id));

  console.log(`[WEBHOOK] Soft-deleted profile for ${data.id}`);
}
```

---

## 13. Webhook Handler Utilities

### File: `src/lib/webhooks/clerk.ts`

```typescript
// ============================================================
// NexDrive Academy — Clerk Webhook Utilities
// Helper functions for role assignment and profile setup
// that can be called from admin endpoints or enrollment flows.
// ============================================================

import { clerkClient } from '@clerk/nextjs/server';
import { db } from '@/db';
import { profiles, instructors, students, parents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { Role } from '@/lib/auth/types';

/**
 * Assign a role to a user and set up their role-specific table row.
 * Also updates Clerk publicMetadata so session claims are correct.
 *
 * This is called when:
 *   - Admin assigns a role via admin panel
 *   - Student self-enrolls via booking flow
 *   - Parent accepts an invitation
 *
 * @param clerkUserId - The Clerk user ID
 * @param role - Role to assign
 * @param data - Role-specific data (instructor ADI, student instructor assignment, etc.)
 */
export async function assignRole(
  clerkUserId: string,
  role: Role,
  data?: {
    // Instructor fields
    adiNumber?: string;
    adiExpiry?: string;
    isOwner?: boolean;
    // Student fields
    instructorId?: string;
    transmission?: 'manual' | 'auto';
    // Parent fields (minimal)
  }
): Promise<{ profileId: string; roleRecordId: string }> {
  // 1. Get or create profile
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, clerkUserId))
    .limit(1);

  if (!profile) {
    throw new Error(`Profile not found for clerk user: ${clerkUserId}`);
  }

  // 2. Update profile role
  await db
    .update(profiles)
    .set({ role })
    .where(eq(profiles.id, profile.id));

  // 3. Create role-specific record
  let roleRecordId: string;

  switch (role) {
    case 'admin':
    case 'instructor': {
      const [instructor] = await db
        .insert(instructors)
        .values({
          userId: clerkUserId,
          profileId: profile.id,
          adiNumber: data?.adiNumber ?? '',
          adiExpiry: data?.adiExpiry ? new Date(data.adiExpiry) : new Date(),
          isOwner: data?.isOwner ?? false,
          status: 'active',
        })
        .onConflictDoNothing({ target: instructors.userId })
        .returning();
      roleRecordId = instructor?.id ?? '';

      // If admin, also create instructor record (Rob is both)
      break;
    }

    case 'student': {
      if (!data?.instructorId) {
        throw new Error('Student must have an assigned instructor_id');
      }
      const [student] = await db
        .insert(students)
        .values({
          userId: clerkUserId,
          profileId: profile.id,
          instructorId: data.instructorId,
          transmission: data?.transmission ?? 'auto',
          status: 'active',
        })
        .onConflictDoNothing({ target: students.userId })
        .returning();
      roleRecordId = student?.id ?? '';
      break;
    }

    case 'parent': {
      const [parent] = await db
        .insert(parents)
        .values({
          userId: clerkUserId,
          profileId: profile.id,
        })
        .onConflictDoNothing({ target: parents.userId })
        .returning();
      roleRecordId = parent?.id ?? '';
      break;
    }

    default:
      throw new Error(`Unknown role: ${role}`);
  }

  // 4. Update Clerk publicMetadata with role + IDs
  // This populates the custom session claims on next token refresh
  const clerk = await clerkClient();
  const metadata: Record<string, unknown> = {
    role,
    profile_id: profile.id,
  };

  if (role === 'instructor' || role === 'admin') {
    metadata.instructor_id = roleRecordId;
    metadata.is_owner = data?.isOwner ?? false;
  }
  if (role === 'student') {
    metadata.student_id = roleRecordId;
  }
  if (role === 'parent') {
    metadata.parent_id = roleRecordId;
  }

  await clerk.users.updateUserMetadata(clerkUserId, {
    publicMetadata: metadata,
  });

  return { profileId: profile.id, roleRecordId };
}
```

---

## 14. Next.js Middleware

### File: `src/middleware.ts`

```typescript
// ============================================================
// NexDrive Academy — Next.js Middleware
// Reference: System Architecture v1.1 §4.2 (Route Map)
//
// Clerk middleware protects all routes. Public routes are
// explicitly whitelisted. Everything else requires auth.
// ============================================================

import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

/**
 * Public routes that do NOT require authentication.
 * Derived from arch doc §4.2 — all routes marked 🌍 (Public).
 */
const isPublicRoute = createRouteMatcher([
  // ─── Auth routes (Clerk handles these) ─────────────
  '/sign-in(.*)',
  '/sign-up(.*)',

  // ─── Public website pages ──────────────────────────
  '/',
  '/about(.*)',
  '/services(.*)',
  '/pricing(.*)',
  '/contact(.*)',
  '/faq(.*)',
  '/blog(.*)',
  '/competency-hub(.*)',
  '/testimonials(.*)',
  '/privacy-policy',
  '/terms',

  // ─── Public API routes (🌍) ────────────────────────
  // Booking widget (public-facing)
  '/api/v1/booking/availability',
  '/api/v1/booking/services',
  '/api/v1/booking/reserve',
  '/api/v1/booking/confirm',

  // Payment webhook (verified by gateway signature, not Clerk)
  '/api/v1/payments/webhook',

  // Voucher validation (public)
  '/api/v1/vouchers/validate',

  // AI chat (anonymous allowed)
  '/api/v1/chat/message',

  // Twilio SMS webhooks (verified by Twilio signature)
  '/api/v1/sms/inbound',
  '/api/v1/sms/status',

  // Voice agent webhooks (verified by voice provider)
  '/api/v1/voice/inbound',
  '/api/v1/voice/event',
  '/api/v1/voice/function-call',

  // Clerk webhook (verified by Svix signature)
  '/api/v1/webhooks/clerk',

  // Content API (public pages)
  '/api/v1/content(.*)',

  // Health check
  '/api/health',
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
```

---

## 15. Constants

### File: `src/lib/auth/constants.ts`

```typescript
// ============================================================
// NexDrive Academy — Auth Constants
// ============================================================

import type { Role } from './types';

/**
 * All valid roles.
 */
export const ALL_ROLES: readonly Role[] = [
  'admin',
  'instructor',
  'student',
  'parent',
] as const;

/**
 * Roles that can access instructor-facing features.
 */
export const INSTRUCTOR_ROLES: readonly Role[] = ['admin', 'instructor'] as const;

/**
 * Roles that can NEVER see private notes.
 * Used in defensive checks.
 */
export const PRIVATE_NOTES_DENIED_ROLES: readonly Role[] = [
  'student',
  'parent',
] as const;

/**
 * Session timeout configuration per NFR-3.
 *
 * Clerk handles session lifecycle. These values are set in:
 * Clerk Dashboard → Sessions → Session lifetime.
 *
 * Clerk doesn't support per-role timeouts natively.
 * Implementation approach:
 *   - Set Clerk session max lifetime to 8 hours (instructor max)
 *   - Set Clerk inactivity timeout to 30 minutes (student/parent default)
 *   - For instructors: use a custom "keep-alive" that the instructor
 *     workstation sends during active lesson days (extends the 30-min
 *     inactivity timeout up to 8 hours max)
 *
 * Alternative: use Clerk's afterAuth hook to check role and
 * force re-auth for student/parent after 30 min of inactivity.
 */
export const SESSION_CONFIG = {
  /** Maximum session lifetime (any role) */
  maxLifetimeHours: 8,

  /** Inactivity timeout for student/parent roles */
  studentParentInactivityMinutes: 30,

  /** Inactivity timeout for instructor role (during active lesson day) */
  instructorInactivityMinutes: 480, // 8 hours

  /** Keep-alive interval for instructor workstation */
  instructorKeepAliveMinutes: 5,
} as const;

/**
 * CORS allowed origins.
 * Reference: System Architecture v1.1 §6.6
 */
export const CORS_ORIGINS = [
  'https://nexdriveacademy.com.au',
  'https://www.nexdriveacademy.com.au',
  ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000'] : []),
] as const;
```

---

## 16. Rate Limiting

### File: `src/lib/rate-limit/config.ts`

```typescript
// ============================================================
// NexDrive Academy — Rate Limit Configuration
// Reference: System Architecture v1.1 §4.1, §6.6; PRD NFR-3
//
// Tiers:
//   Unauthenticated: 100 req/min
//   Authenticated:   300 req/min
//   Mutations:       10 req/min
// ============================================================

export const RATE_LIMIT_CONFIG = {
  /** Anonymous/unauthenticated requests */
  unauthenticated: {
    tokens: 100,
    window: '1m' as const,
    prefix: 'rl:unauth',
  },

  /** Authenticated requests (any role) */
  authenticated: {
    tokens: 300,
    window: '1m' as const,
    prefix: 'rl:auth',
  },

  /** Write/mutation requests (POST, PUT, PATCH, DELETE) */
  mutations: {
    tokens: 10,
    window: '1m' as const,
    prefix: 'rl:mutate',
  },

  /** Webhook endpoints (higher limit, per-provider) */
  webhooks: {
    tokens: 200,
    window: '1m' as const,
    prefix: 'rl:webhook',
  },
} as const;
```

### File: `src/lib/rate-limit/index.ts`

```typescript
// ============================================================
// NexDrive Academy — Rate Limiter (Upstash Redis)
// Reference: System Architecture v1.1 §6.6
// ============================================================

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { RATE_LIMIT_CONFIG } from './config';
import { RateLimitedError } from '@/lib/auth/errors';

// Lazy-initialise Redis client (supports serverless cold starts)
let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redis;
}

/**
 * Rate limiter instances (cached per cold start).
 */
const limiters = new Map<string, Ratelimit>();

function getLimiter(
  tier: keyof typeof RATE_LIMIT_CONFIG
): Ratelimit {
  if (!limiters.has(tier)) {
    const config = RATE_LIMIT_CONFIG[tier];
    limiters.set(
      tier,
      new Ratelimit({
        redis: getRedis(),
        limiter: Ratelimit.slidingWindow(config.tokens, config.window),
        prefix: config.prefix,
        analytics: true, // Enable Upstash analytics dashboard
      })
    );
  }
  return limiters.get(tier)!;
}

/**
 * Check rate limit for a request.
 *
 * @param identifier - Unique key (IP address for unauth, clerk_user_id for auth)
 * @param tier - Which rate limit tier to apply
 * @throws RateLimitedError if limit exceeded
 *
 * @example
 * // In API route:
 * const ip = req.headers.get('x-forwarded-for') ?? 'unknown';
 * await checkRateLimit(ip, 'unauthenticated');
 *
 * // For authenticated mutations:
 * await checkRateLimit(ctx.clerkUserId, 'mutations');
 */
export async function checkRateLimit(
  identifier: string,
  tier: keyof typeof RATE_LIMIT_CONFIG
): Promise<void> {
  const limiter = getLimiter(tier);
  const result = await limiter.limit(identifier);

  if (!result.success) {
    const retryAfter = Math.ceil(
      (result.reset - Date.now()) / 1000
    );
    throw new RateLimitedError(retryAfter > 0 ? retryAfter : undefined);
  }
}

/**
 * Get the client IP from a Next.js request.
 * Vercel sets x-forwarded-for. Falls back to x-real-ip.
 */
export function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

/**
 * Determine the rate limit tier for a request.
 *
 * @param method - HTTP method
 * @param isAuthenticated - Whether the user is authenticated
 */
export function getRateLimitTier(
  method: string,
  isAuthenticated: boolean
): keyof typeof RATE_LIMIT_CONFIG {
  // Mutations get the strictest limit
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    return isAuthenticated ? 'mutations' : 'unauthenticated';
  }

  return isAuthenticated ? 'authenticated' : 'unauthenticated';
}
```

---

## 17. API Route Helper

This wrapper combines auth context extraction, rate limiting, and error handling into a clean pattern for every API route.

### File: `src/lib/auth/api-handler.ts`

```typescript
// ============================================================
// NexDrive Academy — API Route Handler Wrapper
//
// Provides a consistent pattern for all API routes:
//   1. Rate limiting
//   2. Auth context extraction
//   3. Role verification
//   4. Error handling → standard envelope
// ============================================================

import { NextRequest } from 'next/server';
import { getAuthContext, getOptionalAuthContext } from './context';
import { requireRole } from './require-role';
import { ApiError, AuthRequiredError, ForbiddenError } from './errors';
import { checkRateLimit, getClientIp, getRateLimitTier } from '@/lib/rate-limit';
import type { AuthContext, Role } from './types';

interface HandlerOptions {
  /** Roles that can access this route. Omit for public routes. */
  roles?: Role[];
  /** Skip rate limiting (e.g., internal-only routes) */
  skipRateLimit?: boolean;
}

type RouteHandler = (
  req: NextRequest,
  ctx: AuthContext | null
) => Promise<Response>;

/**
 * Wrap an API route handler with standard auth + rate limiting + error handling.
 *
 * @example
 * // Protected route (instructor + admin only)
 * export const GET = apiHandler(
 *   { roles: ['instructor', 'admin'] },
 *   async (req, ctx) => {
 *     // ctx is guaranteed non-null, typed AuthContext
 *     const data = await getStudents(ctx!);
 *     return Response.json({ data });
 *   }
 * );
 *
 * // Public route
 * export const GET = apiHandler(
 *   {},
 *   async (req, ctx) => {
 *     // ctx may be null for unauthenticated users
 *     return Response.json({ data: await getAvailability() });
 *   }
 * );
 */
export function apiHandler(
  options: HandlerOptions,
  handler: RouteHandler
) {
  return async (req: NextRequest): Promise<Response> => {
    try {
      // 1. Rate limiting
      if (!options.skipRateLimit) {
        const ip = getClientIp(req);
        const isAuth = !!options.roles; // Simple heuristic
        const tier = getRateLimitTier(req.method, isAuth);
        await checkRateLimit(
          isAuth ? (await getOptionalAuthContext())?.clerkUserId ?? ip : ip,
          tier
        );
      }

      // 2. Auth
      let ctx: AuthContext | null = null;
      if (options.roles && options.roles.length > 0) {
        ctx = await requireRole(...options.roles);
      } else {
        ctx = await getOptionalAuthContext();
      }

      // 3. Execute handler
      return await handler(req, ctx);
    } catch (err) {
      // 4. Error handling → standard envelope
      if (err instanceof ApiError) {
        return err.toResponse();
      }

      // Unexpected error
      console.error('[API] Unhandled error:', err);
      return Response.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred.',
          },
        },
        { status: 500 }
      );
    }
  };
}
```

---

## 18. Clerk Application Setup Instructions

This section is configuration, not code. Execute in Clerk Dashboard.

### 18.1 Create Clerk Application

1. Go to [clerk.com](https://clerk.com) → Create Application
2. Application name: **NexDrive Academy**
3. Select sign-in methods:
   - Email + Password: **Enabled**
   - Email Magic Link: **Enabled**
   - Phone (SMS OTP): **Enabled** (important for parent/student verification)
   - Passkeys: **Enabled** (progressive enhancement)
   - Google OAuth: **Optional** (consider for convenience)

### 18.2 MFA Configuration

1. Navigate to: **User & Authentication → Multi-factor → Settings**
2. Enable: **TOTP (Authenticator app)**
3. Enable: **SMS code** (backup method)
4. MFA policy: **Optional** (users can enable themselves)
5. For admin/instructor accounts: recommend MFA strongly in onboarding flow

### 18.3 Passkey Support

1. Navigate to: **User & Authentication → Email, Phone, Username → Authentication strategies**
2. Enable: **Passkeys**
3. This gives students/parents biometric login on their phones — excellent UX for repeat logins to the portal

### 18.4 Custom Session Token Template

Navigate to: **Sessions → Edit session token template**

Enter this JSON template:

```json
{
  "role": "{{user.public_metadata.role}}",
  "instructor_id": "{{user.public_metadata.instructor_id}}",
  "student_id": "{{user.public_metadata.student_id}}",
  "parent_id": "{{user.public_metadata.parent_id}}",
  "is_owner": "{{user.public_metadata.is_owner}}",
  "profile_id": "{{user.public_metadata.profile_id}}"
}
```

### 18.5 Session Lifetime

Navigate to: **Sessions → Session management**

Configure:
- **Session maximum lifetime:** 8 hours (covers instructor's full teaching day)
- **Inactivity timeout:** 30 minutes (default for student/parent — per NFR-3)

Note: Clerk doesn't natively support per-role session timeouts. The instructor workstation implements a keep-alive mechanism (ping every 5 minutes during active use) to prevent the 30-minute inactivity timeout from firing during a teaching day. See Session Config in `constants.ts`.

### 18.6 Webhook Configuration

Navigate to: **Webhooks → Add Endpoint**

- **Endpoint URL:** `https://nexdriveacademy.com.au/api/v1/webhooks/clerk`
- **Events to subscribe:**
  - `user.created`
  - `user.updated`
  - `user.deleted`
  - `session.created` (optional — for audit logging)
- **Signing Secret:** Copy to `CLERK_WEBHOOK_SECRET` environment variable

For local development:
1. Install `ngrok` or use Clerk's local dev proxy
2. Set webhook URL to `https://your-ngrok-url/api/v1/webhooks/clerk`

### 18.7 Allowed Origins

Navigate to: **Domains → Web origins**

Add:
- `https://nexdriveacademy.com.au`
- `https://www.nexdriveacademy.com.au`
- `https://staging.nexdriveacademy.com.au`
- `http://localhost:3000` (development)

---

## 19. Barrel Export

### File: `src/lib/auth/index.ts`

```typescript
// ============================================================
// NexDrive Academy — Auth Module Barrel Export
// ============================================================

// Types
export type {
  Role,
  AuthContext,
  ClerkSessionClaims,
  ProtectedTable,
  AccessLevel,
  ParentPermission,
} from './types';
export type { ParentPermission } from './require-ownership';

// Context
export { getAuthContext, getOptionalAuthContext } from './context';

// Role guards
export {
  requireRole,
  requireAdmin,
  requireInstructorOrAdmin,
  requireAuthenticated,
} from './require-role';

// Ownership guards
export {
  requireStudentOwnership,
  requireSelfStudent,
  requireParentLink,
  requireProfileOwnership,
  requireBookingAccess,
} from './require-ownership';

// Query scoping
export {
  scopeByInstructor,
  scopeByStudent,
  scopeByRole,
  scopeByVerifiedParentLink,
} from './scope-queries';

// Access control matrix
export {
  ACCESS_MATRIX,
  hasAccess,
  getAccessLevel,
  assertAccess,
} from './access-control';

// Private notes
export {
  assertCanAccessPrivateNotes,
  getPrivateNotes,
  createPrivateNote,
  stripPrivateData,
} from './private-notes-guard';

// Errors
export {
  ApiError,
  AuthRequiredError,
  ForbiddenError,
  RateLimitedError,
  NotFoundError,
  ValidationError,
} from './errors';

// API handler wrapper
export { apiHandler } from './api-handler';

// Constants
export { ALL_ROLES, INSTRUCTOR_ROLES, SESSION_CONFIG, CORS_ORIGINS } from './constants';
```

---

## 20. Unit Test Specifications

All tests use Vitest. Mock Clerk's `auth()` and the database layer.

### File: `src/__tests__/lib/auth/require-role.test.ts`

```typescript
// ============================================================
// Test: requireRole() — Role-based access guards
// Every role × every route pattern
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Clerk's auth()
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

import { auth } from '@clerk/nextjs/server';
import { requireRole, requireAdmin, requireInstructorOrAdmin } from '@/lib/auth';
import { AuthRequiredError, ForbiddenError } from '@/lib/auth';

const mockAuth = auth as ReturnType<typeof vi.fn>;

function mockSession(role: string, overrides: Record<string, unknown> = {}) {
  mockAuth.mockResolvedValue({
    userId: 'user_test123',
    sessionClaims: {
      role,
      profile_id: 'prof_123',
      instructor_id: role === 'instructor' || role === 'admin' ? 'inst_123' : undefined,
      student_id: role === 'student' ? 'stu_123' : undefined,
      parent_id: role === 'parent' ? 'par_123' : undefined,
      is_owner: role === 'admin',
      ...overrides,
    },
  });
}

describe('requireRole()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Unauthenticated ──────────────────────────
  it('throws AuthRequiredError when no session exists', async () => {
    mockAuth.mockResolvedValue({ userId: null, sessionClaims: null });
    await expect(requireRole('admin')).rejects.toThrow(AuthRequiredError);
  });

  it('throws AuthRequiredError when userId exists but no role claim', async () => {
    mockAuth.mockResolvedValue({
      userId: 'user_test123',
      sessionClaims: {},
    });
    await expect(requireRole('admin')).rejects.toThrow(AuthRequiredError);
  });

  // ─── Admin ────────────────────────────────────
  it('allows admin to access admin-only routes', async () => {
    mockSession('admin');
    const ctx = await requireRole('admin');
    expect(ctx.role).toBe('admin');
    expect(ctx.isOwner).toBe(true);
  });

  it('allows admin to access instructor routes', async () => {
    mockSession('admin');
    const ctx = await requireRole('instructor', 'admin');
    expect(ctx.role).toBe('admin');
  });

  it('allows admin to access any-role routes', async () => {
    mockSession('admin');
    const ctx = await requireRole('admin', 'instructor', 'student', 'parent');
    expect(ctx.role).toBe('admin');
  });

  // ─── Instructor ───────────────────────────────
  it('allows instructor to access instructor routes', async () => {
    mockSession('instructor');
    const ctx = await requireRole('instructor', 'admin');
    expect(ctx.role).toBe('instructor');
    expect(ctx.instructorId).toBe('inst_123');
  });

  it('denies instructor from admin-only routes', async () => {
    mockSession('instructor');
    await expect(requireRole('admin')).rejects.toThrow(ForbiddenError);
  });

  it('denies instructor from student-only routes', async () => {
    mockSession('instructor');
    await expect(requireRole('student')).rejects.toThrow(ForbiddenError);
  });

  // ─── Student ──────────────────────────────────
  it('allows student to access student routes', async () => {
    mockSession('student');
    const ctx = await requireRole('student');
    expect(ctx.role).toBe('student');
    expect(ctx.studentId).toBe('stu_123');
  });

  it('denies student from instructor routes', async () => {
    mockSession('student');
    await expect(requireRole('instructor', 'admin')).rejects.toThrow(ForbiddenError);
  });

  it('denies student from admin routes', async () => {
    mockSession('student');
    await expect(requireRole('admin')).rejects.toThrow(ForbiddenError);
  });

  // ─── Parent ───────────────────────────────────
  it('allows parent to access parent routes', async () => {
    mockSession('parent');
    const ctx = await requireRole('parent');
    expect(ctx.role).toBe('parent');
    expect(ctx.parentId).toBe('par_123');
  });

  it('denies parent from instructor routes', async () => {
    mockSession('parent');
    await expect(requireRole('instructor', 'admin')).rejects.toThrow(ForbiddenError);
  });

  it('denies parent from admin routes', async () => {
    mockSession('parent');
    await expect(requireRole('admin')).rejects.toThrow(ForbiddenError);
  });
});

describe('requireAdmin()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows admin', async () => {
    mockSession('admin');
    const ctx = await requireAdmin();
    expect(ctx.role).toBe('admin');
  });

  it.each(['instructor', 'student', 'parent'])('denies %s', async (role) => {
    mockSession(role);
    await expect(requireAdmin()).rejects.toThrow(ForbiddenError);
  });
});

describe('requireInstructorOrAdmin()', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['instructor', 'admin'])('allows %s', async (role) => {
    mockSession(role);
    const ctx = await requireInstructorOrAdmin();
    expect(['instructor', 'admin']).toContain(ctx.role);
  });

  it.each(['student', 'parent'])('denies %s', async (role) => {
    mockSession(role);
    await expect(requireInstructorOrAdmin()).rejects.toThrow(ForbiddenError);
  });
});
```

### File: `src/__tests__/lib/auth/access-control.test.ts`

```typescript
// ============================================================
// Test: Access Control Matrix
// Exhaustive test of every table × every role
// Validates against System Architecture v1.1 §3.4
// ============================================================

import { describe, it, expect } from 'vitest';
import { ACCESS_MATRIX, hasAccess, getAccessLevel, assertAccess } from '@/lib/auth';
import { ForbiddenError } from '@/lib/auth';
import type { Role, ProtectedTable } from '@/lib/auth';

describe('Access Control Matrix — per arch doc §3.4', () => {
  // ─── Private Notes — CRITICAL TESTS ───────────────
  describe('private_notes — defence in depth', () => {
    it('DENIES student access to private_notes', () => {
      expect(hasAccess('student', 'private_notes')).toBe(false);
      expect(getAccessLevel('student', 'private_notes')).toBe('none');
      expect(() => assertAccess('student', 'private_notes')).toThrow(ForbiddenError);
    });

    it('DENIES parent access to private_notes', () => {
      expect(hasAccess('parent', 'private_notes')).toBe(false);
      expect(getAccessLevel('parent', 'private_notes')).toBe('none');
      expect(() => assertAccess('parent', 'private_notes')).toThrow(ForbiddenError);
    });

    it('allows instructor to access own private_notes', () => {
      expect(hasAccess('instructor', 'private_notes')).toBe(true);
      expect(getAccessLevel('instructor', 'private_notes')).toBe('own');
    });

    it('allows admin full access to private_notes', () => {
      expect(hasAccess('admin', 'private_notes')).toBe(true);
      expect(getAccessLevel('admin', 'private_notes')).toBe('all');
    });
  });

  // ─── Audit Log — Admin Read-Only ──────────────────
  describe('audit_log — admin read-only', () => {
    it('allows admin read-only access', () => {
      expect(getAccessLevel('admin', 'audit_log')).toBe('read');
    });

    it.each(['instructor', 'student', 'parent'] as Role[])('denies %s', (role) => {
      expect(hasAccess(role, 'audit_log')).toBe(false);
    });
  });

  // ─── Full Matrix Snapshot ─────────────────────────
  // These tests validate every cell of the access matrix.
  // If any arch doc update changes the matrix, these tests catch it.

  const matrixSnapshot: Array<[ProtectedTable, Record<Role, string>]> = [
    ['profiles',              { admin: 'all', instructor: 'own', student: 'own', parent: 'own' }],
    ['instructors',           { admin: 'all', instructor: 'own', student: 'read', parent: 'none' }],
    ['students',              { admin: 'all', instructor: 'own', student: 'own', parent: 'scoped' }],
    ['bookings',              { admin: 'all', instructor: 'own', student: 'own', parent: 'scoped' }],
    ['lessons',               { admin: 'all', instructor: 'own', student: 'own', parent: 'scoped' }],
    ['student_competencies',  { admin: 'all', instructor: 'own', student: 'own', parent: 'scoped' }],
    ['signatures',            { admin: 'all', instructor: 'own', student: 'own', parent: 'none' }],
    ['private_notes',         { admin: 'all', instructor: 'own', student: 'none', parent: 'none' }],
    ['payments',              { admin: 'all', instructor: 'none', student: 'own', parent: 'scoped' }],
    ['conversations',         { admin: 'all', instructor: 'none', student: 'own', parent: 'none' }],
    ['call_logs',             { admin: 'all', instructor: 'none', student: 'none', parent: 'none' }],
    ['audit_log',             { admin: 'read', instructor: 'none', student: 'none', parent: 'none' }],
    ['contacts',              { admin: 'all', instructor: 'own', student: 'none', parent: 'none' }],
    ['services',              { admin: 'all', instructor: 'read', student: 'read', parent: 'read' }],
    ['competency_tasks',      { admin: 'all', instructor: 'read', student: 'read', parent: 'read' }],
  ];

  matrixSnapshot.forEach(([table, expected]) => {
    describe(`${table}`, () => {
      (['admin', 'instructor', 'student', 'parent'] as Role[]).forEach((role) => {
        it(`${role} → ${expected[role]}`, () => {
          expect(getAccessLevel(role, table)).toBe(expected[role]);
        });
      });
    });
  });
});
```

### File: `src/__tests__/lib/auth/private-notes-guard.test.ts`

```typescript
// ============================================================
// Test: Private Notes Defence in Depth
// The most security-critical test file in the project.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assertCanAccessPrivateNotes,
  stripPrivateData,
} from '@/lib/auth/private-notes-guard';
import { ForbiddenError } from '@/lib/auth';
import type { AuthContext } from '@/lib/auth';

function makeCtx(role: string): AuthContext {
  return {
    clerkUserId: 'user_test',
    role: role as any,
    profileId: 'prof_123',
    instructorId: role === 'instructor' || role === 'admin' ? 'inst_123' : undefined,
    studentId: role === 'student' ? 'stu_123' : undefined,
    parentId: role === 'parent' ? 'par_123' : undefined,
    isOwner: role === 'admin',
  };
}

describe('assertCanAccessPrivateNotes()', () => {
  it('allows admin', () => {
    expect(() => assertCanAccessPrivateNotes(makeCtx('admin'))).not.toThrow();
  });

  it('allows instructor', () => {
    expect(() => assertCanAccessPrivateNotes(makeCtx('instructor'))).not.toThrow();
  });

  it('DENIES student — throws ForbiddenError', () => {
    expect(() => assertCanAccessPrivateNotes(makeCtx('student'))).toThrow(ForbiddenError);
  });

  it('DENIES parent — throws ForbiddenError', () => {
    expect(() => assertCanAccessPrivateNotes(makeCtx('parent'))).toThrow(ForbiddenError);
  });

  it('logs security warning for student access attempt', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      assertCanAccessPrivateNotes(makeCtx('student'));
    } catch {}
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[SECURITY] Private notes access attempt')
    );
    spy.mockRestore();
  });
});

describe('stripPrivateData()', () => {
  const testData = {
    id: 'lesson_123',
    student_id: 'stu_123',
    comments: 'Great lesson!',
    private_notes: [
      { id: 'pn_1', note: 'Student has anxiety issues' },
    ],
    privateNotes: 'This should also be stripped',
    instructor_notes: 'Coaching strategy: take it slow',
  };

  it('returns full data for admin', () => {
    const result = stripPrivateData(testData, makeCtx('admin'));
    expect(result).toHaveProperty('private_notes');
    expect(result).toHaveProperty('privateNotes');
    expect(result).toHaveProperty('instructor_notes');
  });

  it('returns full data for instructor', () => {
    const result = stripPrivateData(testData, makeCtx('instructor'));
    expect(result).toHaveProperty('private_notes');
  });

  it('STRIPS private data for student', () => {
    const result = stripPrivateData(testData, makeCtx('student'));
    expect(result).not.toHaveProperty('private_notes');
    expect(result).not.toHaveProperty('privateNotes');
    expect(result).not.toHaveProperty('instructor_notes');
    // Non-private fields remain
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('comments');
  });

  it('STRIPS private data for parent', () => {
    const result = stripPrivateData(testData, makeCtx('parent'));
    expect(result).not.toHaveProperty('private_notes');
    expect(result).not.toHaveProperty('privateNotes');
    expect(result).not.toHaveProperty('instructor_notes');
  });

  it('handles nested private data in arrays', () => {
    const nested = {
      lessons: [
        {
          id: 'l1',
          private_notes: 'should be stripped',
          topic: 'lane changes',
        },
      ],
    };
    const result = stripPrivateData(nested, makeCtx('student'));
    expect(result.lessons[0]).not.toHaveProperty('private_notes');
    expect(result.lessons[0]).toHaveProperty('topic');
  });

  it('handles null and undefined gracefully', () => {
    expect(stripPrivateData(null, makeCtx('student'))).toBeNull();
    expect(stripPrivateData(undefined, makeCtx('student'))).toBeUndefined();
  });
});
```

### File: `src/__tests__/lib/auth/rate-limit.test.ts`

```typescript
// ============================================================
// Test: Rate Limiting
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Upstash
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: vi.fn().mockImplementation(() => ({
    limit: vi.fn(),
  })),
}));

import { getRateLimitTier, getClientIp } from '@/lib/rate-limit';

describe('getRateLimitTier()', () => {
  it('returns "mutations" for POST by authenticated user', () => {
    expect(getRateLimitTier('POST', true)).toBe('mutations');
  });

  it('returns "mutations" for PATCH by authenticated user', () => {
    expect(getRateLimitTier('PATCH', true)).toBe('mutations');
  });

  it('returns "mutations" for DELETE by authenticated user', () => {
    expect(getRateLimitTier('DELETE', true)).toBe('mutations');
  });

  it('returns "unauthenticated" for POST by anonymous user', () => {
    expect(getRateLimitTier('POST', false)).toBe('unauthenticated');
  });

  it('returns "authenticated" for GET by authenticated user', () => {
    expect(getRateLimitTier('GET', true)).toBe('authenticated');
  });

  it('returns "unauthenticated" for GET by anonymous user', () => {
    expect(getRateLimitTier('GET', false)).toBe('unauthenticated');
  });
});

describe('getClientIp()', () => {
  it('extracts IP from x-forwarded-for', () => {
    const req = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '203.0.113.50, 70.41.3.18' },
    });
    expect(getClientIp(req)).toBe('203.0.113.50');
  });

  it('falls back to x-real-ip', () => {
    const req = new Request('http://localhost', {
      headers: { 'x-real-ip': '203.0.113.50' },
    });
    expect(getClientIp(req)).toBe('203.0.113.50');
  });

  it('returns "unknown" when no IP headers', () => {
    const req = new Request('http://localhost');
    expect(getClientIp(req)).toBe('unknown');
  });
});
```

---

## 21. Usage Examples

### Example 1: Protected Instructor Route

```typescript
// src/app/api/v1/students/route.ts
import { NextRequest } from 'next/server';
import { apiHandler, scopeByInstructor } from '@/lib/auth';
import { db } from '@/db';
import { students } from '@/db/schema';

export const GET = apiHandler(
  { roles: ['instructor', 'admin'] },
  async (req, ctx) => {
    const scope = scopeByInstructor(ctx!, students.instructorId);
    const result = await db
      .select()
      .from(students)
      .where(scope ?? undefined);

    return Response.json({ data: result });
  }
);
```

### Example 2: Student Self-Access with Parent Scoping

```typescript
// src/app/api/v1/students/[id]/progress/route.ts
import { NextRequest } from 'next/server';
import {
  apiHandler,
  requireStudentOwnership,
  requireParentLink,
  stripPrivateData,
} from '@/lib/auth';

export const GET = apiHandler(
  { roles: ['admin', 'instructor', 'student', 'parent'] },
  async (req, ctx) => {
    const studentId = req.nextUrl.pathname.split('/')[4]; // extract :id

    // Role-specific access check
    if (ctx!.role === 'instructor' || ctx!.role === 'student') {
      await requireStudentOwnership(ctx!, studentId);
    } else if (ctx!.role === 'parent') {
      await requireParentLink(ctx!, studentId, 'can_view_progress');
    }
    // Admin passes through

    const progress = await getStudentProgress(studentId);

    // Safety net: strip any private data that shouldn't be in response
    return Response.json({ data: stripPrivateData(progress, ctx!) });
  }
);
```

### Example 3: Private Notes — Instructor Only

```typescript
// src/app/api/v1/students/[id]/private-notes/route.ts
import { NextRequest } from 'next/server';
import { apiHandler, getPrivateNotes, createPrivateNote } from '@/lib/auth';

// GET — only instructor + admin
export const GET = apiHandler(
  { roles: ['instructor', 'admin'] }, // Layer 4: no route for student/parent
  async (req, ctx) => {
    const studentId = req.nextUrl.pathname.split('/')[4];
    // getPrivateNotes internally calls assertCanAccessPrivateNotes (Layer 2)
    const notes = await getPrivateNotes(ctx!, studentId);
    return Response.json({ data: notes });
  }
);

// POST — only instructor + admin
export const POST = apiHandler(
  { roles: ['instructor', 'admin'] },
  async (req, ctx) => {
    const studentId = req.nextUrl.pathname.split('/')[4];
    const body = await req.json();
    const note = await createPrivateNote(ctx!, {
      studentId,
      ...body,
    });
    return Response.json({ data: note }, { status: 201 });
  }
);
```

---

## 22. Traceability Matrix

Every item in this spec maps back to the architecture document.

| Spec Section | Architecture Reference | PRD Reference |
|---|---|---|
| §4 Types (ClerkSessionClaims) | Arch §6.2 | — |
| §5 Auth Context | Arch §6.1, §6.3 | — |
| §6 Error Types | Arch §4.3 (Error Codes) | — |
| §7 Role Guards | Arch §6.3 | — |
| §8 Ownership Guards | Arch §3.4, §6.4 | — |
| §9 Query Scoping | Arch §3.4, §6.4 | — |
| §10 Access Matrix | Arch §3.4 (exact replica) | — |
| §11 Private Notes Guard | Arch §3.4, §6.4 (defence in depth) | — |
| §12 Clerk Webhook | Arch §6.3.1 | — |
| §13 Role Assignment | Arch §6.2 (publicMetadata) | — |
| §14 Next.js Middleware | Arch §4.2 (route map, auth levels) | — |
| §15 Constants (Sessions) | — | NFR-3 (30 min / 8 hours) |
| §16 Rate Limiting | Arch §4.1, §6.6 | NFR-3 (100/300/10 req/min) |
| §17 API Handler | Arch §4.3 (error format) | — |
| §18 Clerk Setup | Arch §6.2 (session template) | — |

---

## 23. Implementation Checklist

Execute in order:

- [ ] **Step 1:** Install dependencies (`svix`, `@upstash/ratelimit`, `@upstash/redis`)
- [ ] **Step 2:** Add environment variables to `.env.local` and Vercel
- [ ] **Step 3:** Create Clerk application and configure per §18
- [ ] **Step 4:** Create Upstash Redis database in Sydney region
- [ ] **Step 5:** Create type definitions (`types.ts`)
- [ ] **Step 6:** Create error types (`errors.ts`)
- [ ] **Step 7:** Create auth context extraction (`context.ts`)
- [ ] **Step 8:** Create role guards (`require-role.ts`)
- [ ] **Step 9:** Create ownership guards (`require-ownership.ts`)
- [ ] **Step 10:** Create query scoping (`scope-queries.ts`)
- [ ] **Step 11:** Create access control matrix (`access-control.ts`)
- [ ] **Step 12:** Create private notes guard (`private-notes-guard.ts`)
- [ ] **Step 13:** Create rate limiter (`rate-limit/`)
- [ ] **Step 14:** Create constants (`constants.ts`)
- [ ] **Step 15:** Create API handler wrapper (`api-handler.ts`)
- [ ] **Step 16:** Create Clerk webhook route (`app/api/v1/webhooks/clerk/route.ts`)
- [ ] **Step 17:** Create role assignment utility (`webhooks/clerk.ts`)
- [ ] **Step 18:** Create Next.js middleware (`middleware.ts`)
- [ ] **Step 19:** Create barrel export (`index.ts`)
- [ ] **Step 20:** Write and run all unit tests
- [ ] **Step 21:** Test Clerk webhook locally (ngrok + Clerk test events)
- [ ] **Step 22:** Test rate limiting with Upstash dashboard
- [ ] **Step 23:** Set up Rob's admin account via `assignRole()` with `is_owner: true`

---

*End of SPEC-02: Auth & RBAC Design*

*Depends on: SPEC-01 (Database Schema) must be complete before this spec.*
*Next: SPEC-03 onwards (Phase 1 components use the auth layer defined here)*
