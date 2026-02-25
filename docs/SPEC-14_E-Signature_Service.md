# SPEC-14: E-Signature Service (C13)
### NexDrive Academy — Phase 3: Digitise the Paperwork
**Version:** 1.0  
**Date:** 22 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §3.3 (signatures table), §4.2.4 (lesson signing flow); SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-11 (Instructor Workstation)  
**Phase:** 3 (Digitise the Paperwork — Weeks 13-20)  
**Estimated Effort:** 8-10 days  

---

## 1. Overview

The E-Signature Service captures legally defensible digital signatures from instructors and students at the end of every lesson. It replaces wet-ink signatures on paper Form 10.044 with tamper-evident digital equivalents that satisfy ACT Government CBT&A audit requirements.

Every signature is:
- Captured as a PNG image and stored in Cloudflare R2 (Sydney)
- Linked into a SHA-256 hash chain — any tampering anywhere in the chain is detectable
- Accompanied by GPS coordinates (where available), device metadata, and a server-verified timestamp
- **Immutable** — the `signatures` table record can never be updated or deleted

**This is a self-contained implementation brief.** A developer or AI coding agent can execute this spec from start to finish without referring back to the architecture document.

### 1.1 Non-Negotiable Rules

1. **Instructor signs first, student signs second.** A lesson cannot reach `completed` status until both signatures are captured in that order.
2. **`signatures` table is immutable.** No `UPDATE`, no `DELETE`, ever. Enforced in the service layer AND via database triggers.
3. **SHA-256 hash chain is mandatory.** Every signature record links to the previous record's hash. Chain integrity must be verifiable by walking every record.
4. **Offline signatures are first-class.** Rob is in a car. Connectivity is not guaranteed. Signatures captured offline are queued in IndexedDB and uploaded on reconnect. Server validates the offline timestamp on sync.
5. **GPS is best-effort, never a blocker.** Latitude/longitude are captured if available. If not, fields are `null`. Missing GPS never prevents signing.
6. **Signature images are stored in R2, not the database.** The DB record holds the R2 path. The hash is computed from the raw image bytes, making it tamper-evident regardless of the storage location.
7. **Server-side timestamp plausibility check.** Client sends device timestamp. Server rejects it if it differs from server time by more than 5 minutes. Exception: offline sync uploads have a 24-hour window with additional validation.
8. **Image constraints: PNG, max 800×300px, max 200KB** (pre-base64 byte size).
9. **Australian data residency.** R2 bucket is APAC-Sydney. Neon is `ap-southeast-2`.
10. **Private notes never appear in any signing response.** No student- or parent-facing shape ever includes instructor private notes.

---

## 2. Lesson Signature State Machine

```
lessons.status:

  draft
    │
    │  POST /api/v1/lessons (instructor creates lesson record)
    │
    ▼
  draft ──── instructor signs ────► pending_student_signature
               role=instructor
               POST /api/v1/lessons/:id/sign                 │
                                                             │  student signs
                                                             │  role=student
                                                             │  POST /api/v1/lessons/:id/sign
                                                             │
                                                             ▼
                                                         completed
                                                      (signed_at = NOW())
                                                             │
                                              student disputes within 48h
                                                             │
                                                             ▼
                                                          disputed

  completed ── (correction needed) ──► POST /api/v1/lessons/:id/correction
               Creates NEW lesson row (correction_of = original_id)
               Original lesson record is NEVER modified
```

Key state rules:
- `PATCH /api/v1/lessons/:id` (edit lesson data) is only allowed when `status = 'draft'`
- Once `status = 'pending_student_signature'` the lesson data is locked — only a correction record can change it
- `status = 'completed'` is terminal for that row — no further mutations

---

## 3. Database Schema

### 3.1 `signatures` Table (existing — defined in SPEC-01)

```sql
-- Reference only — do not re-create.
-- Managed by SPEC-01 initial migration.

CREATE TABLE signatures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who signed
  signer_id       TEXT NOT NULL,           -- Clerk user_id (TEXT, not FK)
  signer_role     TEXT NOT NULL CHECK (signer_role IN ('instructor', 'student')),

  -- What they signed
  document_type   TEXT NOT NULL CHECK (document_type IN ('lesson', 'competency', 'certificate', 'enrollment')),
  document_id     UUID NOT NULL,           -- lessons.id when document_type = 'lesson'

  -- Signature image
  signature_url   TEXT NOT NULL,           -- R2 path: signatures/{YYYY}/{MM}/{uuid}.png

  -- Verification metadata
  timestamp_utc   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      INET,
  user_agent      TEXT,
  device_info     JSONB,                   -- See §3.3 for shape
  gps_latitude    NUMERIC(10,7),
  gps_longitude   NUMERIC(10,7),

  -- Hash chain
  previous_hash   TEXT,                   -- record_hash of the previous signatures row (NULL for genesis)
  record_hash     TEXT NOT NULL,          -- SHA-256 — see §5 for exact input

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at — immutable
  -- NO deleted_at — immutable
);

CREATE INDEX idx_signatures_signer   ON signatures(signer_id);
CREATE INDEX idx_signatures_document ON signatures(document_type, document_id);
CREATE INDEX idx_signatures_created  ON signatures(created_at);   -- for chain walking
```

### 3.2 Database-Level Immutability Triggers

These triggers are the last line of defence. They must be added in a dedicated migration after the initial schema.

```sql
-- Migration: 0012_signature_immutability_triggers.sql

CREATE OR REPLACE FUNCTION prevent_signature_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Signatures are immutable. Attempted % on id=%. If correction is needed, create a new lesson record with correction_of.',
    TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signatures_immutable_update
  BEFORE UPDATE ON signatures
  FOR EACH ROW EXECUTE FUNCTION prevent_signature_mutation();

CREATE TRIGGER signatures_immutable_delete
  BEFORE DELETE ON signatures
  FOR EACH ROW EXECUTE FUNCTION prevent_signature_mutation();
```

### 3.3 `device_info` JSONB Shape

```typescript
interface DeviceInfo {
  userAgent: string;           // navigator.userAgent
  screenWidth: number;         // screen.width
  screenHeight: number;        // screen.height
  devicePixelRatio: number;    // window.devicePixelRatio
  platform: string;            // navigator.platform (e.g., 'iPhone', 'Win32')
  touchEnabled: boolean;       // 'ontouchstart' in window
  canvasWidth: number;         // actual canvas element width used for signature
  canvasHeight: number;        // actual canvas element height
  offlineSigned: boolean;      // true if captured without connectivity
  deviceTimestamp: string;     // ISO 8601 UTC — device clock at time of signing
  syncedAt?: string;           // ISO 8601 UTC — when uploaded (offline only)
}
```

---

## 4. API Endpoints

### 4.1 `POST /api/v1/lessons/:id/sign`

Captures a signature for a lesson. Callable by instructor (first) and student (second).

**Auth:** Clerk session — role must be `instructor` or `student`. Role determines which signature slot is being filled.

**Request body:**

```typescript
interface SignLessonRequest {
  signature_image: string;        // Base64-encoded PNG (data URL prefix stripped)
  device_timestamp: string;       // ISO 8601 UTC — device clock at time of signing
  gps_latitude?: number | null;   // WGS84 — null if unavailable
  gps_longitude?: number | null;  // WGS84 — null if unavailable
  device_info: DeviceInfo;        // See §3.3
  offline_signed?: boolean;       // true if this is an offline-queued upload
}
```

**Validation (executed in order — fail fast):**

| # | Check | Error code | HTTP |
|---|-------|-----------|------|
| 1 | Lesson exists | `LESSON_NOT_FOUND` | 404 |
| 2 | Caller has access to this lesson | `FORBIDDEN` | 403 |
| 3 | Signing order — instructor before student | `WRONG_SIGNING_ORDER` | 409 |
| 4 | Signer hasn't already signed this lesson | `ALREADY_SIGNED` | 409 |
| 5 | Lesson status allows signing | `LESSON_NOT_SIGNABLE` | 409 |
| 6 | `signature_image` is valid base64 | `INVALID_IMAGE` | 422 |
| 7 | Decoded image ≤ 200KB | `IMAGE_TOO_LARGE` | 422 |
| 8 | Image is valid PNG | `INVALID_IMAGE_FORMAT` | 422 |
| 9 | Image dimensions ≤ 800×300 | `IMAGE_DIMENSIONS_EXCEEDED` | 422 |
| 10 | Timestamp plausibility check | `TIMESTAMP_IMPLAUSIBLE` | 422 |

**Timestamp plausibility rule:**

```typescript
const serverNow = Date.now();
const clientTs = new Date(body.device_timestamp).getTime();
const diffMs = Math.abs(serverNow - clientTs);

const maxDriftMs = body.offline_signed
  ? 24 * 60 * 60 * 1000   // 24 hours for offline sync uploads
  :  5 * 60 * 1000;        // 5 minutes for live online signing

if (diffMs > maxDriftMs) {
  throw new ValidationError('TIMESTAMP_IMPLAUSIBLE', `Device clock differs from server by ${Math.round(diffMs / 1000)}s`);
}
```

For offline uploads, additional validation is applied: the device timestamp must be after the lesson's `start_time` and before `NOW()`.

**Success response `200 OK`:**

```typescript
interface SignLessonResponse {
  signature_id: string;       // UUID of the created signatures row
  lesson_status: 'pending_student_signature' | 'completed';
  signed_at?: string;         // ISO 8601 — only present when lesson_status = 'completed'
  message: string;            // Human-readable: 'Instructor signature captured. Awaiting student.'
}
```

**Error response shape (all errors):**

```json
{
  "error": {
    "code": "WRONG_SIGNING_ORDER",
    "message": "The instructor must sign before the student.",
    "details": {}
  }
}
```

---

### 4.2 `GET /api/v1/lessons/:id/signatures`

Returns the signature records for a lesson. Used by the instructor workstation to display signing status.

**Auth:** `instructor` (own lessons), `student` (own lessons), `admin` (all).

**Response `200 OK`:**

```typescript
interface LessonSignaturesResponse {
  lesson_id: string;
  status: string;
  signatures: Array<{
    id: string;
    signer_role: 'instructor' | 'student';
    signed_at: string;            // timestamp_utc ISO 8601
    signature_url: string;        // Presigned R2 URL (1-hour expiry)
    gps_latitude: number | null;
    gps_longitude: number | null;
    // record_hash and previous_hash are included for instructor and admin only
    record_hash?: string;
    previous_hash?: string | null;
  }>;
}
```

Note: `signature_url` is a **signed R2 URL** generated server-side with 1-hour expiry. The raw R2 path is never exposed to clients.

---

### 4.3 `GET /api/v1/signatures/verify-chain`

Admin-only endpoint. Walks the entire signatures chain and reports any integrity failures.

**Auth:** `admin` only.

**Query params:**
- `document_type` (optional) — filter to `lesson`, `competency`, etc.
- `document_id` (optional) — verify chain for a specific document
- `from_date` / `to_date` (optional) — date range

**Response `200 OK`:**

```typescript
interface ChainVerificationResponse {
  verified: boolean;
  total_records: number;
  failures: Array<{
    signature_id: string;
    expected_hash: string;
    actual_hash: string;
    created_at: string;
  }>;
  checked_at: string;   // ISO 8601
}
```

---

## 5. SHA-256 Hash Chain

### 5.1 Hash Input Construction

The `record_hash` stored in the database is computed by the **application**, not a DB trigger. This is intentional — the hash must include the signature image bytes, which are not stored in the database.

```
record_hash = SHA-256(
  image_sha256          // SHA-256 hex of the raw PNG bytes (computed from base64-decoded image)
  + "|" + timestamp_utc // ISO 8601 UTC string (server-assigned, NOT client device_timestamp)
  + "|" + signer_id     // Clerk user_id TEXT
  + "|" + document_type // 'lesson' | 'competency' | etc.
  + "|" + document_id   // UUID string
  + "|" + previous_hash // hex string, or literal string "GENESIS" if no prior record
)
```

All fields are concatenated as UTF-8 strings with `|` as delimiter. Result is a lowercase hex string.

### 5.2 TypeScript Implementation

```typescript
import crypto from 'node:crypto';

/**
 * Compute SHA-256 of raw bytes. Returns lowercase hex string.
 */
function sha256Hex(input: Buffer | string): string {
  return crypto
    .createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf-8') : input)
    .digest('hex');
}

/**
 * Compute the record_hash for a new signature.
 * Call this BEFORE inserting into the database.
 */
function computeSignatureRecordHash(params: {
  imageBytes: Buffer;          // Raw PNG bytes (base64-decoded)
  timestampUtc: string;        // Server-assigned ISO 8601 UTC string
  signerId: string;            // Clerk user_id
  documentType: string;
  documentId: string;
  previousHash: string | null; // null for genesis
}): { imageSha256: string; recordHash: string } {
  const imageSha256 = sha256Hex(params.imageBytes);
  const previousHash = params.previousHash ?? 'GENESIS';

  const input = [
    imageSha256,
    params.timestampUtc,
    params.signerId,
    params.documentType,
    params.documentId,
    previousHash,
  ].join('|');

  return {
    imageSha256,
    recordHash: sha256Hex(input),
  };
}
```

### 5.3 Genesis Record Handling

The very first signature record in the system has no predecessor. In this case:
- `previous_hash` column is set to `NULL` in the database
- The hash input uses the literal string `"GENESIS"` in place of `previous_hash`

This is deterministic and unambiguous — there can only ever be one genesis record.

### 5.4 Chain Verification Algorithm

```typescript
/**
 * Walk the entire signatures chain (or a filtered subset) and verify integrity.
 * Returns a list of failures. Empty array = chain is intact.
 */
async function verifySignatureChain(filters?: {
  documentType?: string;
  documentId?: string;
  fromDate?: Date;
  toDate?: Date;
}): Promise<ChainVerificationResult> {
  // Fetch records ordered chronologically (oldest first)
  const records = await db
    .select()
    .from(signatures)
    .where(/* apply filters */)
    .orderBy(asc(signatures.created_at));

  const failures: ChainFailure[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const previousRecord = i > 0 ? records[i - 1] : null;

    // 1. Verify previous_hash linkage
    const expectedPreviousHash = previousRecord?.record_hash ?? null;
    if (record.previous_hash !== expectedPreviousHash) {
      failures.push({
        signature_id: record.id,
        failure_type: 'BROKEN_CHAIN_LINK',
        expected: expectedPreviousHash ?? 'NULL',
        actual: record.previous_hash ?? 'NULL',
        created_at: record.created_at.toISOString(),
      });
    }

    // 2. Re-fetch signature image from R2 and recompute record_hash
    // Note: This is expensive. For routine checks, only verify the chain linkage above.
    // Full image verification is done on-demand (e.g., when tampering is suspected).
    // The verifyChain endpoint accepts a `deep=true` param to trigger image re-fetching.
  }

  return {
    verified: failures.length === 0,
    total_records: records.length,
    failures,
    checked_at: new Date().toISOString(),
  };
}
```

**Chain link verification** (checks `previous_hash` linkage) runs in O(n) without touching R2. This is the routine check.

**Deep verification** (re-fetches signature images from R2 and recomputes hashes) is expensive and should only be triggered manually by an admin when tampering is suspected, or as a scheduled monthly audit job.

---

## 6. Signature Storage (Cloudflare R2)

### 6.1 R2 Path Convention

```
signatures/{YYYY}/{MM}/{signature-uuid}.png

Examples:
  signatures/2026/02/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png
  signatures/2026/03/b2c3d4e5-f6a7-8901-bcde-f12345678901.png
```

The path uses the signature's UUID (generated before upload, used as the DB primary key). Year and month are UTC-based, derived from the server-assigned `timestamp_utc`.

### 6.2 Upload Process

```typescript
async function uploadSignatureImage(params: {
  signatureId: string;    // UUID — pre-generated, used as the PK
  imageBytes: Buffer;     // Raw PNG bytes
  timestampUtc: Date;
}): Promise<string> {
  const year = params.timestampUtc.getUTCFullYear();
  const month = String(params.timestampUtc.getUTCMonth() + 1).padStart(2, '0');
  const key = `signatures/${year}/${month}/${params.signatureId}.png`;

  await r2Client.putObject({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: params.imageBytes,
    ContentType: 'image/png',
    ContentLength: params.imageBytes.length,
    // R2 has no object-level ACL — access is via signed URLs only
  });

  return key; // stored as signature_url in the database
}
```

### 6.3 Generating Presigned Read URLs

Signature images are never publicly accessible. Every client access goes through a server-generated presigned URL.

```typescript
async function getSignaturePresignedUrl(
  signatureUrl: string,        // The R2 key stored in signatures.signature_url
  expirySeconds = 3600         // 1 hour default
): Promise<string> {
  return await r2Client.getSignedUrl('getObject', {
    Bucket: process.env.R2_BUCKET_NAME,
    Key: signatureUrl,
    Expires: expirySeconds,
  });
}
```

Presigned URLs are generated on-demand in API responses. They are never cached or stored.

### 6.4 R2 Bucket Configuration

```
Bucket name:    nexdrive-signatures (or nexdrive-files-prod with /signatures/ prefix)
Region:         APAC — Cloudflare Sydney PoP serves AU traffic
Public access:  DISABLED — no public bucket access
CORS:           Not required (server-side access only)
Object lock:    Enable if available on R2 (prevents deletion at storage layer)
Lifecycle:      NONE — signatures are retained indefinitely for compliance
```

---

## 7. Dual Signature Flow — Detailed Sequence

### 7.1 Online Flow (Normal Case)

```
Instructor Workstation                     API Server                    Neon DB          R2
──────────────────────                     ──────────                    ───────          ──
                                           
1. Instructor completes lesson data entry
   POST /api/v1/lessons ────────────────► Insert lessons row (status='draft')
                         ◄───────────────── { lesson_id }

2. Instructor draws signature on canvas
   POST /api/v1/lessons/:id/sign ────────► 
   { signature_image, device_timestamp,        │
     gps_lat, gps_lon, device_info }           │
                                               ▼
                                          Validate request (§4.1)
                                          Check lesson is in draft + no instructor_signature_id
                                          Decode base64 → imageBytes
                                          Validate PNG, dimensions, size
                                          Validate timestamp plausibility
                                          
                                          Generate signatureId = gen_random_uuid()
                                          Upload image ─────────────────────────────────────► R2 PUT
                                          Compute imageSha256 = SHA256(imageBytes)                  ◄─ ok
                                          Fetch previousHash = last record_hash from signatures
                                          Compute recordHash = SHA256(imageSha256|ts|...|prevHash)
                                          
                                          BEGIN TRANSACTION
                                          INSERT INTO signatures {...} ──────────────────── DB INSERT
                                          UPDATE lessons SET
                                            instructor_signature_id = signatureId,
                                            status = 'pending_student_signature' ─────────── DB UPDATE
                                          COMMIT
                                          
                                          Emit LESSON_INSTRUCTOR_SIGNED event → audit_log
                                          
   ◄──────────────────────────────────── { signature_id, lesson_status: 'pending_student_signature' }

3. Student opens lesson on their device (Student Portal)
   GET /api/v1/lessons/:id/signatures ──► Return signing status + presigned instructor sig URL
   ◄── { signatures: [{ signer_role: 'instructor', signed_at: ..., signature_url: '...' }] }

4. Student draws signature on canvas
   POST /api/v1/lessons/:id/sign ────────►
   { signature_image, device_timestamp,        │
     gps_lat, gps_lon, device_info }           │
                                               ▼
                                          Validate request
                                          Check lesson status = 'pending_student_signature'
                                          Check student_signature_id IS NULL
                                          (same upload + hash process as step 2)
                                          
                                          BEGIN TRANSACTION
                                          INSERT INTO signatures {...} ──────────────────── DB INSERT
                                          UPDATE lessons SET
                                            student_signature_id = signatureId,
                                            status = 'completed',
                                            signed_at = NOW() ─────────────────────────── DB UPDATE
                                          COMMIT
                                          
                                          Emit LESSON_COMPLETED event
                                          → C14 audit_log insert
                                          → C12 CBT&A engine: process competency updates
                                          → C18 Notification: 'Lesson signed — Rob Harrison | Tue 18 Feb'
                                          
   ◄──────────────────────────────────── { signature_id, lesson_status: 'completed', signed_at: '...' }
```

### 7.2 Offline Flow (Rob in the Car, No Signal)

```
Instructor Workstation (PWA)                Background Sync               API Server
────────────────────────────                ──────────────                ──────────

1. Rob has no connectivity.
   Device detects offline state.
   UI shows "Offline mode — signatures will sync when connected"

2. Instructor draws signature on canvas.
   SignatureService.captureOffline() is called:
   
   a. Generate local signatureId (UUID v4 — client-generated for offline)
   b. Convert canvas to PNG blob
   c. Store in IndexedDB:
      Key: `pending_signature_${signatureId}`
      Value: {
        signatureId,
        lessonId,
        imageBlob,
        deviceTimestamp: new Date().toISOString(),
        gpsLatitude,        // from navigator.geolocation (if available)
        gpsLongitude,
        deviceInfo,
        signerRole: 'instructor',
        syncStatus: 'pending'
      }
   d. Show "Signature saved offline — will sync automatically"

3. Student draws signature on canvas (same device, different role).
   Same offline capture process → stored in IndexedDB.

4. Device regains connectivity.
   Service Worker Background Sync fires 'signature-sync' tag.

5. Background sync handler:
   a. Read all pending_signature_* from IndexedDB
   b. For each pending signature (ordered by deviceTimestamp ASC):
      - Read imageBlob → convert to base64
      - POST /api/v1/lessons/:id/sign with offline_signed: true
      - On 200: delete from IndexedDB, update local lesson status
      - On 422 TIMESTAMP_IMPLAUSIBLE: mark as 'sync_failed', alert Rob
      - On 409 ALREADY_SIGNED: delete from IndexedDB (already uploaded)
      - On 5xx: leave in IndexedDB, retry on next sync

6. Server receives offline sync upload:
   - offline_signed: true → timestamp window is 24 hours instead of 5 minutes
   - Additional check: device_timestamp must be ≥ lessons.start_time
   - Additional check: device_timestamp must be ≤ NOW()
   - If checks pass → normal signature storage flow
   - Server-assigned timestamp_utc = NOW() (not device_timestamp)
   - device_info.offlineSigned = true, device_info.deviceTimestamp = original device time
```

### 7.3 Signing Order Enforcement Logic

```typescript
async function validateSigningOrder(
  lesson: Lesson,
  signerRole: 'instructor' | 'student'
): Promise<void> {

  if (signerRole === 'instructor') {
    // Instructor must sign when lesson is in draft
    if (lesson.status !== 'draft') {
      throw new ConflictError(
        'LESSON_NOT_SIGNABLE',
        `Lesson status is '${lesson.status}'. Instructor can only sign a draft lesson.`
      );
    }
    if (lesson.instructor_signature_id !== null) {
      throw new ConflictError('ALREADY_SIGNED', 'Instructor has already signed this lesson.');
    }
  }

  if (signerRole === 'student') {
    // Student can only sign after instructor
    if (lesson.status !== 'pending_student_signature') {
      if (lesson.status === 'draft') {
        throw new ConflictError(
          'WRONG_SIGNING_ORDER',
          'The instructor must sign before the student.'
        );
      }
      throw new ConflictError(
        'LESSON_NOT_SIGNABLE',
        `Lesson status is '${lesson.status}'. Cannot sign.`
      );
    }
    if (lesson.student_signature_id !== null) {
      throw new ConflictError('ALREADY_SIGNED', 'Student has already signed this lesson.');
    }
  }
}
```

---

## 8. Image Validation

All validation happens server-side on the decoded bytes. Client-side validation is a UX courtesy only.

```typescript
import sharp from 'sharp'; // add to package.json: "sharp": "^0.33.x"

interface ImageValidationResult {
  valid: boolean;
  errorCode?: string;
  errorMessage?: string;
  metadata?: { width: number; height: number; format: string; sizeBytes: number };
}

async function validateSignatureImage(base64Image: string): Promise<ImageValidationResult> {
  // 1. Decode base64 (strip data URL prefix if present)
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
  let imageBytes: Buffer;
  try {
    imageBytes = Buffer.from(base64Data, 'base64');
  } catch {
    return { valid: false, errorCode: 'INVALID_IMAGE', errorMessage: 'Cannot decode base64 image.' };
  }

  // 2. Check byte size (200KB max)
  const MAX_BYTES = 200 * 1024;
  if (imageBytes.length > MAX_BYTES) {
    return {
      valid: false,
      errorCode: 'IMAGE_TOO_LARGE',
      errorMessage: `Image is ${Math.round(imageBytes.length / 1024)}KB. Maximum is 200KB.`,
    };
  }

  // 3. Validate format and dimensions using sharp
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(imageBytes).metadata();
  } catch {
    return { valid: false, errorCode: 'INVALID_IMAGE_FORMAT', errorMessage: 'Image could not be parsed.' };
  }

  if (metadata.format !== 'png') {
    return { valid: false, errorCode: 'INVALID_IMAGE_FORMAT', errorMessage: 'Image must be PNG format.' };
  }

  const MAX_WIDTH = 800;
  const MAX_HEIGHT = 300;

  if ((metadata.width ?? 0) > MAX_WIDTH || (metadata.height ?? 0) > MAX_HEIGHT) {
    return {
      valid: false,
      errorCode: 'IMAGE_DIMENSIONS_EXCEEDED',
      errorMessage: `Image is ${metadata.width}×${metadata.height}px. Maximum is ${MAX_WIDTH}×${MAX_HEIGHT}px.`,
    };
  }

  return {
    valid: true,
    metadata: {
      width: metadata.width!,
      height: metadata.height!,
      format: metadata.format,
      sizeBytes: imageBytes.length,
    },
  };
}
```

---

## 9. Service Layer Implementation

### 9.1 File Structure

```
src/
  lib/
    e-signature/
      signature.service.ts     ← main service — all business logic
      signature.hash.ts        ← SHA-256 hash chain utilities
      signature.storage.ts     ← R2 upload / presigned URL helpers
      signature.validate.ts    ← image validation (wraps sharp)
      signature.types.ts       ← TypeScript interfaces
      signature.verify.ts      ← chain verification (admin use)

  app/
    api/
      v1/
        lessons/
          [id]/
            sign/
              route.ts         ← POST /api/v1/lessons/:id/sign
            signatures/
              route.ts         ← GET /api/v1/lessons/:id/signatures
        signatures/
          verify-chain/
            route.ts           ← GET /api/v1/signatures/verify-chain (admin)
```

### 9.2 Core `captureSignature` Service Function

```typescript
// src/lib/e-signature/signature.service.ts

import { auth } from '@clerk/nextjs/server';
import { db } from '@/lib/db';
import { signatures, lessons } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { computeSignatureRecordHash } from './signature.hash';
import { uploadSignatureImage, getSignaturePresignedUrl } from './signature.storage';
import { validateSignatureImage } from './signature.validate';
import { validateTimestamp, validateSigningOrder } from './signature.validate';
import { emitEvent } from '@/lib/events';
import { createAuditLog } from '@/lib/audit';
import type { SignLessonRequest, SignLessonResponse } from './signature.types';

export async function captureSignature(
  lessonId: string,
  body: SignLessonRequest,
  requestMeta: { ipAddress: string; userAgent: string }
): Promise<SignLessonResponse> {

  // 1. Auth context
  const { userId, sessionClaims } = await auth();
  if (!userId) throw new UnauthorizedError();
  const signerRole = sessionClaims?.role as 'instructor' | 'student';
  if (!['instructor', 'student'].includes(signerRole)) {
    throw new ForbiddenError('Only instructors and students may sign lessons.');
  }

  // 2. Fetch lesson — verify caller has access
  const lesson = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
  });
  if (!lesson) throw new NotFoundError('LESSON_NOT_FOUND');

  // Access control: instructor must own the lesson; student must be the lesson's student
  if (signerRole === 'instructor') {
    const instructorId = sessionClaims?.instructor_id as string;
    if (lesson.instructor_id !== instructorId) throw new ForbiddenError();
  }
  if (signerRole === 'student') {
    const studentId = sessionClaims?.student_id as string;
    if (lesson.student_id !== studentId) throw new ForbiddenError();
  }

  // 3. Validate signing order
  await validateSigningOrder(lesson, signerRole);

  // 4. Validate image
  const imageValidation = await validateSignatureImage(body.signature_image);
  if (!imageValidation.valid) {
    throw new ValidationError(imageValidation.errorCode!, imageValidation.errorMessage!);
  }

  // 5. Validate timestamp
  validateTimestamp(body.device_timestamp, body.offline_signed ?? false);

  // 6. Decode image bytes
  const base64Data = body.signature_image.replace(/^data:image\/\w+;base64,/, '');
  const imageBytes = Buffer.from(base64Data, 'base64');

  // 7. Generate UUID for this signature (pre-generate so we can use as R2 key)
  const signatureId = crypto.randomUUID();
  const serverTimestamp = new Date();
  const serverTimestampIso = serverTimestamp.toISOString();

  // 8. Upload image to R2
  const signatureUrl = await uploadSignatureImage({
    signatureId,
    imageBytes,
    timestampUtc: serverTimestamp,
  });

  // 9. Compute hash chain
  const previousRecord = await db.query.signatures.findFirst({
    orderBy: [desc(signatures.created_at)],
    columns: { record_hash: true },
  });
  const { imageSha256, recordHash } = computeSignatureRecordHash({
    imageBytes,
    timestampUtc: serverTimestampIso,
    signerId: userId,
    documentType: 'lesson',
    documentId: lessonId,
    previousHash: previousRecord?.record_hash ?? null,
  });

  // 10. Build device_info JSONB
  const deviceInfo = {
    ...body.device_info,
    offlineSigned: body.offline_signed ?? false,
    syncedAt: body.offline_signed ? serverTimestampIso : undefined,
  };

  // 11. Transactional insert + lesson status update
  await db.transaction(async (tx) => {
    // Insert signature record
    await tx.insert(signatures).values({
      id: signatureId,
      signer_id: userId,
      signer_role: signerRole,
      document_type: 'lesson',
      document_id: lessonId,
      signature_url: signatureUrl,
      timestamp_utc: serverTimestamp,
      ip_address: requestMeta.ipAddress,
      user_agent: requestMeta.userAgent,
      device_info: deviceInfo,
      gps_latitude: body.gps_latitude ?? null,
      gps_longitude: body.gps_longitude ?? null,
      previous_hash: previousRecord?.record_hash ?? null,
      record_hash: recordHash,
    });

    // Update lesson
    if (signerRole === 'instructor') {
      await tx
        .update(lessons)
        .set({
          instructor_signature_id: signatureId,
          status: 'pending_student_signature',
        })
        .where(eq(lessons.id, lessonId));
    } else {
      const now = new Date();
      await tx
        .update(lessons)
        .set({
          student_signature_id: signatureId,
          status: 'completed',
          signed_at: now,
        })
        .where(eq(lessons.id, lessonId));
    }
  });

  // 12. Audit log
  await createAuditLog({
    event_type: signerRole === 'instructor' ? 'LESSON_INSTRUCTOR_SIGNED' : 'LESSON_STUDENT_SIGNED',
    severity: 'info',
    actor_id: userId,
    actor_role: signerRole,
    subject_type: 'lesson',
    subject_id: lessonId,
    details: {
      signature_id: signatureId,
      gps_latitude: body.gps_latitude ?? null,
      gps_longitude: body.gps_longitude ?? null,
      offline_signed: body.offline_signed ?? false,
      image_sha256: imageSha256,
    },
    ip_address: requestMeta.ipAddress,
    gps_latitude: body.gps_latitude ?? null,
    gps_longitude: body.gps_longitude ?? null,
  });

  // 13. Emit domain event (C12 CBT&A and C18 Notifications listen)
  const newStatus = signerRole === 'instructor' ? 'pending_student_signature' : 'completed';
  emitEvent(signerRole === 'instructor' ? 'LESSON_INSTRUCTOR_SIGNED' : 'LESSON_COMPLETED', {
    lessonId,
    signatureId,
    instructorId: lesson.instructor_id,
    studentId: lesson.student_id,
  });

  return {
    signature_id: signatureId,
    lesson_status: newStatus,
    signed_at: newStatus === 'completed' ? serverTimestampIso : undefined,
    message:
      signerRole === 'instructor'
        ? 'Instructor signature captured. Awaiting student signature.'
        : 'Student signature captured. Lesson is now complete.',
  };
}
```

### 9.3 Route Handler

```typescript
// src/app/api/v1/lessons/[id]/sign/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { captureSignature } from '@/lib/e-signature/signature.service';
import { getClientIp } from '@/lib/utils/request';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();
    const result = await captureSignature(params.id, body, {
      ipAddress: getClientIp(req),
      userAgent: req.headers.get('user-agent') ?? 'unknown',
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    // Centralised error handler maps error classes to HTTP status codes
    return handleApiError(error);
  }
}
```

---

## 10. Offline Signature Handling (Client Side)

### 10.1 IndexedDB Schema

```typescript
// src/lib/offline/signature-queue.ts

interface PendingSignature {
  id: string;                    // client-generated UUID
  lessonId: string;
  signerRole: 'instructor' | 'student';
  imageBlob: Blob;               // PNG blob from canvas
  deviceTimestamp: string;       // ISO 8601 — device clock at signing time
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  deviceInfo: DeviceInfo;
  syncStatus: 'pending' | 'syncing' | 'synced' | 'failed';
  failureReason?: string;
  createdAt: string;             // ISO 8601
}

// IndexedDB store name: 'pending_signatures'
// Key: pending_signature.id
```

### 10.2 Service Worker Registration

```typescript
// src/app/instructor-workstation/layout.tsx (or _layout equivalent)

if ('serviceWorker' in navigator && 'SyncManager' in window) {
  navigator.serviceWorker.ready.then((registration) => {
    // Register background sync for signature uploads
    registration.sync.register('signature-sync');
  });
}
```

### 10.3 Background Sync Handler (Service Worker)

```typescript
// public/sw.js (service worker)

self.addEventListener('sync', (event) => {
  if (event.tag === 'signature-sync') {
    event.waitUntil(syncPendingSignatures());
  }
});

async function syncPendingSignatures() {
  const pendingSignatures = await getAllPendingSignatures(); // Read from IndexedDB

  // Sort by deviceTimestamp ASC — sync in order of capture
  pendingSignatures.sort((a, b) =>
    new Date(a.deviceTimestamp).getTime() - new Date(b.deviceTimestamp).getTime()
  );

  for (const pending of pendingSignatures) {
    try {
      await markSyncing(pending.id);

      // Convert blob to base64
      const base64 = await blobToBase64(pending.imageBlob);

      const response = await fetch(`/api/v1/lessons/${pending.lessonId}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',       // Send Clerk session cookie
        body: JSON.stringify({
          signature_image: base64,
          device_timestamp: pending.deviceTimestamp,
          gps_latitude: pending.gpsLatitude,
          gps_longitude: pending.gpsLongitude,
          device_info: pending.deviceInfo,
          offline_signed: true,
        }),
      });

      if (response.ok) {
        await deleteFromQueue(pending.id);
      } else if (response.status === 409) {
        // Already signed (e.g., duplicate sync) — safe to remove
        await deleteFromQueue(pending.id);
      } else {
        const error = await response.json();
        await markFailed(pending.id, error.error?.code ?? 'UNKNOWN');
        // Notify instructor UI via postMessage
        self.clients.matchAll().then(clients =>
          clients.forEach(client => client.postMessage({
            type: 'SIGNATURE_SYNC_FAILED',
            lessonId: pending.lessonId,
            errorCode: error.error?.code,
          }))
        );
      }
    } catch (networkError) {
      // Network still down — leave in queue, sync will retry
      await markPending(pending.id);
    }
  }
}
```

### 10.4 GPS Capture

```typescript
// src/lib/e-signature/gps.ts

export async function captureGps(
  timeoutMs = 10000
): Promise<{ latitude: number; longitude: number } | null> {
  if (!navigator.geolocation) return null;

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      () => {
        clearTimeout(timer);
        resolve(null); // GPS unavailable — null is valid, not an error
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}
```

GPS capture is initiated when the signature canvas is first displayed to the user — not when they lift the pen — giving the device time to acquire a fix before the signature is complete.

---

## 11. Canvas Component (Instructor Workstation)

The signature canvas is a React component rendered in the Instructor Workstation (C11). This spec defines the contract; full UI is specified in SPEC-12.

```typescript
// src/components/e-signature/SignatureCanvas.tsx

interface SignatureCanvasProps {
  lessonId: string;
  signerRole: 'instructor' | 'student';
  onSigned: (result: SignLessonResponse) => void;
  onError: (error: Error) => void;
}

// Key behaviours:
// 1. Canvas dimensions: 800×300 CSS pixels, device pixel ratio applied for sharpness
// 2. Touch and mouse input both supported (pointer events)
// 3. 'Clear' button resets the canvas
// 4. 'Confirm Signature' button:
//    a. Export canvas as PNG blob (toBlob with type='image/png')
//    b. Check connectivity: navigator.onLine
//    c. If online: convert blob to base64, POST to API
//    d. If offline: store in IndexedDB queue, show 'Saved offline' confirmation
//    e. In both cases: disable canvas to prevent re-signing
// 5. Show instructor's signature preview before student signs
// 6. Minimum stroke requirement: refuse to submit an empty/near-empty canvas
//    (pixel count threshold: at least 100 non-white pixels)
```

### 11.1 Empty Signature Detection

```typescript
function isSignatureEmpty(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return true;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  let nonWhitePixelCount = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
    const isWhiteOrTransparent = (r > 240 && g > 240 && b > 240) || a < 10;
    if (!isWhiteOrTransparent) nonWhitePixelCount++;
    if (nonWhitePixelCount >= 100) return false; // Early exit
  }
  return nonWhitePixelCount < 100;
}
```

---

## 12. Security Considerations

### 12.1 Threat Model

| Threat | Mitigation |
|--------|-----------|
| Forged signature (attacker submits arbitrary image) | Server validates PNG format and dimensions. Hash chain includes `signer_id` (Clerk-authenticated). Audit log records IP. Attacker would need to steal a Clerk session. |
| Replay attack (re-submit a captured signature) | Signing order check: `ALREADY_SIGNED` on duplicate. Database unique constraint could be added: `UNIQUE(document_type, document_id, signer_role)`. |
| Timestamp manipulation | Server-side plausibility check (5-minute window online, 24-hour window offline with additional checks). `timestamp_utc` is always server-assigned — device timestamp is advisory only and stored in `device_info`. |
| Record tampering after insert | DB trigger blocks UPDATE/DELETE. Hash chain detects any tampered record via chain verification. |
| R2 image replacement | `record_hash` includes `imageSha256` (computed from the original image bytes before upload). If the R2 object is replaced, the chain verification will detect the mismatch on deep verification. |
| GPS spoofing | GPS is informational only — it does not prove location. Noted in audit log. |
| Offline signature impersonation | Offline signatures require a valid Clerk session cookie on upload. Device-only capture (without upload) is not a valid signature. |

### 12.2 Rate Limiting

Apply Upstash Redis rate limiting on the signing endpoint:

```
POST /api/v1/lessons/:id/sign
  Per-user limit:   10 requests/minute  (prevents automated submission)
  Per-IP limit:     20 requests/minute
```

---

## 13. Events Emitted

The E-Signature Service emits the following internal events (consumed by C14 Audit Trail, C12 CBT&A Engine, and C18 Notification Engine):

| Event | Payload | Consumers |
|-------|---------|-----------|
| `LESSON_INSTRUCTOR_SIGNED` | `{ lessonId, signatureId, instructorId, studentId }` | C14 (audit), C18 (notify student to sign) |
| `LESSON_COMPLETED` | `{ lessonId, signatureId, instructorId, studentId, signedAt }` | C14 (audit), C12 (process competencies), C18 (notify both parties), C25 (generate bridge form) |
| `SIGNATURE_CHAIN_VIOLATION` | `{ signatureId, expectedHash, actualHash }` | C14 (audit, severity=critical), C19 (admin alert) |

---

## 14. Testing Requirements

### 14.1 Unit Tests

| Test | What to verify |
|------|---------------|
| `computeSignatureRecordHash` | Deterministic output for same input. Different output for any changed field. Genesis handling (`previous_hash = null` → uses `"GENESIS"`). |
| `validateSignatureImage` | Rejects non-PNG. Rejects > 200KB. Rejects > 800×300px. Accepts valid signature PNG. |
| `validateTimestamp` | Rejects > 5 min drift (online). Accepts ≤ 5 min drift. Accepts up to 24h for offline. Rejects > 24h offline. |
| `validateSigningOrder` | Instructor can sign draft lesson. Student cannot sign draft (instructor must go first). Student can sign `pending_student_signature`. Neither can sign `completed`. |
| `isSignatureEmpty` | Detects blank canvas. Accepts canvas with ≥ 100 non-white pixels. |

### 14.2 Integration Tests

| Test | What to verify |
|------|---------------|
| Full dual-signature flow | POST instructor sign → lesson status = `pending_student_signature`. POST student sign → lesson status = `completed`, `signed_at` set. |
| Immutability enforcement | Direct DB UPDATE on signatures row → trigger fires → exception. |
| Hash chain integrity | After 10 sequential signatures, `verifySignatureChain` returns `verified: true, failures: []`. |
| Tamper detection | Manually update a `record_hash` in the DB → `verifySignatureChain` reports that record as a failure. |
| Offline sync | Write to IndexedDB queue → trigger sync → verify signature appears in DB with `offlineSigned: true`. |
| Timestamp rejection | Submit signature with device_timestamp 10 minutes in the future → `TIMESTAMP_IMPLAUSIBLE`. |
| Wrong order | Attempt student signature on `draft` lesson → `WRONG_SIGNING_ORDER`. |
| Duplicate signature | Submit instructor signature twice → second call returns `ALREADY_SIGNED`. |

### 14.3 Test Utilities

```typescript
// tests/fixtures/signature.fixtures.ts

export const validSignatureBase64 = (): string => {
  // 1×1 white PNG — minimal valid PNG for test purposes
  // Replace with a proper 800×300 fixture for dimension tests
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
};

export const makeSignRequest = (overrides: Partial<SignLessonRequest> = {}): SignLessonRequest => ({
  signature_image: validSignatureBase64(),
  device_timestamp: new Date().toISOString(),
  gps_latitude: -35.2809,    // Canberra CBD
  gps_longitude: 149.1300,
  device_info: {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    screenWidth: 390,
    screenHeight: 844,
    devicePixelRatio: 3,
    platform: 'iPhone',
    touchEnabled: true,
    canvasWidth: 800,
    canvasHeight: 300,
    offlineSigned: false,
    deviceTimestamp: new Date().toISOString(),
  },
  ...overrides,
});
```

---

## 15. Drizzle Schema Reference

```typescript
// src/lib/db/schema/signatures.ts

import { pgTable, uuid, text, timestamptz, inet, jsonb, numeric } from 'drizzle-orm/pg-core';

export const signatures = pgTable('signatures', {
  id:             uuid('id').primaryKey().defaultRandom(),
  signer_id:      text('signer_id').notNull(),
  signer_role:    text('signer_role').notNull(),
  document_type:  text('document_type').notNull(),
  document_id:    uuid('document_id').notNull(),
  signature_url:  text('signature_url').notNull(),
  timestamp_utc:  timestamptz('timestamp_utc').notNull().defaultNow(),
  ip_address:     inet('ip_address'),
  user_agent:     text('user_agent'),
  device_info:    jsonb('device_info'),
  gps_latitude:   numeric('gps_latitude', { precision: 10, scale: 7 }),
  gps_longitude:  numeric('gps_longitude', { precision: 10, scale: 7 }),
  previous_hash:  text('previous_hash'),
  record_hash:    text('record_hash').notNull(),
  created_at:     timestamptz('created_at').notNull().defaultNow(),
  // NO updatedAt — immutable table
});

// Note: CHECK constraints (signer_role, document_type) are defined in SQL migration,
// not in Drizzle schema (Drizzle does not generate CHECK constraints from schema).
// Ensure migration 0001_initial_schema.sql includes them.
```

---

## 16. Environment Variables Required

```bash
# Cloudflare R2 (already set from Phase 0 foundation)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_ENDPOINT=https://{account_id}.r2.cloudflarestorage.com

# No new env vars required for this spec — all auth via Clerk (Phase 0)
```

---

## 17. Dependencies to Add

```json
// package.json additions
{
  "dependencies": {
    "sharp": "^0.33.0"
  }
}
```

`sharp` is the only new dependency. It provides fast PNG validation and metadata extraction server-side. It is a native module — Vercel supports it natively in Node.js runtime functions.

---

## 18. Implementation Order

Execute in this sequence to avoid blocking on dependencies:

1. **DB migration** — Add immutability triggers (`signatures_immutable_update`, `signatures_immutable_delete`). Add `CREATE INDEX idx_signatures_created` if not already present.
2. **Hash utilities** — `signature.hash.ts` — pure functions, fully unit testable in isolation.
3. **Image validation** — `signature.validate.ts` — install `sharp`, write unit tests.
4. **R2 storage helpers** — `signature.storage.ts` — upload and presigned URL functions.
5. **GPS capture utility** — `gps.ts` — client-side, no server dependency.
6. **Core service** — `signature.service.ts` — assembles all of the above, add integration tests.
7. **API route handlers** — `sign/route.ts`, `signatures/route.ts`, `verify-chain/route.ts`.
8. **IndexedDB queue + Service Worker** — offline capture and background sync.
9. **Canvas component** — `SignatureCanvas.tsx` — integrate with Instructor Workstation (C11/SPEC-12).
10. **Chain verification admin endpoint** — `verify-chain/route.ts`.
11. **End-to-end test** — full dual-signature flow in Playwright against a Neon branch.

---

*End of SPEC-14: E-Signature Service*
