# SPEC-07: Notification Engine (C18)
### NexDrive Academy — Phase 1 Revenue Engine
**Version:** 1.0  
**Date:** 21 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.12, §5.2, §7.3; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-03 (Booking Engine — event types); SPEC-04 (Payment Engine — event types); SPEC-05 (CRM — event types)  
**Phase:** 1 (Revenue Engine — Weeks 3-6)  
**Estimated Effort:** 6-8 days  

---

## 1. Overview

The Notification Engine is NexDrive Academy's outbound communication hub. Every booking confirmation, lesson reminder, payment receipt, and competency milestone flows through this single component. It receives trigger events from across the platform, resolves the appropriate template and channel(s), dispatches via Twilio (SMS) or Resend (email), tracks delivery status, and respects per-user notification preferences.

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **Single outbound gateway.** All SMS and email across the entire platform goes through the Notification Engine. No component sends directly via Twilio or Resend — they emit events, the Notification Engine sends.
2. **Every send is tracked.** Every outbound notification is written to the `notifications` table with delivery status. No fire-and-forget.
3. **Twilio for SMS, Resend for email.** Both behind adapter interfaces so they can be swapped.
4. **Australian phone format.** All phone numbers stored and sent in E.164 (`+614xxxxxxxx`). The engine validates format before sending.
5. **SMS character awareness.** SMS templates must be ≤160 characters for single-segment delivery. Multi-segment is allowed but logged.
6. **Respect user preferences.** If a user has opted out of a notification type on a given channel, that send is skipped (but still logged as `skipped`).
7. **Retry failed sends.** Up to 3 retries with exponential backoff (30s, 2min, 10min). After final failure, status = `failed`.
8. **Cron-driven reminders.** Booking reminders and package alerts are cron jobs, not event-driven.
9. **Internal API only.** The send endpoint is `POST /api/internal/notifications/send` (🔒 service-to-service). There is a separate admin endpoint for manual sends.
10. **No push notifications in v1.** The `push` channel is defined in the schema but not implemented. SMS and email only.

### 1.2 Notification Lifecycle

```
Trigger (Event or Cron)
     │
     ▼
┌─────────────────────┐
│  Resolve Recipient   │  ← Find phone/email from user ID, contact ID, or explicit address
│  + Check Preferences │  ← Skip if user opted out of this type+channel
└──────────┬──────────┘
           │
     ┌─────▼──────┐
     │  Render     │  ← Interpolate template variables
     │  Template   │  ← SMS: validate ≤160 chars; Email: render HTML
     └─────┬──────┘
           │
     ┌─────▼──────┐
     │  Write to   │  ← notifications table, status='pending'
     │  Database   │
     └─────┬──────┘
           │
     ┌─────▼──────┐
     │  Dispatch   │  ← Twilio SMS or Resend Email
     │  via Adapter│
     └─────┬──────┘
           │
     ┌─────▼──────┐
     │  Update     │  ← status='sent', external_id=SID/ID, sent_at=now
     │  Status     │
     └─────┬──────┘
           │
     ┌─────▼──────┐        ┌──────────────┐
     │  Webhook    │◄───────│ Twilio/Resend│
     │  Callback   │        │ Status Update│
     └─────┬──────┘        └──────────────┘
           │
     ┌─────▼──────┐
     │  Final      │  ← status='delivered' or 'failed' or 'bounced'
     │  Status     │
     └─────────────┘
```

---

## 2. Directory Structure

```
src/
├── lib/
│   └── notifications/
│       ├── types.ts                     # All types, Zod schemas, enums
│       ├── notification.service.ts      # Core send orchestration
│       ├── template.service.ts          # Template rendering (SMS + Email)
│       ├── preference.service.ts        # User notification preferences
│       ├── recipient.service.ts         # Resolve recipient details
│       ├── retry.service.ts             # Retry logic with backoff
│       ├── adapters/
│       │   ├── sms.adapter.ts           # Twilio implementation
│       │   ├── email.adapter.ts         # Resend implementation
│       │   └── types.ts                 # Adapter interfaces
│       ├── templates/
│       │   ├── sms/                     # SMS template strings
│       │   │   └── index.ts
│       │   └── email/                   # Email HTML templates
│       │       ├── base-layout.ts       # Shared wrapper
│       │       └── index.ts
│       ├── event-handlers.ts            # Event bus subscribers
│       └── constants.ts                 # Notification type config
├── app/
│   └── api/
│       ├── internal/
│       │   └── notifications/
│       │       └── send/
│       │           └── route.ts         # POST /api/internal/notifications/send
│       ├── v1/
│       │   ├── me/
│       │   │   └── notification-preferences/
│       │   │       └── route.ts         # GET + PUT preferences
│       │   └── admin/
│       │       └── notifications/
│       │           ├── route.ts         # GET list + POST manual send
│       │           └── [id]/
│       │               └── route.ts     # GET single notification detail
│       ├── webhooks/
│       │   ├── twilio/
│       │   │   └── status/
│       │   │       └── route.ts         # Twilio delivery status callback
│       │   └── resend/
│       │       └── route.ts             # Resend webhook callback
│       └── cron/
│           ├── booking-reminder-24h/
│           │   └── route.ts
│           ├── booking-reminder-2h/
│           │   └── route.ts
│           └── package-low-credits/
│               └── route.ts
└── db/
    └── schema/
        └── notification-preferences.ts  # New table (see §3)
```

---

## 3. Database Additions

### 3.1 Existing Table: `notifications`

Already defined in SPEC-01. No changes needed. Used as-is:

```typescript
// From SPEC-01 (src/db/schema/notifications.ts)
// Fields: id, recipient_id, recipient_contact_id, recipient_phone, recipient_email,
//         channel, notification_type, subject, body, status, external_id,
//         sent_at, delivered_at, failed_reason, triggered_by, related_id,
//         created_at, updated_at
```

### 3.2 New Table: `notification_preferences`

Per-user opt-in/out preferences. Stored per `(user_id, notification_type, channel)` tuple.

```sql
CREATE TABLE notification_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Who
  user_id         TEXT NOT NULL,                      -- Clerk user ID
  
  -- What
  notification_type TEXT NOT NULL,                    -- 'booking_confirmation', etc.
  channel         TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  
  -- Preference
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE (user_id, notification_type, channel)
);

CREATE INDEX idx_notif_pref_user ON notification_preferences(user_id);
```

### 3.3 Drizzle Schema: `src/db/schema/notification-preferences.ts`

```typescript
import {
  pgTable, uuid, text, boolean, timestamp, index, unique,
} from 'drizzle-orm/pg-core';

export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),

  userId: text('user_id').notNull(),

  notificationType: text('notification_type').notNull(),
  channel: text('channel', {
    enum: ['email', 'sms', 'push'],
  }).notNull(),

  enabled: boolean('enabled').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_notif_pref_user').on(table.userId),
  unique('uq_notif_pref').on(table.userId, table.notificationType, table.channel),
]);
```

### 3.4 Migration

Add to SPEC-01's migration pipeline. Migration file: `drizzle/XXXX_add_notification_preferences.sql`.

---

## 4. Types & Schemas

### File: `src/lib/notifications/types.ts`

```typescript
// ============================================================
// NexDrive Academy — Notification Engine Types
// Reference: System Architecture v1.1 §4.2.12
// ============================================================

import { z } from 'zod';

// ─────────────────────────────────────────────
// NOTIFICATION TYPES (all 16 from arch doc)
// ─────────────────────────────────────────────

export const NOTIFICATION_TYPES = [
  'booking_confirmation',
  'booking_reminder_24h',
  'booking_reminder_2h',
  'booking_cancelled',
  'booking_rescheduled',
  'lesson_completed',
  'bridge_form_ready',
  'payment_received',
  'payment_failed',
  'package_purchased',
  'package_low_credits',
  'parent_invitation',
  'callback_scheduled',
  'competency_achieved',
  'certificate_ready',
  'waitlist_available',
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];

export const CHANNELS = ['sms', 'email', 'push'] as const;
export type NotificationChannel = typeof CHANNELS[number];

export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'bounced' | 'skipped';

// ─────────────────────────────────────────────
// CHANNEL ROUTING MAP (from arch doc §4.2.12)
// ─────────────────────────────────────────────

export type ChannelRouting = {
  [K in NotificationType]: {
    sms: boolean;
    email: boolean;
    push: boolean;
  };
};

export const CHANNEL_ROUTING: ChannelRouting = {
  booking_confirmation:   { sms: true,  email: true,  push: false },
  booking_reminder_24h:   { sms: true,  email: false, push: false },
  booking_reminder_2h:    { sms: true,  email: false, push: false },
  booking_cancelled:      { sms: true,  email: true,  push: false },
  booking_rescheduled:    { sms: true,  email: true,  push: false },
  lesson_completed:       { sms: false, email: true,  push: false },
  bridge_form_ready:      { sms: true,  email: true,  push: false },
  payment_received:       { sms: false, email: true,  push: false },
  payment_failed:         { sms: true,  email: true,  push: false },
  package_purchased:      { sms: false, email: true,  push: false },
  package_low_credits:    { sms: true,  email: true,  push: false },
  parent_invitation:      { sms: true,  email: true,  push: false },
  callback_scheduled:     { sms: true,  email: false, push: false },
  competency_achieved:    { sms: false, email: true,  push: false },
  certificate_ready:      { sms: true,  email: true,  push: false },
  waitlist_available:     { sms: true,  email: true,  push: false },
};

// ─────────────────────────────────────────────
// TEMPLATE DATA SHAPES (per notification type)
// ─────────────────────────────────────────────

export interface BookingTemplateData {
  student_name: string;
  instructor_name: string;
  service_name: string;
  date: string;          // "Wednesday, 25 March 2026"
  time: string;          // "10:00 AM"
  duration_minutes: number;
  pickup_location?: string;
  booking_id: string;
}

export interface BookingCancelledData extends BookingTemplateData {
  cancelled_by: string;
  reason?: string;
}

export interface BookingRescheduledData {
  student_name: string;
  old_date: string;
  old_time: string;
  new_date: string;
  new_time: string;
  service_name: string;
  booking_id: string;
}

export interface LessonCompletedData {
  student_name: string;
  date: string;
  duration_minutes: number;
  tasks_covered: string[];   // Task names from lesson
  total_hours_logged: number;
  competencies_completed: number;
  total_competencies: number; // 23
  portal_url: string;
}

export interface BridgeFormData {
  student_name: string;
  parent_name: string;
  lesson_date: string;
  form_url: string;
}

export interface PaymentReceivedData {
  student_name: string;
  amount_display: string;     // "$120.00"
  description: string;        // "1 Hour Learner Lesson" or "10 Lesson Package"
  payment_method: string;     // "Visa •••• 4242"
  invoice_number?: string;
  receipt_url?: string;
}

export interface PaymentFailedData {
  student_name: string;
  amount_display: string;
  description: string;
  retry_url: string;
}

export interface PackagePurchasedData {
  student_name: string;
  package_name: string;
  credits_total: number;
  amount_display: string;
  expires_at?: string;
}

export interface PackageLowCreditsData {
  student_name: string;
  package_name: string;
  credits_remaining: number;
  rebuy_url: string;
}

export interface ParentInvitationData {
  parent_name: string;
  student_name: string;
  invite_url: string;
}

export interface CallbackScheduledData {
  instructor_name: string;   // "Rob"
  caller_name?: string;
  caller_phone: string;
  reason?: string;
  urgency: 'normal' | 'urgent';
}

export interface CompetencyAchievedData {
  student_name: string;
  task_name: string;
  task_number: number;
  competencies_completed: number;
  total_competencies: number;
  portal_url: string;
}

export interface CertificateReadyData {
  student_name: string;
  certificate_number: string;
  portal_url: string;
}

export interface WaitlistAvailableData {
  student_name: string;
  date: string;
  time: string;
  service_name: string;
  booking_url: string;
  expires_in_hours: number;
}

export type NotificationTemplateData =
  | { type: 'booking_confirmation'; data: BookingTemplateData }
  | { type: 'booking_reminder_24h'; data: BookingTemplateData }
  | { type: 'booking_reminder_2h'; data: BookingTemplateData }
  | { type: 'booking_cancelled'; data: BookingCancelledData }
  | { type: 'booking_rescheduled'; data: BookingRescheduledData }
  | { type: 'lesson_completed'; data: LessonCompletedData }
  | { type: 'bridge_form_ready'; data: BridgeFormData }
  | { type: 'payment_received'; data: PaymentReceivedData }
  | { type: 'payment_failed'; data: PaymentFailedData }
  | { type: 'package_purchased'; data: PackagePurchasedData }
  | { type: 'package_low_credits'; data: PackageLowCreditsData }
  | { type: 'parent_invitation'; data: ParentInvitationData }
  | { type: 'callback_scheduled'; data: CallbackScheduledData }
  | { type: 'competency_achieved'; data: CompetencyAchievedData }
  | { type: 'certificate_ready'; data: CertificateReadyData }
  | { type: 'waitlist_available'; data: WaitlistAvailableData };

// ─────────────────────────────────────────────
// SEND REQUEST (internal API + service layer)
// ─────────────────────────────────────────────

export const SendNotificationSchema = z.object({
  // Recipient — at least one required
  recipient_id: z.string().optional(),         // Clerk user ID
  recipient_contact_id: z.string().uuid().optional(),
  recipient_phone: z.string().optional(),
  recipient_email: z.string().email().optional(),

  // What to send
  channel: z.enum(['sms', 'email', 'push']),
  type: z.enum(NOTIFICATION_TYPES),
  data: z.record(z.unknown()),                 // Template data — validated per type

  // Trigger context
  triggered_by: z.string().optional(),         // e.g., 'event:BOOKING_CREATED', 'cron:reminder_24h'
  related_id: z.string().uuid().optional(),    // Linked booking/lesson/payment ID
});

export type SendNotificationInput = z.infer<typeof SendNotificationSchema>;

// ─────────────────────────────────────────────
// NOTIFICATION RESPONSE
// ─────────────────────────────────────────────

export interface NotificationResponse {
  id: string;
  channel: NotificationChannel;
  notification_type: NotificationType;
  status: NotificationStatus;
  recipient_phone?: string;
  recipient_email?: string;
  external_id?: string;
  sent_at?: string;
  delivered_at?: string;
  failed_reason?: string;
  triggered_by?: string;
  related_id?: string;
  created_at: string;
}

// ─────────────────────────────────────────────
// ADMIN MANUAL SEND
// ─────────────────────────────────────────────

export const AdminSendSchema = z.object({
  recipient_phone: z.string().optional(),
  recipient_email: z.string().email().optional(),
  channel: z.enum(['sms', 'email']),
  subject: z.string().optional(),              // Email only
  body: z.string().min(1).max(5000),
}).refine(
  (d) => d.recipient_phone || d.recipient_email,
  { message: 'At least one of recipient_phone or recipient_email is required' }
);

export type AdminSendInput = z.infer<typeof AdminSendSchema>;

// ─────────────────────────────────────────────
// NOTIFICATION PREFERENCES
// ─────────────────────────────────────────────

export const UpdatePreferencesSchema = z.object({
  preferences: z.array(z.object({
    notification_type: z.enum(NOTIFICATION_TYPES),
    channel: z.enum(['sms', 'email']),
    enabled: z.boolean(),
  })),
});

export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesSchema>;

export interface PreferenceResponse {
  notification_type: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
}

// ─────────────────────────────────────────────
// NON-OPTABLE NOTIFICATIONS
// These types CANNOT be opted out of — they are
// legally or operationally required.
// ─────────────────────────────────────────────

export const NON_OPTABLE_TYPES: NotificationType[] = [
  'booking_confirmation',
  'booking_cancelled',
  'booking_rescheduled',
  'payment_received',
  'payment_failed',
  'certificate_ready',
];
```

---

## 5. Adapter Interfaces

### File: `src/lib/notifications/adapters/types.ts`

```typescript
// ============================================================
// NexDrive Academy — Notification Channel Adapter Interfaces
// Build-for-replacement: Twilio and Resend are swappable.
// ============================================================

export interface SmsSendResult {
  success: boolean;
  external_id?: string;        // Twilio Message SID
  segments?: number;           // Number of SMS segments
  error?: string;
}

export interface EmailSendResult {
  success: boolean;
  external_id?: string;        // Resend message ID
  error?: string;
}

export interface SmsAdapter {
  send(to: string, body: string): Promise<SmsSendResult>;
  validatePhoneNumber(phone: string): boolean;
}

export interface EmailAdapter {
  send(params: {
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
  }): Promise<EmailSendResult>;
}
```

### File: `src/lib/notifications/adapters/sms.adapter.ts`

```typescript
// ============================================================
// NexDrive Academy — Twilio SMS Adapter
// Reference: System Architecture v1.1 §1.2 (SMS: Twilio, AU number)
// ============================================================

import twilio from 'twilio';
import type { SmsAdapter, SmsSendResult } from './types';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER!; // AU number, e.g., +61XXXXXXXXX

/**
 * Validate E.164 Australian mobile number.
 * Accepted: +614XXXXXXXX (Australian mobile)
 */
function isValidAuMobile(phone: string): boolean {
  return /^\+614\d{8}$/.test(phone);
}

export const twilioSmsAdapter: SmsAdapter = {
  validatePhoneNumber(phone: string): boolean {
    return isValidAuMobile(phone);
  },

  async send(to: string, body: string): Promise<SmsSendResult> {
    if (!isValidAuMobile(to)) {
      return { success: false, error: `Invalid AU mobile number: ${to}` };
    }

    try {
      const message = await client.messages.create({
        to,
        from: FROM_NUMBER,
        body,
        statusCallback: `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio/status`,
      });

      // Calculate segments (GSM-7: 160 chars/segment, UCS-2: 70 chars/segment)
      const isGsm7 = /^[\x20-\x7E\n\r]+$/.test(body);
      const segmentLimit = isGsm7 ? 160 : 70;
      const segments = Math.ceil(body.length / segmentLimit);

      return {
        success: true,
        external_id: message.sid,
        segments,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown Twilio error';
      console.error('[TWILIO] Send failed:', msg);
      return { success: false, error: msg };
    }
  },
};
```

### File: `src/lib/notifications/adapters/email.adapter.ts`

```typescript
// ============================================================
// NexDrive Academy — Resend Email Adapter
// Reference: System Architecture v1.1 §1.2 (Email: Resend)
// ============================================================

import { Resend } from 'resend';
import type { EmailAdapter, EmailSendResult } from './types';

const resend = new Resend(process.env.RESEND_API_KEY!);

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'NexDrive Academy <hello@nexdriveacademy.com.au>';
const REPLY_TO = process.env.RESEND_REPLY_TO || 'rob@nexdriveacademy.com.au';

export const resendEmailAdapter: EmailAdapter = {
  async send(params: {
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
  }): Promise<EmailSendResult> {
    try {
      const result = await resend.emails.send({
        from: FROM_ADDRESS,
        to: params.to,
        subject: params.subject,
        html: params.html,
        replyTo: params.replyTo || REPLY_TO,
        headers: {
          'X-Entity-Ref-ID': crypto.randomUUID(), // Prevent Gmail threading
        },
      });

      if (result.error) {
        return { success: false, error: result.error.message };
      }

      return {
        success: true,
        external_id: result.data?.id,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown Resend error';
      console.error('[RESEND] Send failed:', msg);
      return { success: false, error: msg };
    }
  },
};
```

---

## 6. SMS Templates

### File: `src/lib/notifications/templates/sms/index.ts`

All SMS templates are ≤160 characters where possible. Templates exceeding 160 chars are annotated with `// MULTI-SEGMENT` and accepted as necessary.

```typescript
// ============================================================
// NexDrive Academy — SMS Templates
// All templates target ≤160 GSM-7 characters (single segment).
// Variables: ${var_name} — interpolated by template.service.ts
// ============================================================

import type { NotificationType } from '../../types';

export const SMS_TEMPLATES: Partial<Record<NotificationType, string>> = {
  // ─── Booking ───────────────────────────────
  booking_confirmation:
    `NexDrive: Lesson confirmed! ${'{date}'} at ${'{time}'} (${'{duration_minutes}'}min ${'{service_name}'}). Reply HELP for info or call Rob.`,
    // ~105 chars with typical data

  booking_reminder_24h:
    `NexDrive reminder: You have a ${'{duration_minutes}'}min lesson tomorrow at ${'{time}'}. See you then! Reply STOP to opt out.`,
    // ~100 chars

  booking_reminder_2h:
    `NexDrive: Your lesson starts at ${'{time}'} today (${'{duration_minutes}'}min). Be ready at your pickup location. See you soon!`,
    // ~105 chars

  booking_cancelled:
    `NexDrive: Your ${'{service_name}'} on ${'{date}'} at ${'{time}'} has been cancelled. To rebook, visit nexdriveacademy.com.au/book`,
    // ~115 chars

  booking_rescheduled:
    `NexDrive: Your lesson has been moved to ${'{new_date}'} at ${'{new_time}'}. Previous: ${'{old_date}'} ${'{old_time}'}. Questions? Reply here.`,
    // ~125 chars

  // ─── Lesson ────────────────────────────────
  bridge_form_ready:
    `NexDrive: Your lesson summary & practice guide is ready! View it here: ${'{form_url}'}`,
    // ~85 chars + URL

  // ─── Payment ───────────────────────────────
  payment_failed:
    `NexDrive: Your payment of ${'{amount_display}'} could not be processed. Please update your payment method: ${'{retry_url}'}`,
    // ~110 chars + URL

  // ─── Package ───────────────────────────────
  package_low_credits:
    `NexDrive: You have ${'{credits_remaining}'} lesson credits remaining. Top up here: ${'{rebuy_url}'}`,
    // ~80 chars + URL

  // ─── Parent ────────────────────────────────
  parent_invitation:
    `Hi ${'{parent_name}'}, ${'{student_name}'} has invited you to NexDrive Academy's parent portal. Get started: ${'{invite_url}'}`,
    // ~115 chars + URL  // MULTI-SEGMENT likely

  // ─── Callback (to instructor Rob) ──────────
  callback_scheduled:
    `NexDrive callback: ${'{caller_name}'} (${'{caller_phone}'}) requested a call. Reason: ${'{reason}'}. Priority: ${'{urgency}'}.`,
    // ~110 chars

  // ─── Certificate ───────────────────────────
  certificate_ready:
    `NexDrive: Congratulations! You've completed all 23 CBT&A tasks! Your certificate is ready: ${'{portal_url}'}`,
    // ~105 chars + URL

  // ─── Waitlist ──────────────────────────────
  waitlist_available:
    `NexDrive: A ${'{service_name}'} slot just opened on ${'{date}'} at ${'{time}'}! Book now before it's gone: ${'{booking_url}'}`,
    // ~115 chars + URL
};
```

---

## 7. Email Templates

### File: `src/lib/notifications/templates/email/base-layout.ts`

```typescript
// ============================================================
// NexDrive Academy — Email Base Layout
// Shared HTML wrapper for all transactional emails.
// Mobile-responsive, NexDrive branded.
// ============================================================

export function emailLayout(params: {
  preheader: string;
  title: string;
  bodyHtml: string;
  footerExtra?: string;
}): string {
  const { preheader, title, bodyHtml, footerExtra = '' } = params;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title}</title>
  <!--[if mso]>
  <style>table{border-collapse:collapse;}td{font-family:Arial,sans-serif;}</style>
  <![endif]-->
  <style>
    body { margin: 0; padding: 0; background-color: #f4f4f7; -webkit-text-size-adjust: 100%; }
    .email-wrapper { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; }
    .header { background-color: #1a1a2e; padding: 24px 32px; text-align: center; }
    .header img { height: 40px; }
    .header h1 { color: #ffffff; font-family: Arial, sans-serif; font-size: 20px; margin: 8px 0 0; }
    .content { padding: 32px; font-family: Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #333333; }
    .content h2 { color: #1a1a2e; font-size: 22px; margin-top: 0; }
    .cta-button { display: inline-block; padding: 14px 28px; background-color: #2563eb; color: #ffffff !important; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; margin: 16px 0; }
    .cta-button:hover { background-color: #1d4ed8; }
    .info-box { background-color: #f0f4ff; border-left: 4px solid #2563eb; padding: 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
    .footer { background-color: #f4f4f7; padding: 24px 32px; text-align: center; font-family: Arial, sans-serif; font-size: 13px; color: #888888; }
    .footer a { color: #2563eb; text-decoration: none; }
    @media only screen and (max-width: 480px) {
      .content { padding: 20px 16px; }
      .header { padding: 16px; }
    }
  </style>
</head>
<body>
  <!-- Preheader (visible in inbox preview, hidden in email) -->
  <div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>
  
  <center>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f4f4f7;padding:16px 0;">
      <tr>
        <td align="center">
          <table class="email-wrapper" role="presentation" cellpadding="0" cellspacing="0" width="600">
            <!-- Header -->
            <tr>
              <td class="header">
                <h1>NexDrive Academy</h1>
              </td>
            </tr>
            <!-- Content -->
            <tr>
              <td class="content">
                ${bodyHtml}
              </td>
            </tr>
            <!-- Footer -->
            <tr>
              <td class="footer">
                ${footerExtra}
                <p style="margin:8px 0;">NexDrive Academy &bull; Canberra, ACT, Australia</p>
                <p style="margin:4px 0;">
                  <a href="https://nexdriveacademy.com.au">Website</a> &bull;
                  <a href="tel:${process.env.NEXDRIVE_PHONE || ''}">Call Rob</a>
                </p>
                <p style="margin:12px 0 0;font-size:11px;color:#aaaaaa;">
                  You received this email because you have an account with NexDrive Academy.
                  <br><a href="https://nexdriveacademy.com.au/notification-preferences" style="color:#aaaaaa;">Manage notification preferences</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>`;
}
```

### File: `src/lib/notifications/templates/email/index.ts`

```typescript
// ============================================================
// NexDrive Academy — Email Templates
// Each function returns { subject, html } for a notification type.
// Variables are passed as typed data objects.
// ============================================================

import { emailLayout } from './base-layout';
import type {
  BookingTemplateData, BookingCancelledData, BookingRescheduledData,
  LessonCompletedData, BridgeFormData,
  PaymentReceivedData, PaymentFailedData,
  PackagePurchasedData, PackageLowCreditsData,
  ParentInvitationData,
  CompetencyAchievedData, CertificateReadyData,
  WaitlistAvailableData,
} from '../../types';

interface EmailTemplate {
  subject: string;
  html: string;
}

// ─── Booking Confirmation ────────────────────

export function bookingConfirmationEmail(data: BookingTemplateData): EmailTemplate {
  return {
    subject: `Lesson Confirmed — ${data.date} at ${data.time}`,
    html: emailLayout({
      preheader: `Your ${data.service_name} with ${data.instructor_name} is confirmed.`,
      title: 'Booking Confirmed',
      bodyHtml: `
        <h2>You're booked in! ✅</h2>
        <div class="info-box">
          <p style="margin:0;"><strong>${data.service_name}</strong></p>
          <p style="margin:4px 0;">📅 ${data.date}</p>
          <p style="margin:4px 0;">🕐 ${data.time} (${data.duration_minutes} minutes)</p>
          <p style="margin:4px 0;">🚗 Instructor: ${data.instructor_name}</p>
          ${data.pickup_location ? `<p style="margin:4px 0;">📍 Pickup: ${data.pickup_location}</p>` : ''}
        </div>
        <p><strong>Before your lesson:</strong></p>
        <p>• Bring your learner licence<br>
           • Wear comfortable shoes suitable for driving<br>
           • Be at the pickup location 5 minutes early</p>
        <p>Need to change or cancel? Please give at least 24 hours notice.</p>
        <a href="https://nexdriveacademy.com.au/bookings/${data.booking_id}" class="cta-button">View Booking Details</a>
      `,
    }),
  };
}

// ─── Booking Cancelled ───────────────────────

export function bookingCancelledEmail(data: BookingCancelledData): EmailTemplate {
  return {
    subject: `Lesson Cancelled — ${data.date}`,
    html: emailLayout({
      preheader: `Your ${data.service_name} on ${data.date} has been cancelled.`,
      title: 'Booking Cancelled',
      bodyHtml: `
        <h2>Booking Cancelled</h2>
        <div class="info-box">
          <p style="margin:0;"><strong>${data.service_name}</strong></p>
          <p style="margin:4px 0;">📅 ${data.date} at ${data.time}</p>
          ${data.reason ? `<p style="margin:4px 0;">Reason: ${data.reason}</p>` : ''}
        </div>
        <p>Want to reschedule? We'd love to get you back on the road.</p>
        <a href="https://nexdriveacademy.com.au/book" class="cta-button">Book New Lesson</a>
      `,
    }),
  };
}

// ─── Booking Rescheduled ─────────────────────

export function bookingRescheduledEmail(data: BookingRescheduledData): EmailTemplate {
  return {
    subject: `Lesson Rescheduled — Now ${data.new_date} at ${data.new_time}`,
    html: emailLayout({
      preheader: `Your lesson has been moved to ${data.new_date} at ${data.new_time}.`,
      title: 'Booking Rescheduled',
      bodyHtml: `
        <h2>Your Lesson Has Been Rescheduled</h2>
        <div class="info-box">
          <p style="margin:0;"><strong>New Time</strong></p>
          <p style="margin:4px 0;">📅 ${data.new_date} at ${data.new_time}</p>
        </div>
        <p style="color:#888888;font-size:14px;">Previously: ${data.old_date} at ${data.old_time}</p>
        <a href="https://nexdriveacademy.com.au/bookings/${data.booking_id}" class="cta-button">View Updated Booking</a>
      `,
    }),
  };
}

// ─── Lesson Completed ────────────────────────

export function lessonCompletedEmail(data: LessonCompletedData): EmailTemplate {
  const tasksHtml = data.tasks_covered.length > 0
    ? `<p><strong>Tasks covered:</strong> ${data.tasks_covered.join(', ')}</p>`
    : '';

  return {
    subject: `Lesson Complete — ${data.competencies_completed}/${data.total_competencies} Tasks`,
    html: emailLayout({
      preheader: `Great work! ${data.competencies_completed} of ${data.total_competencies} competencies achieved.`,
      title: 'Lesson Complete',
      bodyHtml: `
        <h2>Nice driving, ${data.student_name}! 🚗</h2>
        <div class="info-box">
          <p style="margin:0;">📅 ${data.date} &bull; ${data.duration_minutes} minutes</p>
          <p style="margin:4px 0;">📊 Total hours logged: <strong>${data.total_hours_logged}</strong></p>
          <p style="margin:4px 0;">✅ Competencies: <strong>${data.competencies_completed} / ${data.total_competencies}</strong></p>
        </div>
        ${tasksHtml}
        <p>Your detailed lesson summary is available in your portal.</p>
        <a href="${data.portal_url}" class="cta-button">View Progress</a>
      `,
    }),
  };
}

// ─── Bridge Form Ready ───────────────────────

export function bridgeFormReadyEmail(data: BridgeFormData): EmailTemplate {
  return {
    subject: `Practice Guide Ready — ${data.student_name}'s Lesson ${data.lesson_date}`,
    html: emailLayout({
      preheader: `${data.student_name}'s lesson summary and supervised practice guide is ready.`,
      title: 'Bridge Form Ready',
      bodyHtml: `
        <h2>Hi ${data.parent_name},</h2>
        <p>${data.student_name} just completed a driving lesson. Their Lesson Bridge Form is ready — it includes what was covered and tips for supervised practice.</p>
        <a href="${data.form_url}" class="cta-button">View Lesson Summary</a>
        <p style="font-size:14px;color:#666;">This bridges the gap between professional lessons and at-home practice. Using it will help ${data.student_name} progress faster.</p>
      `,
    }),
  };
}

// ─── Payment Received ────────────────────────

export function paymentReceivedEmail(data: PaymentReceivedData): EmailTemplate {
  return {
    subject: `Payment Receipt — ${data.amount_display}`,
    html: emailLayout({
      preheader: `Payment of ${data.amount_display} received for ${data.description}.`,
      title: 'Payment Receipt',
      bodyHtml: `
        <h2>Payment Received ✅</h2>
        <div class="info-box">
          <p style="margin:0;"><strong>${data.description}</strong></p>
          <p style="margin:4px 0;">Amount: <strong>${data.amount_display}</strong></p>
          <p style="margin:4px 0;">Method: ${data.payment_method}</p>
          ${data.invoice_number ? `<p style="margin:4px 0;">Invoice: ${data.invoice_number}</p>` : ''}
        </div>
        ${data.receipt_url ? `<a href="${data.receipt_url}" class="cta-button">Download Receipt</a>` : ''}
        <p style="font-size:13px;color:#888;">NexDrive Academy &bull; ABN: ${process.env.NEXDRIVE_ABN || 'TBC'}</p>
      `,
    }),
  };
}

// ─── Payment Failed ──────────────────────────

export function paymentFailedEmail(data: PaymentFailedData): EmailTemplate {
  return {
    subject: `Payment Failed — Action Required`,
    html: emailLayout({
      preheader: `Your payment of ${data.amount_display} for ${data.description} could not be processed.`,
      title: 'Payment Failed',
      bodyHtml: `
        <h2>Payment Unsuccessful</h2>
        <p>Hi ${data.student_name},</p>
        <p>We weren't able to process your payment of <strong>${data.amount_display}</strong> for <strong>${data.description}</strong>.</p>
        <p>This could be due to insufficient funds, an expired card, or a temporary bank issue.</p>
        <a href="${data.retry_url}" class="cta-button">Update Payment Method</a>
        <p>If you need help, just reply to this email or call Rob.</p>
      `,
    }),
  };
}

// ─── Package Purchased ───────────────────────

export function packagePurchasedEmail(data: PackagePurchasedData): EmailTemplate {
  return {
    subject: `Package Purchased — ${data.package_name}`,
    html: emailLayout({
      preheader: `You now have ${data.credits_total} lesson credits.`,
      title: 'Package Purchased',
      bodyHtml: `
        <h2>Package Activated! 🎉</h2>
        <div class="info-box">
          <p style="margin:0;"><strong>${data.package_name}</strong></p>
          <p style="margin:4px 0;">Credits: <strong>${data.credits_total} lessons</strong></p>
          <p style="margin:4px 0;">Paid: ${data.amount_display}</p>
          ${data.expires_at ? `<p style="margin:4px 0;">Valid until: ${data.expires_at}</p>` : ''}
        </div>
        <p>Your credits will be automatically applied when you book your next lesson.</p>
        <a href="https://nexdriveacademy.com.au/book" class="cta-button">Book a Lesson</a>
      `,
    }),
  };
}

// ─── Package Low Credits ─────────────────────

export function packageLowCreditsEmail(data: PackageLowCreditsData): EmailTemplate {
  return {
    subject: `${data.credits_remaining} Lesson Credits Remaining`,
    html: emailLayout({
      preheader: `You have ${data.credits_remaining} credits left on ${data.package_name}. Top up to keep learning!`,
      title: 'Low Credits',
      bodyHtml: `
        <h2>Heads up, ${data.student_name}!</h2>
        <p>You have <strong>${data.credits_remaining} lesson${data.credits_remaining === 1 ? '' : 's'}</strong> remaining on your <strong>${data.package_name}</strong>.</p>
        <p>Top up now to keep the momentum going!</p>
        <a href="${data.rebuy_url}" class="cta-button">Buy More Lessons</a>
      `,
    }),
  };
}

// ─── Parent Invitation ───────────────────────

export function parentInvitationEmail(data: ParentInvitationData): EmailTemplate {
  return {
    subject: `${data.student_name} has invited you to NexDrive Academy`,
    html: emailLayout({
      preheader: `Track ${data.student_name}'s driving progress, view lesson summaries, and access practice guides.`,
      title: 'Parent Portal Invitation',
      bodyHtml: `
        <h2>Hi ${data.parent_name},</h2>
        <p><strong>${data.student_name}</strong> has invited you to join NexDrive Academy's parent portal.</p>
        <p>With your portal access you can:</p>
        <p>• View lesson summaries and practice guides<br>
           • Track CBT&A competency progress<br>
           • See upcoming lessons and hours logged</p>
        <a href="${data.invite_url}" class="cta-button">Accept Invitation</a>
        <p style="font-size:14px;color:#666;">This link will expire in 7 days.</p>
      `,
    }),
  };
}

// ─── Competency Achieved ─────────────────────

export function competencyAchievedEmail(data: CompetencyAchievedData): EmailTemplate {
  return {
    subject: `Competency Achieved — Task ${data.task_number}: ${data.task_name}`,
    html: emailLayout({
      preheader: `${data.competencies_completed}/${data.total_competencies} CBT&A tasks complete!`,
      title: 'Competency Achieved',
      bodyHtml: `
        <h2>Milestone Unlocked! 🏆</h2>
        <p>Congratulations ${data.student_name}, you've been assessed as competent in:</p>
        <div class="info-box">
          <p style="margin:0;"><strong>Task ${data.task_number}: ${data.task_name}</strong></p>
          <p style="margin:4px 0;">Progress: <strong>${data.competencies_completed} / ${data.total_competencies}</strong> tasks complete</p>
        </div>
        ${data.competencies_completed === data.total_competencies
          ? '<p><strong>🎉 You have completed ALL 23 tasks! Your certificate is being prepared.</strong></p>'
          : `<p>Keep it up — only ${data.total_competencies - data.competencies_completed} more to go!</p>`
        }
        <a href="${data.portal_url}" class="cta-button">View Full Progress</a>
      `,
    }),
  };
}

// ─── Certificate Ready ───────────────────────

export function certificateReadyEmail(data: CertificateReadyData): EmailTemplate {
  return {
    subject: `Congratulations! Your CBT&A Certificate is Ready`,
    html: emailLayout({
      preheader: `All 23 competency tasks complete. Certificate #${data.certificate_number} is ready.`,
      title: 'Certificate Ready',
      bodyHtml: `
        <h2>You Did It! 🎓🚗</h2>
        <p>Congratulations ${data.student_name}!</p>
        <p>You have successfully completed all <strong>23 CBT&A competency tasks</strong>. Your certificate of completion is ready.</p>
        <div class="info-box">
          <p style="margin:0;">Certificate Number: <strong>${data.certificate_number}</strong></p>
        </div>
        <a href="${data.portal_url}" class="cta-button">View Certificate</a>
        <p>This is a huge achievement. Rob and the NexDrive team are proud of you!</p>
      `,
    }),
  };
}

// ─── Waitlist Available ──────────────────────

export function waitlistAvailableEmail(data: WaitlistAvailableData): EmailTemplate {
  return {
    subject: `A Lesson Slot Just Opened Up!`,
    html: emailLayout({
      preheader: `${data.service_name} on ${data.date} at ${data.time} is now available.`,
      title: 'Waitlist Slot Available',
      bodyHtml: `
        <h2>Good News, ${data.student_name}! 🎉</h2>
        <p>A slot you were waiting for just opened up:</p>
        <div class="info-box">
          <p style="margin:0;"><strong>${data.service_name}</strong></p>
          <p style="margin:4px 0;">📅 ${data.date} at ${data.time}</p>
        </div>
        <p><strong>This slot is available for the next ${data.expires_in_hours} hours.</strong> Book now before someone else takes it!</p>
        <a href="${data.booking_url}" class="cta-button">Book This Slot</a>
      `,
    }),
  };
}
```

---

## 8. Template Rendering Service

### File: `src/lib/notifications/template.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Template Rendering Service
// Resolves notification type + data → rendered SMS body or email HTML.
// ============================================================

import { SMS_TEMPLATES } from './templates/sms';
import * as emailTemplates from './templates/email';
import type { NotificationType, NotificationChannel, NotificationTemplateData } from './types';

interface RenderedSms {
  body: string;
  segments: number;
}

interface RenderedEmail {
  subject: string;
  html: string;
}

/**
 * Render an SMS template by interpolating ${variable} placeholders.
 */
export function renderSms(type: NotificationType, data: Record<string, unknown>): RenderedSms {
  const template = SMS_TEMPLATES[type];
  if (!template) {
    throw new Error(`No SMS template for notification type: ${type}`);
  }

  const body = template.replace(/\$\{(\w+)\}/g, (_, key) => {
    const value = data[key];
    return value !== undefined && value !== null ? String(value) : '';
  });

  // Calculate segments (GSM-7: 160, UCS-2: 70)
  const isGsm7 = /^[\x20-\x7E\n\r]*$/.test(body);
  const limit = isGsm7 ? 160 : 70;
  const segments = body.length <= limit ? 1 : Math.ceil(body.length / (isGsm7 ? 153 : 67)); // Multipart uses 153/67

  return { body, segments };
}

/**
 * Render an email template using typed data objects.
 */
export function renderEmail(
  typeAndData: NotificationTemplateData
): RenderedEmail {
  switch (typeAndData.type) {
    case 'booking_confirmation':
    case 'booking_reminder_24h':
    case 'booking_reminder_2h':
      return emailTemplates.bookingConfirmationEmail(typeAndData.data);
    case 'booking_cancelled':
      return emailTemplates.bookingCancelledEmail(typeAndData.data);
    case 'booking_rescheduled':
      return emailTemplates.bookingRescheduledEmail(typeAndData.data);
    case 'lesson_completed':
      return emailTemplates.lessonCompletedEmail(typeAndData.data);
    case 'bridge_form_ready':
      return emailTemplates.bridgeFormReadyEmail(typeAndData.data);
    case 'payment_received':
      return emailTemplates.paymentReceivedEmail(typeAndData.data);
    case 'payment_failed':
      return emailTemplates.paymentFailedEmail(typeAndData.data);
    case 'package_purchased':
      return emailTemplates.packagePurchasedEmail(typeAndData.data);
    case 'package_low_credits':
      return emailTemplates.packageLowCreditsEmail(typeAndData.data);
    case 'parent_invitation':
      return emailTemplates.parentInvitationEmail(typeAndData.data);
    case 'competency_achieved':
      return emailTemplates.competencyAchievedEmail(typeAndData.data);
    case 'certificate_ready':
      return emailTemplates.certificateReadyEmail(typeAndData.data);
    case 'waitlist_available':
      return emailTemplates.waitlistAvailableEmail(typeAndData.data);
    default: {
      const _exhaustive: never = typeAndData;
      throw new Error(`Unknown notification type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Validate SMS character count and warn on multi-segment.
 */
export function analyzeSmsLength(body: string): {
  length: number;
  segments: number;
  encoding: 'GSM-7' | 'UCS-2';
  overSingleSegment: boolean;
} {
  const isGsm7 = /^[\x20-\x7E\n\r]*$/.test(body);
  const encoding = isGsm7 ? 'GSM-7' as const : 'UCS-2' as const;
  const singleLimit = isGsm7 ? 160 : 70;
  const multiLimit = isGsm7 ? 153 : 67;
  const segments = body.length <= singleLimit ? 1 : Math.ceil(body.length / multiLimit);

  return {
    length: body.length,
    segments,
    encoding,
    overSingleSegment: segments > 1,
  };
}
```

---

## 9. Recipient Resolution Service

### File: `src/lib/notifications/recipient.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Recipient Resolution
// Given a user ID, contact ID, or explicit address, resolve
// the phone number and/or email for sending.
// ============================================================

import { db } from '@/db';
import { profiles, contacts } from '@/db/schema';
import { eq } from 'drizzle-orm';

export interface ResolvedRecipient {
  user_id?: string;
  contact_id?: string;
  phone?: string;
  email?: string;
  name?: string;
}

/**
 * Resolve recipient details from available identifiers.
 * Priority: explicit address > user profile > contact record.
 */
export async function resolveRecipient(params: {
  recipient_id?: string;
  recipient_contact_id?: string;
  recipient_phone?: string;
  recipient_email?: string;
}): Promise<ResolvedRecipient> {
  const result: ResolvedRecipient = {
    phone: params.recipient_phone,
    email: params.recipient_email,
  };

  // If we have a Clerk user ID, look up their profile
  if (params.recipient_id) {
    result.user_id = params.recipient_id;

    const [profile] = await db
      .select({
        phone: profiles.phone,
        email: profiles.email,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
      })
      .from(profiles)
      .where(eq(profiles.clerkUserId, params.recipient_id))
      .limit(1);

    if (profile) {
      result.phone = result.phone || profile.phone || undefined;
      result.email = result.email || profile.email || undefined;
      result.name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || undefined;
    }
  }

  // If we have a contact ID, look up the contact
  if (params.recipient_contact_id) {
    result.contact_id = params.recipient_contact_id;

    const [contact] = await db
      .select({
        phone: contacts.phone,
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
      })
      .from(contacts)
      .where(eq(contacts.id, params.recipient_contact_id))
      .limit(1);

    if (contact) {
      result.phone = result.phone || contact.phone || undefined;
      result.email = result.email || contact.email || undefined;
      result.name = result.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || undefined;
    }
  }

  return result;
}
```

---

## 10. Notification Preferences Service

### File: `src/lib/notifications/preference.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Notification Preference Service
// Per-user opt-in/out per notification type per channel.
// ============================================================

import { db } from '@/db';
import { notificationPreferences } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import type {
  NotificationType, NotificationChannel,
  UpdatePreferencesInput, PreferenceResponse,
  NON_OPTABLE_TYPES,
} from './types';
import { NON_OPTABLE_TYPES as NON_OPTABLE } from './types';

/**
 * Check if a notification is enabled for a user on a given channel.
 * 
 * Rules:
 * 1. Non-optable types always return true (booking confirmation, etc.)
 * 2. If no preference record exists, default is ENABLED.
 * 3. Only returns false if user has explicitly opted out.
 */
export async function isNotificationEnabled(
  userId: string,
  type: NotificationType,
  channel: NotificationChannel
): Promise<boolean> {
  // Non-optable types cannot be disabled
  if (NON_OPTABLE.includes(type)) {
    return true;
  }

  const [pref] = await db
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(and(
      eq(notificationPreferences.userId, userId),
      eq(notificationPreferences.notificationType, type),
      eq(notificationPreferences.channel, channel),
    ))
    .limit(1);

  // Default: enabled (no record = opted in)
  return pref?.enabled ?? true;
}

/**
 * Get all notification preferences for a user.
 * Returns only explicitly set preferences; unset = default enabled.
 */
export async function getPreferences(userId: string): Promise<PreferenceResponse[]> {
  const prefs = await db
    .select({
      notification_type: notificationPreferences.notificationType,
      channel: notificationPreferences.channel,
      enabled: notificationPreferences.enabled,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  return prefs.map(p => ({
    notification_type: p.notification_type as NotificationType,
    channel: p.channel as NotificationChannel,
    enabled: p.enabled,
  }));
}

/**
 * Update notification preferences for a user.
 * Upserts preferences — creates if not exists, updates if exists.
 * Rejects attempts to disable non-optable types.
 */
export async function updatePreferences(
  userId: string,
  input: UpdatePreferencesInput
): Promise<PreferenceResponse[]> {
  const results: PreferenceResponse[] = [];

  for (const pref of input.preferences) {
    // Block disabling non-optable types
    if (!pref.enabled && NON_OPTABLE.includes(pref.notification_type as NotificationType)) {
      throw new Error(`Cannot disable ${pref.notification_type} notifications — these are required.`);
    }

    await db
      .insert(notificationPreferences)
      .values({
        userId,
        notificationType: pref.notification_type,
        channel: pref.channel,
        enabled: pref.enabled,
      })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.userId,
          notificationPreferences.notificationType,
          notificationPreferences.channel,
        ],
        set: {
          enabled: pref.enabled,
          updatedAt: new Date(),
        },
      });

    results.push({
      notification_type: pref.notification_type as NotificationType,
      channel: pref.channel as NotificationChannel,
      enabled: pref.enabled,
    });
  }

  return results;
}
```

---

## 11. Core Notification Service

### File: `src/lib/notifications/notification.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Core Notification Service
// Orchestrates: resolve recipient → check preferences →
//               render template → write DB → dispatch → update status
// ============================================================

import { db } from '@/db';
import { notifications } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { resolveRecipient } from './recipient.service';
import { isNotificationEnabled } from './preference.service';
import { renderSms, renderEmail, analyzeSmsLength } from './template.service';
import { twilioSmsAdapter } from './adapters/sms.adapter';
import { resendEmailAdapter } from './adapters/email.adapter';
import { scheduleRetry } from './retry.service';
import type {
  SendNotificationInput, NotificationResponse,
  NotificationType, NotificationChannel,
  CHANNEL_ROUTING, NotificationTemplateData,
} from './types';
import { CHANNEL_ROUTING as routing } from './types';

/**
 * Send a single notification on a single channel.
 * Called by dispatchNotification() for each active channel.
 */
async function sendSingle(input: SendNotificationInput): Promise<NotificationResponse> {
  const { channel, type, data, triggered_by, related_id } = input;

  // 1. Resolve recipient
  const recipient = await resolveRecipient({
    recipient_id: input.recipient_id,
    recipient_contact_id: input.recipient_contact_id,
    recipient_phone: input.recipient_phone,
    recipient_email: input.recipient_email,
  });

  // 2. Validate we have the right address for this channel
  if (channel === 'sms' && !recipient.phone) {
    console.warn(`[NOTIFY] No phone number for SMS notification ${type}`);
    return createSkippedRecord(type, channel, 'No phone number available', triggered_by, related_id);
  }
  if (channel === 'email' && !recipient.email) {
    console.warn(`[NOTIFY] No email address for email notification ${type}`);
    return createSkippedRecord(type, channel, 'No email address available', triggered_by, related_id);
  }

  // 3. Check user preferences (only if we have a user_id)
  if (recipient.user_id) {
    const enabled = await isNotificationEnabled(recipient.user_id, type, channel);
    if (!enabled) {
      console.log(`[NOTIFY] User ${recipient.user_id} opted out of ${type}/${channel}`);
      return createSkippedRecord(type, channel, 'User opted out', triggered_by, related_id, recipient);
    }
  }

  // 4. Render template
  let subject: string | undefined;
  let body: string;

  if (channel === 'sms') {
    const rendered = renderSms(type, data as Record<string, unknown>);
    body = rendered.body;

    const analysis = analyzeSmsLength(body);
    if (analysis.overSingleSegment) {
      console.warn(`[NOTIFY] SMS for ${type} is ${analysis.segments} segments (${analysis.length} chars, ${analysis.encoding})`);
    }
  } else if (channel === 'email') {
    // Inject student_name if available and not in data
    const emailData = { ...data, student_name: (data as Record<string, unknown>).student_name || recipient.name || 'there' };
    const rendered = renderEmail({ type, data: emailData } as NotificationTemplateData);
    subject = rendered.subject;
    body = rendered.html;
  } else {
    // Push not implemented in v1
    return createSkippedRecord(type, channel, 'Push not implemented in v1', triggered_by, related_id, recipient);
  }

  // 5. Write pending record to database
  const [record] = await db
    .insert(notifications)
    .values({
      recipientId: recipient.user_id || null,
      recipientContactId: recipient.contact_id || null,
      recipientPhone: recipient.phone || null,
      recipientEmail: recipient.email || null,
      channel,
      notificationType: type,
      subject: subject || null,
      body: channel === 'sms' ? body : `[HTML email — ${subject}]`, // Store email subject ref, not full HTML
      status: 'pending',
      triggeredBy: triggered_by || null,
      relatedId: related_id || null,
    })
    .returning();

  // 6. Dispatch
  try {
    if (channel === 'sms') {
      const result = await twilioSmsAdapter.send(recipient.phone!, body);

      if (result.success) {
        await db
          .update(notifications)
          .set({
            status: 'sent',
            externalId: result.external_id || null,
            sentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(notifications.id, record.id));

        return { ...mapToResponse(record), status: 'sent', external_id: result.external_id };
      } else {
        await handleSendFailure(record.id, result.error || 'Unknown SMS error', type, channel, input);
        return { ...mapToResponse(record), status: 'failed', failed_reason: result.error };
      }
    } else {
      // Email
      const result = await resendEmailAdapter.send({
        to: recipient.email!,
        subject: subject!,
        html: body,
      });

      if (result.success) {
        await db
          .update(notifications)
          .set({
            status: 'sent',
            externalId: result.external_id || null,
            sentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(notifications.id, record.id));

        return { ...mapToResponse(record), status: 'sent', external_id: result.external_id };
      } else {
        await handleSendFailure(record.id, result.error || 'Unknown email error', type, channel, input);
        return { ...mapToResponse(record), status: 'failed', failed_reason: result.error };
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Dispatch error';
    await handleSendFailure(record.id, msg, type, channel, input);
    return { ...mapToResponse(record), status: 'failed', failed_reason: msg };
  }
}

/**
 * Handle a send failure: update DB + schedule retry.
 */
async function handleSendFailure(
  notificationId: string,
  reason: string,
  type: NotificationType,
  channel: NotificationChannel,
  originalInput: SendNotificationInput
): Promise<void> {
  await db
    .update(notifications)
    .set({
      status: 'failed',
      failedReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(notifications.id, notificationId));

  // Schedule retry (up to 3 attempts)
  await scheduleRetry(notificationId, originalInput);
}

/**
 * Dispatch a notification across all configured channels for its type.
 * E.g., booking_confirmation sends both SMS and email.
 */
export async function dispatchNotification(
  type: NotificationType,
  data: Record<string, unknown>,
  recipient: {
    recipient_id?: string;
    recipient_contact_id?: string;
    recipient_phone?: string;
    recipient_email?: string;
  },
  context: {
    triggered_by: string;
    related_id?: string;
  }
): Promise<NotificationResponse[]> {
  const channelConfig = routing[type];
  const results: NotificationResponse[] = [];

  for (const channel of ['sms', 'email'] as const) {
    if (!channelConfig[channel]) continue;

    const result = await sendSingle({
      ...recipient,
      channel,
      type,
      data,
      triggered_by: context.triggered_by,
      related_id: context.related_id,
    });

    results.push(result);
  }

  return results;
}

// ─── Helpers ─────────────────────────────────

async function createSkippedRecord(
  type: NotificationType,
  channel: NotificationChannel,
  reason: string,
  triggeredBy?: string,
  relatedId?: string,
  recipient?: { user_id?: string; contact_id?: string; phone?: string; email?: string }
): Promise<NotificationResponse> {
  const [record] = await db
    .insert(notifications)
    .values({
      recipientId: recipient?.user_id || null,
      recipientContactId: recipient?.contact_id || null,
      recipientPhone: recipient?.phone || null,
      recipientEmail: recipient?.email || null,
      channel,
      notificationType: type,
      body: `[SKIPPED] ${reason}`,
      status: 'failed', // We use 'failed' since 'skipped' isn't in the schema enum
      failedReason: reason,
      triggeredBy: triggeredBy || null,
      relatedId: relatedId || null,
    })
    .returning();

  return mapToResponse(record);
}

function mapToResponse(record: typeof notifications.$inferSelect): NotificationResponse {
  return {
    id: record.id,
    channel: record.channel as NotificationChannel,
    notification_type: record.notificationType as NotificationType,
    status: record.status as any,
    recipient_phone: record.recipientPhone || undefined,
    recipient_email: record.recipientEmail || undefined,
    external_id: record.externalId || undefined,
    sent_at: record.sentAt?.toISOString(),
    delivered_at: record.deliveredAt?.toISOString(),
    failed_reason: record.failedReason || undefined,
    triggered_by: record.triggeredBy || undefined,
    related_id: record.relatedId || undefined,
    created_at: record.createdAt.toISOString(),
  };
}
```

---

## 12. Retry Service

### File: `src/lib/notifications/retry.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Notification Retry Service
// Exponential backoff: 30s → 2min → 10min. Max 3 retries.
// Uses Upstash Redis for delayed scheduling.
// ============================================================

import { Redis } from '@upstash/redis';
import type { SendNotificationInput } from './types';

const redis = Redis.fromEnv();

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000]; // 30s, 2min, 10min
const MAX_RETRIES = 3;
const RETRY_KEY_PREFIX = 'notif:retry:';

interface RetryPayload {
  notification_id: string;
  input: SendNotificationInput;
  attempt: number;
  scheduled_at: number;
}

/**
 * Schedule a retry for a failed notification.
 * 
 * In v1, retries are checked by a background process (cron or in-process timer).
 * At scale, replace with BullMQ delayed jobs.
 */
export async function scheduleRetry(
  notificationId: string,
  input: SendNotificationInput
): Promise<boolean> {
  // Check current attempt count
  const existingKey = `${RETRY_KEY_PREFIX}${notificationId}`;
  const existing = await redis.get<RetryPayload>(existingKey);
  const attempt = existing ? existing.attempt + 1 : 1;

  if (attempt > MAX_RETRIES) {
    console.log(`[RETRY] Max retries (${MAX_RETRIES}) reached for notification ${notificationId}`);
    return false;
  }

  const delayMs = RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const scheduledAt = Date.now() + delayMs;

  const payload: RetryPayload = {
    notification_id: notificationId,
    input,
    attempt,
    scheduled_at: scheduledAt,
  };

  // Store with TTL slightly longer than the delay
  await redis.set(existingKey, payload, {
    px: delayMs + 60_000, // Expires 1 minute after scheduled retry
  });

  console.log(`[RETRY] Scheduled attempt ${attempt}/${MAX_RETRIES} for ${notificationId} in ${delayMs / 1000}s`);
  return true;
}

/**
 * Get all pending retries that are due now.
 * Called by the retry processor (in-process or cron).
 */
export async function getDueRetries(): Promise<RetryPayload[]> {
  const keys = await redis.keys(`${RETRY_KEY_PREFIX}*`);
  const due: RetryPayload[] = [];

  for (const key of keys) {
    const payload = await redis.get<RetryPayload>(key);
    if (payload && payload.scheduled_at <= Date.now()) {
      due.push(payload);
      await redis.del(key); // Remove from queue
    }
  }

  return due;
}

/**
 * Get retry info for a notification.
 */
export async function getRetryStatus(notificationId: string): Promise<{
  attempt: number;
  max_retries: number;
  next_retry_at?: string;
} | null> {
  const payload = await redis.get<RetryPayload>(`${RETRY_KEY_PREFIX}${notificationId}`);
  if (!payload) return null;

  return {
    attempt: payload.attempt,
    max_retries: MAX_RETRIES,
    next_retry_at: new Date(payload.scheduled_at).toISOString(),
  };
}
```

---

## 13. Event Handlers (Event Bus Subscribers)

### File: `src/lib/notifications/event-handlers.ts`

```typescript
// ============================================================
// NexDrive Academy — Notification Event Handlers
// Subscribes to AppEvents and triggers notification dispatch.
// Reference: System Architecture v1.1 §5.2 Event Subscriptions
// ============================================================

import { eventBus } from '@/lib/events';
import { dispatchNotification } from './notification.service';
import { formatDateAEST, formatTimeAEST } from '@/lib/utils/date';

/**
 * Register all notification event listeners.
 * Called once at application startup (instrumentation.ts or layout bootstrap).
 */
export function registerNotificationEventListeners(): void {

  // ─── BOOKING_CREATED → booking_confirmation (SMS + Email) ───
  eventBus.on('BOOKING_CREATED', async (data) => {
    await dispatchNotification(
      'booking_confirmation',
      {
        student_name: data.student_name || 'there',
        instructor_name: data.instructor_name || 'your instructor',
        service_name: data.service_name,
        date: formatDateAEST(data.scheduled_date),
        time: formatTimeAEST(data.start_time),
        duration_minutes: data.duration_minutes,
        pickup_location: data.pickup_location,
        booking_id: data.id,
      },
      {
        recipient_id: data.student_clerk_id,
        recipient_contact_id: data.contact_id,
        recipient_phone: data.student_phone,
        recipient_email: data.student_email,
      },
      {
        triggered_by: 'event:BOOKING_CREATED',
        related_id: data.id,
      }
    );
  });

  // ─── BOOKING_CANCELLED → booking_cancelled (SMS + Email) ───
  eventBus.on('BOOKING_CANCELLED', async (data) => {
    await dispatchNotification(
      'booking_cancelled',
      {
        student_name: data.student_name || 'there',
        instructor_name: data.instructor_name || 'your instructor',
        service_name: data.service_name,
        date: formatDateAEST(data.scheduled_date),
        time: formatTimeAEST(data.start_time),
        duration_minutes: data.duration_minutes,
        booking_id: data.id,
        cancelled_by: data.cancelled_by,
        reason: data.reason,
      },
      {
        recipient_id: data.student_clerk_id,
        recipient_contact_id: data.contact_id,
        recipient_phone: data.student_phone,
        recipient_email: data.student_email,
      },
      {
        triggered_by: 'event:BOOKING_CANCELLED',
        related_id: data.id,
      }
    );
  });

  // ─── BOOKING_RESCHEDULED → booking_rescheduled (SMS + Email) ───
  eventBus.on('BOOKING_RESCHEDULED', async (data) => {
    await dispatchNotification(
      'booking_rescheduled',
      {
        student_name: data.new_booking.student_name || 'there',
        old_date: formatDateAEST(data.old_booking.scheduled_date),
        old_time: formatTimeAEST(data.old_booking.start_time),
        new_date: formatDateAEST(data.new_booking.scheduled_date),
        new_time: formatTimeAEST(data.new_booking.start_time),
        service_name: data.new_booking.service_name,
        booking_id: data.new_booking.id,
      },
      {
        recipient_id: data.new_booking.student_clerk_id,
        recipient_contact_id: data.new_booking.contact_id,
        recipient_phone: data.new_booking.student_phone,
        recipient_email: data.new_booking.student_email,
      },
      {
        triggered_by: 'event:BOOKING_RESCHEDULED',
        related_id: data.new_booking.id,
      }
    );
  });

  // ─── LESSON_COMPLETED → lesson_completed (Email) ───
  eventBus.on('LESSON_COMPLETED', async (data: any) => {
    await dispatchNotification(
      'lesson_completed',
      {
        student_name: data.student_name,
        date: formatDateAEST(data.lesson_date),
        duration_minutes: data.duration_minutes,
        tasks_covered: data.tasks_covered || [],
        total_hours_logged: data.total_hours_logged,
        competencies_completed: data.competencies_completed,
        total_competencies: 23,
        portal_url: `${process.env.NEXT_PUBLIC_APP_URL}/portal/progress`,
      },
      {
        recipient_id: data.student_clerk_id,
        recipient_email: data.student_email,
      },
      {
        triggered_by: 'event:LESSON_COMPLETED',
        related_id: data.lesson_id,
      }
    );
  });

  // ─── COMPETENCY_ACHIEVED → competency_achieved (Email) ───
  eventBus.on('COMPETENCY_ACHIEVED', async (data: any) => {
    await dispatchNotification(
      'competency_achieved',
      {
        student_name: data.student_name,
        task_name: data.task_name,
        task_number: data.task_number,
        competencies_completed: data.competencies_completed,
        total_competencies: 23,
        portal_url: `${process.env.NEXT_PUBLIC_APP_URL}/portal/progress`,
      },
      {
        recipient_id: data.student_clerk_id,
        recipient_email: data.student_email,
      },
      {
        triggered_by: 'event:COMPETENCY_ACHIEVED',
        related_id: data.student_competency_id,
      }
    );
  });

  // ─── PAYMENT_RECEIVED → payment_received (Email) ───
  eventBus.on('PAYMENT_RECEIVED', async (data: any) => {
    await dispatchNotification(
      'payment_received',
      {
        student_name: data.student_name,
        amount_display: data.amount_display,
        description: data.description,
        payment_method: data.payment_method,
        invoice_number: data.invoice_number,
        receipt_url: data.receipt_url,
      },
      {
        recipient_id: data.student_clerk_id,
        recipient_email: data.student_email,
      },
      {
        triggered_by: 'event:PAYMENT_RECEIVED',
        related_id: data.payment_id,
      }
    );
  });

  // ─── CALLBACK_REQUESTED → callback_scheduled (SMS to Rob) ───
  eventBus.on('CALLBACK_REQUESTED', async (data: any) => {
    await dispatchNotification(
      'callback_scheduled',
      {
        instructor_name: 'Rob',
        caller_name: data.caller_name,
        caller_phone: data.caller_phone,
        reason: data.reason,
        urgency: data.urgency || 'normal',
      },
      {
        // Send to Rob (instructor), not the caller
        recipient_phone: process.env.ROB_MOBILE_NUMBER,
        recipient_email: process.env.NEXDRIVE_EMAIL,
      },
      {
        triggered_by: 'event:CALLBACK_REQUESTED',
        related_id: data.call_log_id,
      }
    );
  });

  // ─── CERTIFICATE_ISSUED → certificate_ready (SMS + Email) ───
  eventBus.on('CERTIFICATE_ISSUED', async (data: any) => {
    await dispatchNotification(
      'certificate_ready',
      {
        student_name: data.student_name,
        certificate_number: data.certificate_number,
        portal_url: `${process.env.NEXT_PUBLIC_APP_URL}/portal/certificate`,
      },
      {
        recipient_id: data.student_clerk_id,
        recipient_phone: data.student_phone,
        recipient_email: data.student_email,
      },
      {
        triggered_by: 'event:CERTIFICATE_ISSUED',
      }
    );
  });

  // ─── CONTACT_CREATED → no auto-notification in v1 ───
  // Future: welcome SMS/email for web leads.
  // For now, CRM handles this via lifecycle transitions.

  console.log('[NOTIFY] All notification event listeners registered');
}
```

---

## 14. API Routes

### 14.1 Internal Send Endpoint

### File: `src/app/api/internal/notifications/send/route.ts`

```typescript
// ============================================================
// POST /api/internal/notifications/send
// Internal service-to-service notification dispatch.
// Auth: Service-to-service token (INTERNAL_API_SECRET).
// Reference: Architecture v1.1 §4.2.12
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { SendNotificationSchema } from '@/lib/notifications/types';
import { dispatchNotification } from '@/lib/notifications/notification.service';

export async function POST(request: NextRequest) {
  // Verify internal API secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Invalid internal API key' } },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const input = SendNotificationSchema.parse(body);

    const results = await dispatchNotification(
      input.type,
      input.data as Record<string, unknown>,
      {
        recipient_id: input.recipient_id,
        recipient_contact_id: input.recipient_contact_id,
        recipient_phone: input.recipient_phone,
        recipient_email: input.recipient_email,
      },
      {
        triggered_by: input.triggered_by || 'api:internal',
        related_id: input.related_id,
      }
    );

    return NextResponse.json({ data: results });
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[INTERNAL:NOTIFY] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 14.2 Admin Notification Endpoints

### File: `src/app/api/v1/admin/notifications/route.ts`

```typescript
// ============================================================
// GET  /api/v1/admin/notifications  → List all notifications (paginated)
// POST /api/v1/admin/notifications/send → Admin manual send
// Auth: 👑 admin/instructor only
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';
import { db } from '@/db';
import { notifications } from '@/db/schema';
import { desc, eq, and, sql } from 'drizzle-orm';
import { AdminSendSchema } from '@/lib/notifications/types';
import { twilioSmsAdapter } from '@/lib/notifications/adapters/sms.adapter';
import { resendEmailAdapter } from '@/lib/notifications/adapters/email.adapter';

// GET: List notifications with filtering
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    requireRole(auth, ['instructor']);

    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
    const status = url.searchParams.get('status');
    const type = url.searchParams.get('type');
    const channel = url.searchParams.get('channel');

    const conditions = [];
    if (status) conditions.push(eq(notifications.status, status));
    if (type) conditions.push(eq(notifications.notificationType, type));
    if (channel) conditions.push(eq(notifications.channel, channel));
    if (cursor) conditions.push(sql`${notifications.createdAt} < ${cursor}`);

    const results = await db
      .select()
      .from(notifications)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(notifications.createdAt))
      .limit(limit + 1);

    const hasMore = results.length > limit;
    const data = results.slice(0, limit);

    return NextResponse.json({
      data,
      meta: {
        cursor: hasMore ? data[data.length - 1].createdAt.toISOString() : null,
        has_more: hasMore,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[ADMIN:NOTIFICATIONS] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}

// POST: Admin manual send (freeform SMS or email)
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    requireRole(auth, ['instructor']);

    const body = await request.json();
    const input = AdminSendSchema.parse(body);

    // Write notification record
    const [record] = await db
      .insert(notifications)
      .values({
        recipientPhone: input.recipient_phone || null,
        recipientEmail: input.recipient_email || null,
        channel: input.channel,
        notificationType: 'admin_manual',
        subject: input.subject || null,
        body: input.body,
        status: 'pending',
        triggeredBy: `admin:${auth.clerkUserId}`,
      })
      .returning();

    // Dispatch
    let externalId: string | undefined;
    let error: string | undefined;

    if (input.channel === 'sms' && input.recipient_phone) {
      const result = await twilioSmsAdapter.send(input.recipient_phone, input.body);
      externalId = result.external_id;
      error = result.error;
    } else if (input.channel === 'email' && input.recipient_email) {
      const result = await resendEmailAdapter.send({
        to: input.recipient_email,
        subject: input.subject || 'Message from NexDrive Academy',
        html: `<div style="font-family:Arial,sans-serif;padding:20px;"><p>${input.body.replace(/\n/g, '<br>')}</p><br><p>— NexDrive Academy</p></div>`,
      });
      externalId = result.external_id;
      error = result.error;
    }

    const newStatus = error ? 'failed' : 'sent';
    await db
      .update(notifications)
      .set({
        status: newStatus,
        externalId: externalId || null,
        sentAt: error ? null : new Date(),
        failedReason: error || null,
        updatedAt: new Date(),
      })
      .where(eq(notifications.id, record.id));

    return NextResponse.json({
      data: { id: record.id, status: newStatus, external_id: externalId, error },
    });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[ADMIN:NOTIFICATIONS:SEND] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 14.3 User Notification Preferences

### File: `src/app/api/v1/me/notification-preferences/route.ts`

```typescript
// ============================================================
// GET  /api/v1/me/notification-preferences  → Get my preferences
// PUT  /api/v1/me/notification-preferences  → Update my preferences
// Auth: 🔐 Any authenticated user
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { ApiError } from '@/lib/auth/errors';
import { getPreferences, updatePreferences } from '@/lib/notifications/preference.service';
import { UpdatePreferencesSchema, NOTIFICATION_TYPES, CHANNEL_ROUTING, NON_OPTABLE_TYPES } from '@/lib/notifications/types';

export async function GET() {
  try {
    const auth = await getAuthContext();
    const prefs = await getPreferences(auth.clerkUserId);

    // Build full preference matrix with defaults
    const matrix = NOTIFICATION_TYPES.map(type => ({
      notification_type: type,
      channels: {
        sms: {
          available: CHANNEL_ROUTING[type].sms,
          enabled: prefs.find(p => p.notification_type === type && p.channel === 'sms')?.enabled ?? true,
          required: NON_OPTABLE_TYPES.includes(type),
        },
        email: {
          available: CHANNEL_ROUTING[type].email,
          enabled: prefs.find(p => p.notification_type === type && p.channel === 'email')?.enabled ?? true,
          required: NON_OPTABLE_TYPES.includes(type),
        },
      },
    }));

    return NextResponse.json({ data: matrix });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[ME:NOTIF_PREFS] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    const body = await request.json();
    const input = UpdatePreferencesSchema.parse(body);

    const results = await updatePreferences(auth.clerkUserId, input);
    return NextResponse.json({ data: results });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.message.includes('Cannot disable')) {
      return NextResponse.json(
        { error: { code: 'PREFERENCE_LOCKED', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[ME:NOTIF_PREFS:UPDATE] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

---

## 15. Webhook Endpoints (Delivery Status)

### 15.1 Twilio Status Callback

### File: `src/app/api/webhooks/twilio/status/route.ts`

```typescript
// ============================================================
// POST /api/webhooks/twilio/status
// Twilio SMS delivery status callback.
// Updates notification record with delivery/failure status.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { db } from '@/db';
import { notifications } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  // Verify Twilio signature
  const signature = request.headers.get('x-twilio-signature') || '';
  const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio/status`;
  const body = await request.formData();
  const params: Record<string, string> = {};
  body.forEach((value, key) => { params[key] = value.toString(); });

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN!,
    signature,
    url,
    params
  );

  if (!isValid) {
    console.warn('[TWILIO:WEBHOOK] Invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
  }

  const messageSid = params.MessageSid;
  const messageStatus = params.MessageStatus; // 'sent', 'delivered', 'undelivered', 'failed'

  if (!messageSid) {
    return NextResponse.json({ error: 'Missing MessageSid' }, { status: 400 });
  }

  // Map Twilio status to our status
  const statusMap: Record<string, string> = {
    sent: 'sent',
    delivered: 'delivered',
    undelivered: 'failed',
    failed: 'failed',
  };

  const newStatus = statusMap[messageStatus] || 'sent';

  await db
    .update(notifications)
    .set({
      status: newStatus,
      ...(newStatus === 'delivered' ? { deliveredAt: new Date() } : {}),
      ...(newStatus === 'failed' ? { failedReason: `Twilio: ${messageStatus} - ${params.ErrorCode || 'unknown'}` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(notifications.externalId, messageSid));

  return NextResponse.json({ received: true });
}
```

### 15.2 Resend Webhook

### File: `src/app/api/webhooks/resend/route.ts`

```typescript
// ============================================================
// POST /api/webhooks/resend
// Resend email delivery webhook.
// Events: email.sent, email.delivered, email.bounced, email.complained
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db';
import { notifications } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  const body = await request.text();

  // Verify webhook signature
  const signature = request.headers.get('svix-signature') || '';
  const timestamp = request.headers.get('svix-timestamp') || '';
  const svixId = request.headers.get('svix-id') || '';

  const secret = process.env.RESEND_WEBHOOK_SECRET!;
  const signedContent = `${svixId}.${timestamp}.${body}`;
  const secretBytes = Buffer.from(secret.split('_')[1], 'base64');
  const expectedSignature = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  const signatures = signature.split(' ').map(s => s.split(',')[1]);
  const isValid = signatures.some(s => s === expectedSignature);

  if (!isValid) {
    console.warn('[RESEND:WEBHOOK] Invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
  }

  const event = JSON.parse(body);
  const emailId = event.data?.email_id;

  if (!emailId) {
    return NextResponse.json({ received: true }); // Non-relevant event
  }

  const statusMap: Record<string, string> = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.bounced': 'bounced',
    'email.complained': 'bounced',
    'email.delivery_delayed': 'sent', // Still in transit
  };

  const newStatus = statusMap[event.type];
  if (!newStatus) {
    return NextResponse.json({ received: true });
  }

  await db
    .update(notifications)
    .set({
      status: newStatus,
      ...(newStatus === 'delivered' ? { deliveredAt: new Date() } : {}),
      ...(newStatus === 'bounced' ? { failedReason: `Resend: ${event.type} - ${event.data?.bounce_type || 'unknown'}` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(notifications.externalId, emailId));

  return NextResponse.json({ received: true });
}
```

---

## 16. Cron Jobs

### 16.1 Booking Reminder — 24 Hours

### File: `src/app/api/cron/booking-reminder-24h/route.ts`

```typescript
// ============================================================
// Cron: booking-reminder-24h
// Schedule: Every hour (catches bookings in the 23-25h window)
// Vercel Cron: { "path": "/api/cron/booking-reminder-24h", "schedule": "0 * * * *" }
//
// Finds confirmed bookings occurring ~24 hours from now.
// Sends SMS reminder to each student.
// Idempotent: checks if reminder already sent for this booking.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { bookings, notifications, services, students, profiles } from '@/db/schema';
import { eq, and, between, not, inArray, sql } from 'drizzle-orm';
import { dispatchNotification } from '@/lib/notifications/notification.service';
import { formatDateAEST, formatTimeAEST } from '@/lib/utils/date';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() + 23 * 60 * 60 * 1000); // 23h from now
  const windowEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000);   // 25h from now

  // Find confirmed bookings in the 24h window
  const upcomingBookings = await db
    .select({
      bookingId: bookings.id,
      scheduledDate: bookings.scheduledDate,
      startTime: bookings.startTime,
      durationMinutes: bookings.durationMinutes,
      studentId: bookings.studentId,
      contactId: bookings.contactId,
      serviceId: bookings.serviceId,
    })
    .from(bookings)
    .where(and(
      eq(bookings.status, 'confirmed'),
      sql`(${bookings.scheduledDate}::date + ${bookings.startTime}::time) BETWEEN ${windowStart} AND ${windowEnd}`
    ));

  // Filter out bookings that already have a 24h reminder
  const alreadyReminded = await db
    .select({ relatedId: notifications.relatedId })
    .from(notifications)
    .where(and(
      eq(notifications.notificationType, 'booking_reminder_24h'),
      inArray(notifications.relatedId, upcomingBookings.map(b => b.bookingId)),
      not(eq(notifications.status, 'failed')),
    ));

  const remindedIds = new Set(alreadyReminded.map(r => r.relatedId));
  const toRemind = upcomingBookings.filter(b => !remindedIds.has(b.bookingId));

  let sentCount = 0;

  for (const booking of toRemind) {
    try {
      // Resolve student details and service name
      const [service] = booking.serviceId
        ? await db.select({ name: services.name }).from(services).where(eq(services.id, booking.serviceId)).limit(1)
        : [{ name: 'Driving Lesson' }];

      // Resolve student contact info
      let phone: string | undefined;
      let email: string | undefined;
      let studentClerkId: string | undefined;
      let studentName = 'there';

      if (booking.studentId) {
        const [student] = await db
          .select({ clerkUserId: students.clerkUserId })
          .from(students)
          .where(eq(students.id, booking.studentId))
          .limit(1);

        if (student?.clerkUserId) {
          studentClerkId = student.clerkUserId;
          const [profile] = await db
            .select({ phone: profiles.phone, email: profiles.email, firstName: profiles.firstName })
            .from(profiles)
            .where(eq(profiles.clerkUserId, student.clerkUserId))
            .limit(1);

          phone = profile?.phone || undefined;
          email = profile?.email || undefined;
          studentName = profile?.firstName || 'there';
        }
      }

      await dispatchNotification(
        'booking_reminder_24h',
        {
          student_name: studentName,
          service_name: service?.name || 'Driving Lesson',
          date: formatDateAEST(booking.scheduledDate),
          time: formatTimeAEST(booking.startTime),
          duration_minutes: booking.durationMinutes,
          booking_id: booking.bookingId,
        },
        {
          recipient_id: studentClerkId,
          recipient_contact_id: booking.contactId || undefined,
          recipient_phone: phone,
          recipient_email: email,
        },
        {
          triggered_by: 'cron:booking_reminder_24h',
          related_id: booking.bookingId,
        }
      );

      sentCount++;
    } catch (error) {
      console.error(`[CRON:REMINDER_24H] Error for booking ${booking.bookingId}:`, error);
    }
  }

  return NextResponse.json({
    status: 'ok',
    checked: upcomingBookings.length,
    already_reminded: remindedIds.size,
    sent: sentCount,
  });
}
```

### 16.2 Booking Reminder — 2 Hours

### File: `src/app/api/cron/booking-reminder-2h/route.ts`

```typescript
// ============================================================
// Cron: booking-reminder-2h
// Schedule: Every 30 minutes
// Vercel Cron: { "path": "/api/cron/booking-reminder-2h", "schedule": "*/30 * * * *" }
//
// Same pattern as 24h reminder, but with 1.5h-2.5h window.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { bookings, notifications, services, students, profiles } from '@/db/schema';
import { eq, and, not, inArray, sql } from 'drizzle-orm';
import { dispatchNotification } from '@/lib/notifications/notification.service';
import { formatDateAEST, formatTimeAEST } from '@/lib/utils/date';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() + 90 * 60 * 1000);  // 1.5h from now
  const windowEnd = new Date(now.getTime() + 150 * 60 * 1000);   // 2.5h from now

  const upcomingBookings = await db
    .select({
      bookingId: bookings.id,
      scheduledDate: bookings.scheduledDate,
      startTime: bookings.startTime,
      durationMinutes: bookings.durationMinutes,
      studentId: bookings.studentId,
      contactId: bookings.contactId,
      serviceId: bookings.serviceId,
    })
    .from(bookings)
    .where(and(
      eq(bookings.status, 'confirmed'),
      sql`(${bookings.scheduledDate}::date + ${bookings.startTime}::time) BETWEEN ${windowStart} AND ${windowEnd}`
    ));

  // Idempotency check
  const alreadyReminded = await db
    .select({ relatedId: notifications.relatedId })
    .from(notifications)
    .where(and(
      eq(notifications.notificationType, 'booking_reminder_2h'),
      inArray(notifications.relatedId, upcomingBookings.map(b => b.bookingId)),
      not(eq(notifications.status, 'failed')),
    ));

  const remindedIds = new Set(alreadyReminded.map(r => r.relatedId));
  const toRemind = upcomingBookings.filter(b => !remindedIds.has(b.bookingId));

  let sentCount = 0;

  for (const booking of toRemind) {
    try {
      const [service] = booking.serviceId
        ? await db.select({ name: services.name }).from(services).where(eq(services.id, booking.serviceId)).limit(1)
        : [{ name: 'Driving Lesson' }];

      let phone: string | undefined;
      let studentClerkId: string | undefined;

      if (booking.studentId) {
        const [student] = await db
          .select({ clerkUserId: students.clerkUserId })
          .from(students)
          .where(eq(students.id, booking.studentId))
          .limit(1);

        if (student?.clerkUserId) {
          studentClerkId = student.clerkUserId;
          const [profile] = await db
            .select({ phone: profiles.phone })
            .from(profiles)
            .where(eq(profiles.clerkUserId, student.clerkUserId))
            .limit(1);

          phone = profile?.phone || undefined;
        }
      }

      await dispatchNotification(
        'booking_reminder_2h',
        {
          service_name: service?.name || 'Driving Lesson',
          date: formatDateAEST(booking.scheduledDate),
          time: formatTimeAEST(booking.startTime),
          duration_minutes: booking.durationMinutes,
          booking_id: booking.bookingId,
        },
        {
          recipient_id: studentClerkId,
          recipient_contact_id: booking.contactId || undefined,
          recipient_phone: phone,
        },
        {
          triggered_by: 'cron:booking_reminder_2h',
          related_id: booking.bookingId,
        }
      );

      sentCount++;
    } catch (error) {
      console.error(`[CRON:REMINDER_2H] Error for booking ${booking.bookingId}:`, error);
    }
  }

  return NextResponse.json({
    status: 'ok',
    checked: upcomingBookings.length,
    already_reminded: remindedIds.size,
    sent: sentCount,
  });
}
```

### 16.3 Package Low Credits

### File: `src/app/api/cron/package-low-credits/route.ts`

```typescript
// ============================================================
// Cron: package-low-credits
// Schedule: Weekly (Sunday 8am AEST = Saturday 21:00 UTC)
// Vercel Cron: { "path": "/api/cron/package-low-credits", "schedule": "0 21 * * 6" }
//
// Finds student packages with ≤2 credits remaining.
// Sends notification if not already sent this week.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { studentPackages, packages, students, profiles, notifications } from '@/db/schema';
import { eq, and, lte, not, sql } from 'drizzle-orm';
import { dispatchNotification } from '@/lib/notifications/notification.service';

const LOW_CREDIT_THRESHOLD = 2;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Find active packages with low credits
  const lowCreditPackages = await db
    .select({
      studentPackageId: studentPackages.id,
      studentId: studentPackages.studentId,
      packageId: studentPackages.packageId,
      creditsRemaining: studentPackages.creditsRemaining,
    })
    .from(studentPackages)
    .where(and(
      eq(studentPackages.status, 'active'),
      lte(studentPackages.creditsRemaining, LOW_CREDIT_THRESHOLD),
    ));

  // Filter out those already notified this week
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  let sentCount = 0;

  for (const sp of lowCreditPackages) {
    try {
      // Check if already notified this week
      const [existing] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(
          eq(notifications.notificationType, 'package_low_credits'),
          eq(notifications.relatedId, sp.studentPackageId),
          sql`${notifications.createdAt} > ${oneWeekAgo}`,
          not(eq(notifications.status, 'failed')),
        ))
        .limit(1);

      if (existing) continue;

      // Resolve student + package details
      const [student] = await db
        .select({ clerkUserId: students.clerkUserId })
        .from(students)
        .where(eq(students.id, sp.studentId))
        .limit(1);

      if (!student?.clerkUserId) continue;

      const [profile] = await db
        .select({ phone: profiles.phone, email: profiles.email, firstName: profiles.firstName })
        .from(profiles)
        .where(eq(profiles.clerkUserId, student.clerkUserId))
        .limit(1);

      const [pkg] = await db
        .select({ name: packages.name })
        .from(packages)
        .where(eq(packages.id, sp.packageId))
        .limit(1);

      await dispatchNotification(
        'package_low_credits',
        {
          student_name: profile?.firstName || 'there',
          package_name: pkg?.name || 'Lesson Package',
          credits_remaining: sp.creditsRemaining,
          rebuy_url: `${process.env.NEXT_PUBLIC_APP_URL}/packages`,
        },
        {
          recipient_id: student.clerkUserId,
          recipient_phone: profile?.phone || undefined,
          recipient_email: profile?.email || undefined,
        },
        {
          triggered_by: 'cron:package_low_credits',
          related_id: sp.studentPackageId,
        }
      );

      sentCount++;
    } catch (error) {
      console.error(`[CRON:LOW_CREDITS] Error for package ${sp.studentPackageId}:`, error);
    }
  }

  return NextResponse.json({
    status: 'ok',
    low_credit_packages: lowCreditPackages.length,
    notifications_sent: sentCount,
  });
}
```

---

## 17. Vercel Cron Configuration

Add to `vercel.json` (merge with existing crons from SPEC-04 and SPEC-05):

```json
{
  "crons": [
    {
      "path": "/api/cron/booking-reminder-24h",
      "schedule": "0 * * * *"
    },
    {
      "path": "/api/cron/booking-reminder-2h",
      "schedule": "*/30 * * * *"
    },
    {
      "path": "/api/cron/package-low-credits",
      "schedule": "0 21 * * 6"
    }
  ]
}
```

**Note:** Vercel cron uses UTC. `0 21 * * 6` = Saturday 21:00 UTC = Sunday 08:00 AEST (or 07:00 AEDT).

---

## 18. Retry Processor

The retry processor runs as part of the cron cycle. Add to the 2h reminder cron (runs every 30 minutes) as a piggyback job:

```typescript
// Add to src/app/api/cron/booking-reminder-2h/route.ts (at the end of GET handler)

import { getDueRetries } from '@/lib/notifications/retry.service';

// Process pending retries (piggyback on frequent cron)
const dueRetries = await getDueRetries();
let retryCount = 0;
for (const retry of dueRetries) {
  try {
    await dispatchNotification(
      retry.input.type,
      retry.input.data as Record<string, unknown>,
      {
        recipient_id: retry.input.recipient_id,
        recipient_contact_id: retry.input.recipient_contact_id,
        recipient_phone: retry.input.recipient_phone,
        recipient_email: retry.input.recipient_email,
      },
      {
        triggered_by: `retry:attempt_${retry.attempt}`,
        related_id: retry.input.related_id,
      }
    );
    retryCount++;
  } catch (error) {
    console.error(`[RETRY] Failed attempt for ${retry.notification_id}:`, error);
  }
}
```

---

## 19. Date Utility (Shared)

### File: `src/lib/utils/date.ts`

```typescript
// ============================================================
// NexDrive Academy — Date Formatting Utilities
// All user-facing dates in Australia/Canberra timezone.
// ============================================================

const TIMEZONE = 'Australia/Canberra';

/**
 * Format a date as "Wednesday, 25 March 2026" in AEST.
 */
export function formatDateAEST(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TIMEZONE,
  });
}

/**
 * Format a time as "10:00 AM" in AEST.
 */
export function formatTimeAEST(time: Date | string): string {
  // If it's a TIME-only string (HH:MM:SS), parse it
  if (typeof time === 'string' && /^\d{2}:\d{2}/.test(time)) {
    const [hours, minutes] = time.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const h = hours % 12 || 12;
    return `${h}:${minutes.toString().padStart(2, '0')} ${period}`;
  }

  const d = typeof time === 'string' ? new Date(time) : time;
  return d.toLocaleTimeString('en-AU', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TIMEZONE,
  });
}
```

---

## 20. Environment Variables

```env
# ─── Twilio ──────────────────────────────────
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=+61XXXXXXXXX     # Australian number

# ─── Resend ──────────────────────────────────
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM_ADDRESS=NexDrive Academy <hello@nexdriveacademy.com.au>
RESEND_REPLY_TO=rob@nexdriveacademy.com.au
RESEND_WEBHOOK_SECRET=whsec_xxxxxxxx

# ─── Internal ────────────────────────────────
INTERNAL_API_SECRET=              # Shared secret for service-to-service calls
CRON_SECRET=                      # Vercel cron auth
ROB_MOBILE_NUMBER=+614XXXXXXXX   # Rob's direct mobile for callback alerts
NEXDRIVE_EMAIL=hello@nexdriveacademy.com.au
NEXDRIVE_PHONE=                   # Business phone for email footer

# ─── App ─────────────────────────────────────
NEXT_PUBLIC_APP_URL=https://nexdriveacademy.com.au
```

---

## 21. Event → Notification Mapping (Complete Reference)

| AppEvent | Notification Type | Channels | Recipient |
|----------|------------------|----------|-----------|
| `BOOKING_CREATED` | `booking_confirmation` | SMS + Email | Student |
| `BOOKING_CANCELLED` | `booking_cancelled` | SMS + Email | Student |
| `BOOKING_RESCHEDULED` | `booking_rescheduled` | SMS + Email | Student |
| `LESSON_COMPLETED` | `lesson_completed` | Email | Student |
| `COMPETENCY_ACHIEVED` | `competency_achieved` | Email | Student |
| `PAYMENT_RECEIVED` | `payment_received` | Email | Student |
| `CALLBACK_REQUESTED` | `callback_scheduled` | SMS | Rob (instructor) |
| `CERTIFICATE_ISSUED` | `certificate_ready` | SMS + Email | Student |
| *Cron: every hour* | `booking_reminder_24h` | SMS | Student |
| *Cron: every 30min* | `booking_reminder_2h` | SMS | Student |
| *Cron: weekly* | `package_low_credits` | SMS + Email | Student |
| *Bridge Form Gen* | `bridge_form_ready` | SMS + Email | Parent |
| *Payment Engine* | `payment_failed` | SMS + Email | Student |
| *Package Purchase* | `package_purchased` | Email | Student |
| *Student Action* | `parent_invitation` | SMS + Email | Parent |
| *Waitlist Matcher* | `waitlist_available` | SMS + Email | Student |

**Notes:**
- `bridge_form_ready`, `payment_failed`, `package_purchased`, `parent_invitation`, and `waitlist_available` will have event handlers added when their respective components (C11, C10, C22) are fully implemented. For now, they can be triggered via the internal API.
- `CONTACT_CREATED` does not trigger a notification in v1. Future: welcome SMS/email for web leads.

---

## 22. Integration Points

### 22.1 Booking Engine (SPEC-03)

Replace the TODO stubs in `src/lib/booking/events.ts` with real calls:

```typescript
// Replace:
// TODO Phase 1: Call notificationService.sendBookingConfirmation(data)
// With: (handled automatically by event bus subscription in event-handlers.ts)
```

The event bus pattern means SPEC-03 doesn't need direct imports. The Notification Engine registers its listeners at startup and receives events automatically.

### 22.2 Payment Engine (SPEC-04)

Same pattern — `PAYMENT_RECEIVED` events from SPEC-04 are automatically picked up by the notification event listeners.

### 22.3 CRM (SPEC-05)

The `CONTACT_CREATED` and `CONTACT_LIFECYCLE_CHANGED` events from SPEC-05 can trigger notifications in future. For v1, the notification listeners for these events are not registered (no-op).

### 22.4 Startup Registration

In the application bootstrap (e.g., `src/instrumentation.ts` or `src/lib/bootstrap.ts`):

```typescript
import { registerBookingEventListeners } from '@/lib/booking/events';
import { registerPaymentEventHandlers } from '@/lib/payments/event-handlers';
import { registerNotificationEventListeners } from '@/lib/notifications/event-handlers';

export function registerAllEventListeners(): void {
  registerBookingEventListeners();
  registerPaymentEventHandlers();
  registerNotificationEventListeners();
}
```

---

## 23. Testing Strategy

### 23.1 Unit Tests

| File | Test Focus |
|------|-----------|
| `template.service.test.ts` | SMS rendering (char count, variable interpolation), email rendering (HTML output, subject lines) |
| `preference.service.test.ts` | Opt-in/out logic, non-optable enforcement, default behavior |
| `recipient.service.test.ts` | Resolution from user ID, contact ID, explicit address, priority ordering |
| `retry.service.test.ts` | Backoff timing, max retry enforcement, Redis integration |

### 23.2 Integration Tests

| Scenario | Verify |
|----------|--------|
| Full dispatch cycle | Event → notification record created → adapter called → status updated |
| Twilio webhook | Status callback → notification status updated to `delivered`/`failed` |
| Resend webhook | Email status → notification status updated |
| Cron: 24h reminder | Finds correct bookings, skips already-reminded, sends SMS |
| Cron: 2h reminder | Same as above but 2h window |
| Cron: low credits | Finds packages ≤2 credits, skips already-notified this week |
| Preference opt-out | User opts out of `booking_reminder_24h` SMS → reminder not sent |
| Non-optable | User tries to opt out of `booking_confirmation` → rejected |

### 23.3 Manual Testing (Staging)

1. Create a booking → verify SMS + email confirmation received
2. Wait for cron → verify 24h and 2h reminders
3. Cancel booking → verify cancellation SMS + email
4. Process payment → verify receipt email
5. Opt out of reminders → verify no reminders sent
6. Try to opt out of confirmations → verify rejection

---

## 24. Dependencies

```json
{
  "twilio": "^5.x",
  "resend": "^4.x",
  "@upstash/redis": "^1.x"
}
```

All three should already be in the project from earlier specs. No new dependencies.

---

## 25. Decisions & Trade-offs

| Decision | Rationale |
|----------|-----------|
| **In-process event bus** (not BullMQ) | <100 events/day at current scale. EventEmitter3 is sufficient. When scaling beyond ~500/day, swap to BullMQ with Redis backing. |
| **Retry via Redis keys** (not job queue) | Keeps infrastructure simple. Retries are checked by piggybacking on the 30-minute cron. At scale, replace with BullMQ delayed jobs. |
| **No push notifications in v1** | PWA/native app not built yet. Schema supports it for when the time comes. |
| **SMS templates as string literals** (not DB-stored) | Rob doesn't need a CMS for templates. If templates need runtime editing, migrate to a `notification_templates` table. |
| **`failed` status for skipped sends** | The schema doesn't have a `skipped` enum value. We store with `failed` + `failed_reason` explaining the skip. Consider adding `skipped` to the enum in a future migration. |
| **Idempotent cron reminders** | Each cron checks for existing notification records before sending. Safe to run multiple times without duplicate sends. |
| **Non-optable types hardcoded** | Booking confirmations, cancellations, and payment receipts are legally/operationally required. These cannot be disabled regardless of user preferences. |
