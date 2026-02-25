# SPEC-04: Payment Engine API (C10)
### NexDrive Academy — Phase 1 Revenue Engine
**Version:** 1.0  
**Date:** 20 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.7, §5.3; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-03 (Booking Engine)  
**Phase:** 1 (Revenue Engine — Weeks 3-6)  
**Estimated Effort:** 10-12 days  

---

## 1. Overview

The Payment Engine is NexDrive Academy's financial backbone. It processes card payments through multiple Australian-optimised gateways, manages prepaid lesson packages, validates voucher codes, generates invoices, and handles refunds. All monetary values are integer cents (AUD). All gateways are behind a common adapter interface so Rob can switch providers without code changes.

**This is a self-contained implementation brief.** A developer (or AI coding agent) should be able to execute this spec from start to finish without referring back to the architecture document.

### 1.1 Key Rules (Non-Negotiable)

1. **All monetary values in integer cents (AUD).** `amount_cents`, `price_cents`, `discount_cents` — NEVER floating point. Every gateway adapter must normalise to/from this format.
2. **Tyro is the default gateway.** Lowest fees for AU debit cards via eftpos routing (~1.2-1.5%). Stripe is available but NOT the default — only used for international cards or as last fallback.
3. **Gateway adapter pattern.** Every external payment provider sits behind a `PaymentGateway` interface. New providers can be added without changing any business logic.
4. **No card data touches our servers.** All gateways use tokenised/redirect flows (PCI DSS SAQ-A compliance). Card numbers never pass through our API routes.
5. **Refunds route through the original gateway.** If a payment was processed via Tyro, the refund goes back through Tyro.
6. **Cash and bank transfers are first-class.** Not every student pays by card. Manual recording by instructor is a supported payment method.
7. **Package credits are internal currency.** When a student with package credits books a lesson, we deduct credits — no external gateway call.
8. **Invoices are auto-numbered.** Sequential format: `NXD-{YEAR}-{NNNN}` (e.g., `NXD-2026-0001`). Must show ABN, GST if applicable, gateway used.
9. **Fee comparison logging.** Every gateway transaction logs fees in `gateway_response` JSONB so Rob can compare actual costs across providers.
10. **Event-driven side effects.** Payment mutations emit events (e.g., `PAYMENT_RECEIVED`); notification/CRM listeners handle downstream effects.
11. **Australian data residency.** All payment metadata stored in Sydney (ap-southeast-2).
12. **Append-only audit.** All payment state changes are logged via the audit trail (C14).

### 1.2 Payment Status State Machine

```
                Card / Gateway Payments
                ─────────────────────────

  ┌─────────┐    ┌────────────┐    ┌───────────┐
  │ pending │───►│ processing │───►│ succeeded │
  └────┬────┘    └─────┬──────┘    └─────┬─────┘
       │               │                 │
       │               ▼                 ▼
       │         ┌──────────┐    ┌───────────────────┐
       │         │  failed  │    │ refund_requested  │
       │         └──────────┘    └────────┬──────────┘
       │                                  │
       │                        ┌─────────▼──────────┐
       │                        │     refunded       │
       │                        │ (full or partial)  │
       │                        └────────────────────┘
       │
       │   Cash / Bank Transfer
       │   ────────────────────
       │
       └───────────────────────►┌───────────┐
                                │ confirmed │
                                └───────────┘
```

**Valid Transitions:**

| From | To | Who Can Trigger | Conditions |
|------|----|-----------------|------------|
| `pending` | `processing` | System | Gateway confirms payment intent created |
| `processing` | `succeeded` | System (webhook) | Gateway confirms payment captured |
| `processing` | `failed` | System (webhook) | Gateway reports failure |
| `succeeded` | `refund_requested` | Instructor, Admin | Refund initiated |
| `refund_requested` | `refunded` | System (webhook) | Gateway confirms refund processed |
| `refund_requested` | `partially_refunded` | System (webhook) | Partial refund confirmed |
| `pending` | `confirmed` | Instructor | Cash received / bank transfer verified |
| `pending` | `failed` | System (timeout) | Payment intent expired (30 min) |

**Terminal states:** `succeeded`, `failed`, `refunded`, `partially_refunded`, `confirmed`. The `succeeded` and `confirmed` states are NOT terminal for refund purposes — they can transition to refund flow.

**DB status mapping:** The database `status` enum is `pending | processing | completed | failed | refunded | partially_refunded | disputed`. Note: `completed` in DB maps to `succeeded` in the state machine. `confirmed` (for cash/transfer) also maps to `completed` in DB.

---

## 2. File Structure

```
src/
├── lib/
│   ├── payments/
│   │   ├── index.ts                        # Barrel export
│   │   ├── types.ts                        # All payment types + Zod schemas
│   │   ├── errors.ts                       # Payment-specific error classes
│   │   ├── constants.ts                    # Status values, defaults, config
│   │   ├── state-machine.ts               # Payment status transitions
│   │   ├── payment.service.ts             # Core payment business logic
│   │   ├── package.service.ts             # Package purchase + credit management
│   │   ├── voucher.service.ts             # Voucher validation + redemption
│   │   ├── invoice.service.ts             # Invoice generation + PDF + R2 upload
│   │   ├── refund.service.ts              # Refund processing
│   │   ├── gateway-factory.ts             # Factory: instantiate correct adapter
│   │   ├── fee-logger.ts                  # Gateway fee comparison logging
│   │   └── adapters/
│   │       ├── gateway.interface.ts       # PaymentGateway interface definition
│   │       ├── tyro.adapter.ts            # Tyro eCommerce API
│   │       ├── square.adapter.ts          # Square Payments API
│   │       ├── pin.adapter.ts             # Pin Payments API
│   │       ├── stripe.adapter.ts          # Stripe PaymentIntent API
│   │       └── afterpay.adapter.ts        # Afterpay via Square
│   ├── events/
│   │   └── index.ts                       # EventBus (shared — already from SPEC-03)
├── app/
│   └── api/
│       └── v1/
│           ├── payments/
│           │   ├── create-intent/
│           │   │   └── route.ts           # POST — create payment intent
│           │   ├── record-manual/
│           │   │   └── route.ts           # POST — record cash/bank transfer
│           │   ├── confirm-transfer/
│           │   │   └── route.ts           # POST — confirm pending transfer
│           │   ├── webhook/
│           │   │   ├── tyro/
│           │   │   │   └── route.ts       # POST — Tyro webhook
│           │   │   ├── square/
│           │   │   │   └── route.ts       # POST — Square webhook
│           │   │   ├── pin/
│           │   │   │   └── route.ts       # POST — Pin webhook
│           │   │   ├── stripe/
│           │   │   │   └── route.ts       # POST — Stripe webhook
│           │   │   └── afterpay/
│           │   │       └── route.ts       # POST — Afterpay webhook
│           │   ├── [id]/
│           │   │   ├── route.ts           # GET — payment detail
│           │   │   ├── invoice/
│           │   │   │   └── route.ts       # GET — download invoice PDF
│           │   │   └── refund/
│           │   │       └── route.ts       # POST — initiate refund
│           │   └── route.ts               # GET — payment history (list)
│           ├── packages/
│           │   ├── [id]/
│           │   │   └── purchase/
│           │   │       └── route.ts       # POST — purchase package
│           │   └── route.ts               # GET — list available packages
│           ├── me/
│           │   └── packages/
│           │       └── route.ts           # GET — my packages + credits
│           └── vouchers/
│               └── validate/
│                   └── route.ts           # POST — validate voucher code
```

---

## 3. Types & Validation Schemas

### File: `src/lib/payments/types.ts`

```typescript
// ============================================================
// NexDrive Academy — Payment Engine Types & Validation
// Reference: System Architecture v1.1 §4.2.7
// ============================================================

import { z } from 'zod';

// ─── Status & Method Enums ─────────────────

export const PaymentStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
  DISPUTED: 'disputed',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PaymentMethod = {
  CARD: 'card',
  DIRECT_DEBIT: 'direct_debit',
  AFTERPAY: 'afterpay',
  PAYPAL: 'paypal',
  PACKAGE_CREDIT: 'package_credit',
  VOUCHER: 'voucher',
  CASH: 'cash',
  OTHER: 'other',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const GatewayName = {
  TYRO: 'tyro',
  SQUARE: 'square',
  PIN: 'pin',
  STRIPE: 'stripe',
  AFTERPAY: 'afterpay',
} as const;
export type GatewayName = (typeof GatewayName)[keyof typeof GatewayName];

export const VoucherType = {
  PERCENTAGE: 'percentage',
  FIXED_AMOUNT: 'fixed_amount',
  FREE_LESSON: 'free_lesson',
} as const;
export type VoucherType = (typeof VoucherType)[keyof typeof VoucherType];

export const PackageStatus = {
  ACTIVE: 'active',
  EXHAUSTED: 'exhausted',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const;
export type PackageStatus = (typeof PackageStatus)[keyof typeof PackageStatus];

// ─── Gateway Interface Types ───────────────

export interface CreateIntentParams {
  amount_cents: number;
  currency: 'AUD';
  customer_id?: string;
  customer_email?: string;
  customer_name?: string;
  description?: string;
  metadata: Record<string, string>;
  return_url?: string;
}

export interface PaymentIntentResult {
  gateway_intent_id: string;
  client_secret: string;
  status: 'requires_payment' | 'processing' | 'succeeded' | 'failed';
  gateway_response: Record<string, unknown>;
}

export interface PaymentConfirmResult {
  gateway_payment_id: string;
  status: 'succeeded' | 'failed' | 'processing';
  amount_cents: number;
  fee_cents?: number;
  net_cents?: number;
  gateway_response: Record<string, unknown>;
}

export interface RefundResult {
  gateway_refund_id: string;
  status: 'succeeded' | 'pending' | 'failed';
  amount_cents: number;
  gateway_response: Record<string, unknown>;
}

export interface GatewayCustomer {
  gateway_customer_id: string;
}

export interface GatewayPaymentMethod {
  id: string;
  type: string;
  last_four?: string;
  brand?: string;
  expiry_month?: number;
  expiry_year?: number;
}

export interface WebhookVerifyResult {
  verified: boolean;
  event_type: string;
  event_data: Record<string, unknown>;
}

// ─── API Request Schemas ───────────────────

export const CreatePaymentIntentSchema = z.object({
  amount_cents: z.number().int().positive(),
  booking_id: z.string().uuid().optional(),
  package_id: z.string().uuid().optional(),
  gateway: z.enum(['tyro', 'square', 'pin', 'stripe', 'afterpay']).optional(),
  payment_method: z.enum([
    'card', 'direct_debit', 'afterpay', 'paypal',
    'package_credit', 'voucher', 'cash', 'other',
  ]).default('card'),
  voucher_code: z.string().optional(),
  description: z.string().max(500).optional(),
  return_url: z.string().url().optional(),
});
export type CreatePaymentIntentInput = z.infer<typeof CreatePaymentIntentSchema>;

export const RecordManualPaymentSchema = z.object({
  student_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  booking_id: z.string().uuid().optional(),
  amount_cents: z.number().int().positive(),
  payment_method: z.enum(['cash', 'direct_debit', 'other']),
  description: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
  // For bank transfer: reference info
  bank_reference: z.string().max(200).optional(),
}).refine(
  (data) => data.student_id || data.contact_id,
  { message: 'Either student_id or contact_id is required' }
);
export type RecordManualPaymentInput = z.infer<typeof RecordManualPaymentSchema>;

export const ConfirmTransferSchema = z.object({
  payment_id: z.string().uuid(),
  bank_reference: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
});
export type ConfirmTransferInput = z.infer<typeof ConfirmTransferSchema>;

export const RefundPaymentSchema = z.object({
  amount_cents: z.number().int().positive().optional(), // Optional = full refund
  reason: z.string().min(1).max(500),
});
export type RefundPaymentInput = z.infer<typeof RefundPaymentSchema>;

export const PurchasePackageSchema = z.object({
  gateway: z.enum(['tyro', 'square', 'pin', 'stripe', 'afterpay']).optional(),
  voucher_code: z.string().optional(),
  return_url: z.string().url().optional(),
});
export type PurchasePackageInput = z.infer<typeof PurchasePackageSchema>;

export const ValidateVoucherSchema = z.object({
  code: z.string().min(1).max(50).transform((s) => s.toUpperCase().trim()),
  service_id: z.string().uuid().optional(),
  amount_cents: z.number().int().positive().optional(),
});
export type ValidateVoucherInput = z.infer<typeof ValidateVoucherSchema>;

// ─── API Response Shapes ───────────────────

export interface PaymentResponse {
  id: string;
  student_id: string | null;
  contact_id: string | null;
  booking_id: string | null;
  package_id: string | null;
  amount_cents: number;
  currency: string;
  payment_method: PaymentMethod;
  gateway: GatewayName | null;
  status: PaymentStatus;
  refund_amount_cents: number;
  invoice_number: string | null;
  invoice_url: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentIntentResponse {
  payment_id: string;
  client_secret: string;
  gateway: GatewayName;
  gateway_intent_id: string;
  amount_cents: number;
  currency: string;
  status: string;
}

export interface StudentPackageResponse {
  id: string;
  package_name: string;
  package_description: string | null;
  credits_total: number;
  credits_used: number;
  credits_remaining: number;
  purchased_at: string;
  expires_at: string | null;
  status: PackageStatus;
  applicable_services: string[];
}

export interface VoucherValidationResponse {
  valid: boolean;
  code: string;
  voucher_type: VoucherType;
  discount_percent: number | null;
  discount_cents: number | null;
  discount_applied_cents: number | null; // Calculated if amount_cents provided
  message: string;
}

export interface InvoiceData {
  invoice_number: string;
  business_name: string;
  abn: string;
  business_address: string;
  student_name: string;
  student_email: string;
  line_items: Array<{
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
  }>;
  subtotal_cents: number;
  gst_cents: number;
  total_cents: number;
  payment_method: string;
  gateway: string | null;
  paid_at: string;
  invoice_date: string;
}
```

---

## 4. Error Classes

### File: `src/lib/payments/errors.ts`

```typescript
// ============================================================
// NexDrive Academy — Payment Engine Errors
// ============================================================

import { ApiError } from '@/lib/auth/errors';

export class PaymentNotFoundError extends ApiError {
  constructor(paymentId: string) {
    super(404, 'PAYMENT_NOT_FOUND', `Payment ${paymentId} not found`);
  }
}

export class GatewayUnavailableError extends ApiError {
  constructor(gateway: string) {
    super(503, 'GATEWAY_UNAVAILABLE', `Payment gateway '${gateway}' is currently unavailable`);
  }
}

export class GatewayError extends ApiError {
  constructor(gateway: string, message: string, details?: Record<string, unknown>) {
    super(502, 'GATEWAY_ERROR', `Gateway '${gateway}' error: ${message}`, details);
  }
}

export class PaymentFailedError extends ApiError {
  constructor(reason: string) {
    super(422, 'PAYMENT_FAILED', reason);
  }
}

export class InvalidTransitionError extends ApiError {
  constructor(from: string, to: string) {
    super(409, 'INVALID_PAYMENT_TRANSITION', `Cannot transition from '${from}' to '${to}'`);
  }
}

export class RefundExceedsPaymentError extends ApiError {
  constructor(refundCents: number, maxRefundCents: number) {
    super(422, 'REFUND_EXCEEDS_PAYMENT', `Refund of ${refundCents} exceeds maximum refundable amount of ${maxRefundCents}`);
  }
}

export class VoucherNotFoundError extends ApiError {
  constructor(code: string) {
    super(404, 'VOUCHER_NOT_FOUND', `Voucher '${code}' not found`);
  }
}

export class VoucherExpiredError extends ApiError {
  constructor(code: string) {
    super(422, 'VOUCHER_EXPIRED', `Voucher '${code}' has expired`);
  }
}

export class VoucherExhaustedError extends ApiError {
  constructor(code: string) {
    super(422, 'VOUCHER_EXHAUSTED', `Voucher '${code}' has reached its usage limit`);
  }
}

export class VoucherNotApplicableError extends ApiError {
  constructor(code: string, serviceId: string) {
    super(422, 'VOUCHER_NOT_APPLICABLE', `Voucher '${code}' is not valid for this service`);
  }
}

export class PackageNotFoundError extends ApiError {
  constructor(packageId: string) {
    super(404, 'PACKAGE_NOT_FOUND', `Package ${packageId} not found`);
  }
}

export class InsufficientCreditsError extends ApiError {
  constructor(required: number, available: number) {
    super(422, 'INSUFFICIENT_CREDITS', `Requires ${required} credit(s) but only ${available} available`);
  }
}

export class NoActivePackageError extends ApiError {
  constructor() {
    super(422, 'NO_ACTIVE_PACKAGE', 'No active package with available credits');
  }
}

export class DuplicateInvoiceError extends ApiError {
  constructor(invoiceNumber: string) {
    super(409, 'DUPLICATE_INVOICE', `Invoice ${invoiceNumber} already exists`);
  }
}
```

---

## 5. Constants

### File: `src/lib/payments/constants.ts`

```typescript
// ============================================================
// NexDrive Academy — Payment Engine Constants
// ============================================================

import type { GatewayName, PaymentStatus } from './types';

/**
 * Default payment gateway. Tyro is primary for lowest AU fees.
 * Override via NEXT_PUBLIC_DEFAULT_GATEWAY env var or system settings.
 */
export const DEFAULT_GATEWAY: GatewayName = 
  (process.env.NEXT_PUBLIC_DEFAULT_GATEWAY as GatewayName) || 'tyro';

/**
 * Gateway fallback order. If primary is down, try next in list.
 */
export const GATEWAY_FALLBACK_ORDER: GatewayName[] = [
  'tyro',
  'square', 
  'pin',
  'stripe',
];

/**
 * Payment intent expiry. After this, uncompleted intents are auto-expired.
 */
export const PAYMENT_INTENT_EXPIRY_MINUTES = 30;

/**
 * Afterpay minimum amount. Afterpay AU requires min $1 (100 cents).
 * For lesson packages, we enforce a $200 practical minimum.
 */
export const AFTERPAY_MIN_CENTS = 20000; // $200 minimum for packages

/**
 * Invoice number format and counter key.
 */
export const INVOICE_PREFIX = 'NXD';
export const INVOICE_REDIS_COUNTER_KEY = 'invoice:counter';

/**
 * Business details for invoices.
 */
export const BUSINESS_DETAILS = {
  name: 'NexDrive Academy',
  abn: process.env.NEXDRIVE_ABN || '', // Set in env
  address: process.env.NEXDRIVE_ADDRESS || 'Canberra, ACT, Australia',
  email: process.env.NEXDRIVE_EMAIL || 'hello@nexdriveacademy.com.au',
  phone: process.env.NEXDRIVE_PHONE || '',
  gst_registered: process.env.NEXDRIVE_GST_REGISTERED === 'true', // false until >$75k revenue
} as const;

/**
 * GST rate (10% in Australia). Only applied if business is GST-registered.
 */
export const GST_RATE = 0.10;

/**
 * Bank details for direct transfer payments.
 */
export const BANK_DETAILS = {
  account_name: process.env.NEXDRIVE_BANK_ACCOUNT_NAME || 'NexDrive Academy',
  bsb: process.env.NEXDRIVE_BANK_BSB || '',
  account_number: process.env.NEXDRIVE_BANK_ACCOUNT || '',
  payid_email: process.env.NEXDRIVE_PAYID || '',
} as const;

/**
 * Payment status terminal check.
 */
export const TERMINAL_STATUSES: PaymentStatus[] = [
  'failed',
  'refunded',
];

/**
 * R2 bucket paths for invoices.
 */
export const INVOICE_R2_PATH = 'invoices';
```

---

## 6. Payment Status State Machine

### File: `src/lib/payments/state-machine.ts`

```typescript
// ============================================================
// NexDrive Academy — Payment Status State Machine
// Reference: System Architecture v1.1 §4.2.7
// ============================================================

import type { PaymentStatus } from './types';
import { InvalidTransitionError } from './errors';

/**
 * Valid payment status transitions.
 * Key = current status, value = array of allowed next statuses.
 */
const TRANSITIONS: Record<string, string[]> = {
  pending:              ['processing', 'completed', 'failed'],
  processing:           ['completed', 'failed'],
  completed:            ['refunded', 'partially_refunded', 'disputed'],
  failed:               [], // Terminal
  refunded:             [], // Terminal
  partially_refunded:   ['refunded', 'disputed'], // Can refund the rest
  disputed:             ['completed', 'refunded'], // Resolution
};

/**
 * Validate a payment status transition. Throws if invalid.
 */
export function validatePaymentTransition(
  currentStatus: string,
  newStatus: string
): void {
  const allowed = TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new InvalidTransitionError(currentStatus, newStatus);
  }
}

/**
 * Check if a transition is valid without throwing.
 */
export function canTransition(
  currentStatus: string,
  newStatus: string
): boolean {
  const allowed = TRANSITIONS[currentStatus];
  return !!allowed && allowed.includes(newStatus);
}

/**
 * Check if a status is terminal (no further transitions).
 */
export function isTerminal(status: string): boolean {
  const allowed = TRANSITIONS[status];
  return !allowed || allowed.length === 0;
}
```

---

## 7. Gateway Adapter Interface

### File: `src/lib/payments/adapters/gateway.interface.ts`

```typescript
// ============================================================
// NexDrive Academy — PaymentGateway Adapter Interface
// Reference: System Architecture v1.1 §5.3 (Build for Replacement)
//
// Every external payment provider implements this interface.
// Business logic in payment.service.ts never calls provider
// SDKs directly — only through this interface.
// ============================================================

import type {
  CreateIntentParams,
  PaymentIntentResult,
  PaymentConfirmResult,
  RefundResult,
  GatewayCustomer,
  GatewayPaymentMethod,
  WebhookVerifyResult,
  GatewayName,
} from '../types';

export interface PaymentGateway {
  /** Unique name for this gateway (matches DB `gateway` column). */
  readonly name: GatewayName;

  /** Human-readable display name. */
  readonly displayName: string;

  /**
   * Check if the gateway is available and configured.
   * Used by fallback logic to skip unconfigured gateways.
   */
  isAvailable(): boolean;

  /**
   * Create a payment intent / session.
   * Returns a client_secret for frontend to complete payment.
   */
  createIntent(params: CreateIntentParams): Promise<PaymentIntentResult>;

  /**
   * Confirm/capture a payment (server-side confirmation if needed).
   * Some gateways auto-capture; this is a no-op for those.
   */
  confirmPayment(intentId: string): Promise<PaymentConfirmResult>;

  /**
   * Process a refund. If amount_cents is undefined, refund full amount.
   */
  refund(
    paymentId: string,
    amount_cents?: number
  ): Promise<RefundResult>;

  /**
   * Retrieve payment details from the gateway.
   */
  getPayment(paymentId: string): Promise<PaymentConfirmResult>;

  /**
   * Create a customer record in the gateway (for saved cards, etc.).
   */
  createCustomer(params: {
    email: string;
    name: string;
    phone?: string;
  }): Promise<GatewayCustomer>;

  /**
   * List saved payment methods for a customer.
   */
  listPaymentMethods(customerId: string): Promise<GatewayPaymentMethod[]>;

  /**
   * Verify a webhook payload signature from this gateway.
   * Returns parsed event data if valid, throws if invalid.
   */
  verifyWebhook(
    payload: string | Buffer,
    signature: string,
    headers?: Record<string, string>
  ): Promise<WebhookVerifyResult>;
}
```

---

## 8. Gateway Factory

### File: `src/lib/payments/gateway-factory.ts`

```typescript
// ============================================================
// NexDrive Academy — Gateway Factory
// Instantiates the correct payment adapter based on config.
// ============================================================

import type { PaymentGateway } from './adapters/gateway.interface';
import type { GatewayName } from './types';
import { TyroAdapter } from './adapters/tyro.adapter';
import { SquareAdapter } from './adapters/square.adapter';
import { PinAdapter } from './adapters/pin.adapter';
import { StripeAdapter } from './adapters/stripe.adapter';
import { AfterpayAdapter } from './adapters/afterpay.adapter';
import { GatewayUnavailableError } from './errors';
import { DEFAULT_GATEWAY, GATEWAY_FALLBACK_ORDER } from './constants';

/**
 * Registry of all gateway adapters. Instantiated lazily.
 */
const gatewayRegistry: Map<GatewayName, PaymentGateway> = new Map();

function getOrCreateAdapter(name: GatewayName): PaymentGateway {
  let adapter = gatewayRegistry.get(name);
  if (!adapter) {
    switch (name) {
      case 'tyro':
        adapter = new TyroAdapter();
        break;
      case 'square':
        adapter = new SquareAdapter();
        break;
      case 'pin':
        adapter = new PinAdapter();
        break;
      case 'stripe':
        adapter = new StripeAdapter();
        break;
      case 'afterpay':
        adapter = new AfterpayAdapter();
        break;
      default:
        throw new GatewayUnavailableError(name);
    }
    gatewayRegistry.set(name, adapter);
  }
  return adapter;
}

/**
 * Get a specific gateway adapter by name.
 * Throws if the gateway is not configured (missing API keys).
 */
export function getGateway(name: GatewayName): PaymentGateway {
  const adapter = getOrCreateAdapter(name);
  if (!adapter.isAvailable()) {
    throw new GatewayUnavailableError(name);
  }
  return adapter;
}

/**
 * Get the default gateway, or fall back through the priority list.
 * Used when no specific gateway is requested.
 */
export function getDefaultGateway(
  preferredGateway?: GatewayName
): PaymentGateway {
  // 1. Try preferred gateway if specified
  if (preferredGateway) {
    try {
      return getGateway(preferredGateway);
    } catch {
      // Fall through to defaults
    }
  }

  // 2. Try configured default
  try {
    return getGateway(DEFAULT_GATEWAY);
  } catch {
    // Fall through to fallback chain
  }

  // 3. Walk the fallback order
  for (const name of GATEWAY_FALLBACK_ORDER) {
    try {
      return getGateway(name);
    } catch {
      continue;
    }
  }

  throw new GatewayUnavailableError('all gateways');
}

/**
 * Get a gateway by name without availability check (for webhooks).
 * Webhooks from a gateway may arrive even if we've since disabled it.
 */
export function getGatewayForWebhook(name: GatewayName): PaymentGateway {
  return getOrCreateAdapter(name);
}
```

---

## 9. Gateway Adapters

### 9.1 Tyro Adapter (PRIMARY)

### File: `src/lib/payments/adapters/tyro.adapter.ts`

```typescript
// ============================================================
// NexDrive Academy — Tyro eCommerce Gateway Adapter
// Reference: https://docs.tyro.com/app/ecom-api
//
// Tyro is an Australian-built payment platform. Primary gateway
// for NexDrive due to lowest fees on AU debit cards via eftpos
// routing (~1.2-1.5% vs Stripe's 1.7%+).
//
// Tyro eCommerce API flow:
//   1. Create Payment Request (server-side) → returns pay_request_id
//   2. Redirect customer to Tyro Pay form OR embed iFrame
//   3. Customer completes payment on Tyro-hosted form
//   4. Tyro POSTs webhook with result
//   5. We verify + update payment record
// ============================================================

import type { PaymentGateway } from './gateway.interface';
import type {
  CreateIntentParams,
  PaymentIntentResult,
  PaymentConfirmResult,
  RefundResult,
  GatewayCustomer,
  GatewayPaymentMethod,
  WebhookVerifyResult,
  GatewayName,
} from '../types';
import { GatewayError } from '../errors';

const TYRO_API_BASE = process.env.TYRO_API_URL || 'https://api.tyro.com';
const TYRO_API_KEY = process.env.TYRO_API_KEY || '';
const TYRO_MERCHANT_ID = process.env.TYRO_MERCHANT_ID || '';
const TYRO_WEBHOOK_SECRET = process.env.TYRO_WEBHOOK_SECRET || '';

export class TyroAdapter implements PaymentGateway {
  readonly name: GatewayName = 'tyro';
  readonly displayName = 'Tyro';

  isAvailable(): boolean {
    return !!(TYRO_API_KEY && TYRO_MERCHANT_ID);
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntentResult> {
    const response = await fetch(`${TYRO_API_BASE}/connect/pay/requests`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TYRO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locationId: TYRO_MERCHANT_ID,
        provider: {
          // Prefer eftpos routing for AU debit cards (lowest fees)
          name: 'TYRO',
          method: 'CARD',
        },
        amount: {
          value: params.amount_cents,
          currency: params.currency,
        },
        reference: params.metadata.payment_id || '',
        callbackUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/api/v1/payments/webhook/tyro`,
        customerEmail: params.customer_email,
        metadata: params.metadata,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new GatewayError('tyro', `Failed to create payment request: ${response.status}`, error);
    }

    const data = await response.json();

    return {
      gateway_intent_id: data.payRequestId || data.id,
      client_secret: data.paySecret || data.payUrl, // URL or secret for frontend
      status: 'requires_payment',
      gateway_response: {
        ...data,
        _fee_info: 'Tyro eftpos routing: ~1.2% debit, ~1.5% credit',
      },
    };
  }

  async confirmPayment(intentId: string): Promise<PaymentConfirmResult> {
    // Tyro auto-captures on customer completion. This retrieves status.
    const response = await fetch(`${TYRO_API_BASE}/connect/pay/requests/${intentId}`, {
      headers: {
        'Authorization': `Bearer ${TYRO_API_KEY}`,
      },
    });

    if (!response.ok) {
      throw new GatewayError('tyro', `Failed to get payment: ${response.status}`);
    }

    const data = await response.json();

    return {
      gateway_payment_id: data.payRequestId || intentId,
      status: this.mapTyroStatus(data.status),
      amount_cents: data.amount?.value || 0,
      fee_cents: data.surcharge?.value, // Tyro reports surcharge if applicable
      net_cents: data.amount?.value ? (data.amount.value - (data.surcharge?.value || 0)) : undefined,
      gateway_response: data,
    };
  }

  async refund(paymentId: string, amount_cents?: number): Promise<RefundResult> {
    const response = await fetch(`${TYRO_API_BASE}/connect/refunds`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TYRO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payRequestId: paymentId,
        amount: amount_cents ? { value: amount_cents, currency: 'AUD' } : undefined,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new GatewayError('tyro', `Refund failed: ${response.status}`, error);
    }

    const data = await response.json();

    return {
      gateway_refund_id: data.refundId || data.id,
      status: data.status === 'COMPLETED' ? 'succeeded' : 'pending',
      amount_cents: data.amount?.value || amount_cents || 0,
      gateway_response: data,
    };
  }

  async getPayment(paymentId: string): Promise<PaymentConfirmResult> {
    return this.confirmPayment(paymentId);
  }

  async createCustomer(params: {
    email: string;
    name: string;
    phone?: string;
  }): Promise<GatewayCustomer> {
    // Tyro eCommerce doesn't have a persistent customer object like Stripe.
    // We generate an internal reference and store it.
    return {
      gateway_customer_id: `tyro_cust_${Date.now()}`,
    };
  }

  async listPaymentMethods(_customerId: string): Promise<GatewayPaymentMethod[]> {
    // Tyro eCommerce doesn't support saved payment methods in the same way.
    // Return empty — card details are entered fresh each time via Tyro Pay form.
    return [];
  }

  async verifyWebhook(
    payload: string | Buffer,
    signature: string,
    headers?: Record<string, string>
  ): Promise<WebhookVerifyResult> {
    // Tyro uses HMAC-SHA256 signature verification
    const crypto = await import('crypto');
    const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf8');
    const expectedSig = crypto
      .createHmac('sha256', TYRO_WEBHOOK_SECRET)
      .update(payloadStr)
      .digest('hex');

    if (signature !== expectedSig) {
      throw new GatewayError('tyro', 'Invalid webhook signature');
    }

    const data = JSON.parse(payloadStr);

    return {
      verified: true,
      event_type: data.eventType || data.type || 'payment.updated',
      event_data: data,
    };
  }

  private mapTyroStatus(tyroStatus: string): 'succeeded' | 'failed' | 'processing' {
    switch (tyroStatus?.toUpperCase()) {
      case 'COMPLETED':
      case 'APPROVED':
      case 'SUCCESS':
        return 'succeeded';
      case 'FAILED':
      case 'DECLINED':
      case 'VOIDED':
        return 'failed';
      default:
        return 'processing';
    }
  }
}
```

### 9.2 Square Adapter

### File: `src/lib/payments/adapters/square.adapter.ts`

```typescript
// ============================================================
// NexDrive Academy — Square Payments Gateway Adapter
// Flat 1.6% online rate. Good fallback if Tyro has issues.
// Uses Square Web Payments SDK for frontend tokenisation.
// ============================================================

import type { PaymentGateway } from './gateway.interface';
import type {
  CreateIntentParams,
  PaymentIntentResult,
  PaymentConfirmResult,
  RefundResult,
  GatewayCustomer,
  GatewayPaymentMethod,
  WebhookVerifyResult,
  GatewayName,
} from '../types';
import { GatewayError } from '../errors';

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || '';
const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
const SQUARE_API_BASE = process.env.SQUARE_API_URL || 'https://connect.squareup.com/v2';

export class SquareAdapter implements PaymentGateway {
  readonly name: GatewayName = 'square';
  readonly displayName = 'Square';

  isAvailable(): boolean {
    return !!(SQUARE_ACCESS_TOKEN && SQUARE_LOCATION_ID);
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntentResult> {
    // Square uses Checkout API or Payments API with a nonce from Web Payments SDK.
    // We create a payment link / checkout session.
    const idempotencyKey = `nxd_${params.metadata.payment_id || Date.now()}`;

    const response = await fetch(`${SQUARE_API_BASE}/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-11-20',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: params.description || 'NexDrive Academy Lesson',
          price_money: {
            amount: BigInt(params.amount_cents),
            currency: 'AUD',
          },
          location_id: SQUARE_LOCATION_ID,
        },
        checkout_options: {
          redirect_url: params.return_url || `${process.env.NEXT_PUBLIC_BASE_URL}/booking/complete`,
          allow_tipping: false,
        },
        pre_populated_data: {
          buyer_email: params.customer_email,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new GatewayError('square', `Failed to create checkout: ${response.status}`, error);
    }

    const data = await response.json();
    const link = data.payment_link;

    return {
      gateway_intent_id: link.id,
      client_secret: link.url, // Square returns a checkout URL
      status: 'requires_payment',
      gateway_response: {
        ...data,
        _fee_info: 'Square: flat 1.6% online',
      },
    };
  }

  async confirmPayment(intentId: string): Promise<PaymentConfirmResult> {
    const response = await fetch(`${SQUARE_API_BASE}/payments/${intentId}`, {
      headers: {
        'Square-Version': '2024-11-20',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) {
      throw new GatewayError('square', `Failed to get payment: ${response.status}`);
    }

    const data = await response.json();
    const payment = data.payment;

    return {
      gateway_payment_id: payment.id,
      status: payment.status === 'COMPLETED' ? 'succeeded' : payment.status === 'FAILED' ? 'failed' : 'processing',
      amount_cents: Number(payment.amount_money?.amount || 0),
      fee_cents: Number(payment.processing_fee?.[0]?.amount_money?.amount || 0),
      net_cents: Number(payment.amount_money?.amount || 0) - Number(payment.processing_fee?.[0]?.amount_money?.amount || 0),
      gateway_response: data,
    };
  }

  async refund(paymentId: string, amount_cents?: number): Promise<RefundResult> {
    const idempotencyKey = `refund_${paymentId}_${Date.now()}`;

    const body: Record<string, unknown> = {
      idempotency_key: idempotencyKey,
      payment_id: paymentId,
    };

    if (amount_cents) {
      body.amount_money = {
        amount: BigInt(amount_cents),
        currency: 'AUD',
      };
    }

    const response = await fetch(`${SQUARE_API_BASE}/refunds`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-11-20',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new GatewayError('square', `Refund failed: ${response.status}`, error);
    }

    const data = await response.json();
    const refund = data.refund;

    return {
      gateway_refund_id: refund.id,
      status: refund.status === 'COMPLETED' ? 'succeeded' : 'pending',
      amount_cents: Number(refund.amount_money?.amount || amount_cents || 0),
      gateway_response: data,
    };
  }

  async getPayment(paymentId: string): Promise<PaymentConfirmResult> {
    return this.confirmPayment(paymentId);
  }

  async createCustomer(params: {
    email: string;
    name: string;
    phone?: string;
  }): Promise<GatewayCustomer> {
    const response = await fetch(`${SQUARE_API_BASE}/customers`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-11-20',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `cust_${params.email}_${Date.now()}`,
        email_address: params.email,
        given_name: params.name.split(' ')[0],
        family_name: params.name.split(' ').slice(1).join(' '),
        phone_number: params.phone,
      }),
    });

    if (!response.ok) {
      throw new GatewayError('square', 'Failed to create customer');
    }

    const data = await response.json();
    return { gateway_customer_id: data.customer.id };
  }

  async listPaymentMethods(customerId: string): Promise<GatewayPaymentMethod[]> {
    const response = await fetch(`${SQUARE_API_BASE}/cards?customer_id=${customerId}`, {
      headers: {
        'Square-Version': '2024-11-20',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) return [];
    const data = await response.json();

    return (data.cards || []).map((card: Record<string, unknown>) => ({
      id: card.id as string,
      type: 'card',
      last_four: card.last_4 as string,
      brand: card.card_brand as string,
      expiry_month: card.exp_month as number,
      expiry_year: card.exp_year as number,
    }));
  }

  async verifyWebhook(
    payload: string | Buffer,
    signature: string,
    headers?: Record<string, string>
  ): Promise<WebhookVerifyResult> {
    // Square uses SHA-256 HMAC on notification URL + body
    const crypto = await import('crypto');
    const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf8');
    const url = headers?.['x-square-notification-url'] || '';
    const toSign = url + payloadStr;
    const expectedSig = crypto
      .createHmac('sha256', SQUARE_WEBHOOK_SIGNATURE_KEY)
      .update(toSign)
      .digest('base64');

    if (signature !== expectedSig) {
      throw new GatewayError('square', 'Invalid webhook signature');
    }

    const data = JSON.parse(payloadStr);
    return {
      verified: true,
      event_type: data.type || 'payment.updated',
      event_data: data.data || data,
    };
  }
}
```

### 9.3 Pin Payments Adapter

### File: `src/lib/payments/adapters/pin.adapter.ts`

```typescript
// ============================================================
// NexDrive Academy — Pin Payments Gateway Adapter
// Australian-based, 1.75% + 30c. Good developer experience.
// Uses card tokens from Pin.js (frontend tokenisation).
// API docs: https://pinpayments.com/developers/api-reference
// ============================================================

import type { PaymentGateway } from './gateway.interface';
import type {
  CreateIntentParams,
  PaymentIntentResult,
  PaymentConfirmResult,
  RefundResult,
  GatewayCustomer,
  GatewayPaymentMethod,
  WebhookVerifyResult,
  GatewayName,
} from '../types';
import { GatewayError } from '../errors';

const PIN_SECRET_KEY = process.env.PIN_SECRET_KEY || '';
const PIN_WEBHOOK_KEY = process.env.PIN_WEBHOOK_KEY || '';
const PIN_API_BASE = process.env.PIN_API_URL || 'https://api.pinpayments.com/1';

function pinAuthHeader(): string {
  return `Basic ${Buffer.from(`${PIN_SECRET_KEY}:`).toString('base64')}`;
}

export class PinAdapter implements PaymentGateway {
  readonly name: GatewayName = 'pin';
  readonly displayName = 'Pin Payments';

  isAvailable(): boolean {
    return !!PIN_SECRET_KEY;
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntentResult> {
    // Pin Payments doesn't have a "payment intent" concept like Stripe.
    // We create a charge directly (requires card_token from frontend Pin.js).
    // For checkout-style flow, we use Pin's Sessions API.
    const response = await fetch(`${PIN_API_BASE}/charges`, {
      method: 'POST',
      headers: {
        'Authorization': pinAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: params.customer_email,
        description: params.description || 'NexDrive Academy Payment',
        amount: params.amount_cents,
        currency: 'AUD',
        ip_address: params.metadata.ip_address || '127.0.0.1',
        capture: false, // Auth only — capture later
        metadata: params.metadata,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new GatewayError('pin', `Failed to create charge: ${response.status}`, error);
    }

    const data = await response.json();

    return {
      gateway_intent_id: data.response?.token || data.token,
      client_secret: data.response?.token || '', // Frontend uses Pin.js token
      status: 'requires_payment',
      gateway_response: {
        ...data.response,
        _fee_info: 'Pin Payments: 1.75% + 30c',
      },
    };
  }

  async confirmPayment(intentId: string): Promise<PaymentConfirmResult> {
    // Capture a previously authorised charge
    const response = await fetch(`${PIN_API_BASE}/charges/${intentId}/capture`, {
      method: 'PUT',
      headers: {
        'Authorization': pinAuthHeader(),
      },
    });

    if (!response.ok) {
      throw new GatewayError('pin', `Failed to capture charge: ${response.status}`);
    }

    const data = await response.json();
    const charge = data.response;

    return {
      gateway_payment_id: charge.token,
      status: charge.success ? 'succeeded' : 'failed',
      amount_cents: charge.amount,
      gateway_response: data.response,
    };
  }

  async refund(paymentId: string, amount_cents?: number): Promise<RefundResult> {
    const body: Record<string, unknown> = {};
    if (amount_cents) {
      body.amount = amount_cents;
    }

    const response = await fetch(`${PIN_API_BASE}/charges/${paymentId}/refunds`, {
      method: 'POST',
      headers: {
        'Authorization': pinAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new GatewayError('pin', `Refund failed: ${response.status}`);
    }

    const data = await response.json();
    const refund = data.response;

    return {
      gateway_refund_id: refund.token,
      status: refund.success ? 'succeeded' : 'pending',
      amount_cents: refund.amount,
      gateway_response: data.response,
    };
  }

  async getPayment(paymentId: string): Promise<PaymentConfirmResult> {
    const response = await fetch(`${PIN_API_BASE}/charges/${paymentId}`, {
      headers: { 'Authorization': pinAuthHeader() },
    });

    if (!response.ok) {
      throw new GatewayError('pin', `Failed to get charge: ${response.status}`);
    }

    const data = await response.json();
    const charge = data.response;

    return {
      gateway_payment_id: charge.token,
      status: charge.success ? 'succeeded' : charge.captured ? 'processing' : 'failed',
      amount_cents: charge.amount,
      gateway_response: data.response,
    };
  }

  async createCustomer(params: {
    email: string;
    name: string;
    phone?: string;
  }): Promise<GatewayCustomer> {
    const response = await fetch(`${PIN_API_BASE}/customers`, {
      method: 'POST',
      headers: {
        'Authorization': pinAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: params.email }),
    });

    if (!response.ok) {
      throw new GatewayError('pin', 'Failed to create customer');
    }

    const data = await response.json();
    return { gateway_customer_id: data.response.token };
  }

  async listPaymentMethods(customerId: string): Promise<GatewayPaymentMethod[]> {
    const response = await fetch(`${PIN_API_BASE}/customers/${customerId}/cards`, {
      headers: { 'Authorization': pinAuthHeader() },
    });

    if (!response.ok) return [];
    const data = await response.json();

    return (data.response || []).map((card: Record<string, unknown>) => ({
      id: card.token as string,
      type: 'card',
      last_four: card.display_number as string,
      brand: card.scheme as string,
      expiry_month: card.expiry_month as number,
      expiry_year: card.expiry_year as number,
    }));
  }

  async verifyWebhook(
    payload: string | Buffer,
    signature: string,
  ): Promise<WebhookVerifyResult> {
    const crypto = await import('crypto');
    const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf8');
    const expectedSig = crypto
      .createHmac('sha256', PIN_WEBHOOK_KEY)
      .update(payloadStr)
      .digest('hex');

    if (signature !== expectedSig) {
      throw new GatewayError('pin', 'Invalid webhook signature');
    }

    const data = JSON.parse(payloadStr);
    return {
      verified: true,
      event_type: data.event_type || 'charge.captured',
      event_data: data,
    };
  }
}
```

### 9.4 Stripe Adapter

### File: `src/lib/payments/adapters/stripe.adapter.ts`

```typescript
// ============================================================
// NexDrive Academy — Stripe Gateway Adapter
// NOT the default gateway. Higher fees (1.7%+ AU, 3.5% intl).
// Used for international cards or as last fallback.
// Uses Stripe PaymentIntents flow.
// ============================================================

import type { PaymentGateway } from './gateway.interface';
import type {
  CreateIntentParams,
  PaymentIntentResult,
  PaymentConfirmResult,
  RefundResult,
  GatewayCustomer,
  GatewayPaymentMethod,
  WebhookVerifyResult,
  GatewayName,
} from '../types';
import { GatewayError } from '../errors';
import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

function getStripeClient(): Stripe {
  if (!STRIPE_SECRET_KEY) {
    throw new GatewayError('stripe', 'Stripe is not configured');
  }
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' });
}

export class StripeAdapter implements PaymentGateway {
  readonly name: GatewayName = 'stripe';
  readonly displayName = 'Stripe';

  isAvailable(): boolean {
    return !!STRIPE_SECRET_KEY;
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntentResult> {
    const stripe = getStripeClient();

    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: params.amount_cents,
      currency: params.currency.toLowerCase(),
      metadata: params.metadata,
      description: params.description,
      automatic_payment_methods: { enabled: true },
    };

    if (params.customer_id) {
      intentParams.customer = params.customer_id;
    }

    const intent = await stripe.paymentIntents.create(intentParams);

    return {
      gateway_intent_id: intent.id,
      client_secret: intent.client_secret || '',
      status: 'requires_payment',
      gateway_response: {
        id: intent.id,
        status: intent.status,
        _fee_info: 'Stripe: 1.7% + 30c AU cards, 3.5% + 30c intl cards',
      },
    };
  }

  async confirmPayment(intentId: string): Promise<PaymentConfirmResult> {
    const stripe = getStripeClient();
    const intent = await stripe.paymentIntents.retrieve(intentId, {
      expand: ['latest_charge'],
    });

    const charge = intent.latest_charge as Stripe.Charge | null;

    return {
      gateway_payment_id: intent.id,
      status: intent.status === 'succeeded' ? 'succeeded' : intent.status === 'canceled' ? 'failed' : 'processing',
      amount_cents: intent.amount,
      fee_cents: charge?.balance_transaction
        ? undefined // Would need another API call to get fee
        : undefined,
      gateway_response: {
        id: intent.id,
        status: intent.status,
        charge_id: charge?.id,
      },
    };
  }

  async refund(paymentId: string, amount_cents?: number): Promise<RefundResult> {
    const stripe = getStripeClient();

    const refundParams: Stripe.RefundCreateParams = {
      payment_intent: paymentId,
    };
    if (amount_cents) {
      refundParams.amount = amount_cents;
    }

    const refund = await stripe.refunds.create(refundParams);

    return {
      gateway_refund_id: refund.id,
      status: refund.status === 'succeeded' ? 'succeeded' : 'pending',
      amount_cents: refund.amount,
      gateway_response: {
        id: refund.id,
        status: refund.status,
      },
    };
  }

  async getPayment(paymentId: string): Promise<PaymentConfirmResult> {
    return this.confirmPayment(paymentId);
  }

  async createCustomer(params: {
    email: string;
    name: string;
    phone?: string;
  }): Promise<GatewayCustomer> {
    const stripe = getStripeClient();
    const customer = await stripe.customers.create({
      email: params.email,
      name: params.name,
      phone: params.phone,
    });
    return { gateway_customer_id: customer.id };
  }

  async listPaymentMethods(customerId: string): Promise<GatewayPaymentMethod[]> {
    const stripe = getStripeClient();
    const methods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    });

    return methods.data.map((pm) => ({
      id: pm.id,
      type: 'card',
      last_four: pm.card?.last4,
      brand: pm.card?.brand,
      expiry_month: pm.card?.exp_month,
      expiry_year: pm.card?.exp_year,
    }));
  }

  async verifyWebhook(
    payload: string | Buffer,
    signature: string,
  ): Promise<WebhookVerifyResult> {
    const stripe = getStripeClient();
    const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf8');

    const event = stripe.webhooks.constructEvent(
      payloadStr,
      signature,
      STRIPE_WEBHOOK_SECRET
    );

    return {
      verified: true,
      event_type: event.type,
      event_data: event.data.object as Record<string, unknown>,
    };
  }
}
```

### 9.5 Afterpay Adapter

### File: `src/lib/payments/adapters/afterpay.adapter.ts`

```typescript
// ============================================================
// NexDrive Academy — Afterpay Gateway Adapter
// Buy-now-pay-later: students split lesson packages into 4.
// Afterpay AU is integrated via Square (Afterpay is owned by
// Block/Square). Uses Square Checkout with afterpay payment type.
//
// Minimum: $1 (but we enforce $200 for packages — practical min).
// Fees: ~6% (higher, but marketing value for conversions).
// ============================================================

import type { PaymentGateway } from './gateway.interface';
import type {
  CreateIntentParams,
  PaymentIntentResult,
  PaymentConfirmResult,
  RefundResult,
  GatewayCustomer,
  GatewayPaymentMethod,
  WebhookVerifyResult,
  GatewayName,
} from '../types';
import { GatewayError, PaymentFailedError } from '../errors';
import { AFTERPAY_MIN_CENTS } from '../constants';

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || '';
const SQUARE_API_BASE = process.env.SQUARE_API_URL || 'https://connect.squareup.com/v2';

export class AfterpayAdapter implements PaymentGateway {
  readonly name: GatewayName = 'afterpay';
  readonly displayName = 'Afterpay';

  isAvailable(): boolean {
    return !!(SQUARE_ACCESS_TOKEN && SQUARE_LOCATION_ID);
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntentResult> {
    if (params.amount_cents < AFTERPAY_MIN_CENTS) {
      throw new PaymentFailedError(
        `Afterpay requires a minimum of $${(AFTERPAY_MIN_CENTS / 100).toFixed(2)}. ` +
        `Current amount: $${(params.amount_cents / 100).toFixed(2)}`
      );
    }

    // Create Square Checkout with Afterpay as payment type
    const idempotencyKey = `ap_${params.metadata.payment_id || Date.now()}`;

    const response = await fetch(`${SQUARE_API_BASE}/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-11-20',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: params.description || 'NexDrive Academy Lesson Package',
          price_money: {
            amount: BigInt(params.amount_cents),
            currency: 'AUD',
          },
          location_id: SQUARE_LOCATION_ID,
        },
        checkout_options: {
          redirect_url: params.return_url || `${process.env.NEXT_PUBLIC_BASE_URL}/booking/complete`,
          accepted_payment_methods: {
            afterpay_clearpay: true,
            apple_pay: false,
            google_pay: false,
          },
        },
        pre_populated_data: {
          buyer_email: params.customer_email,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new GatewayError('afterpay', `Failed to create Afterpay checkout: ${response.status}`, error);
    }

    const data = await response.json();
    const link = data.payment_link;

    return {
      gateway_intent_id: link.id,
      client_secret: link.url,
      status: 'requires_payment',
      gateway_response: {
        ...data,
        _fee_info: 'Afterpay via Square: ~6% (BNPL premium)',
        _payment_schedule: '4 fortnightly instalments',
      },
    };
  }

  async confirmPayment(intentId: string): Promise<PaymentConfirmResult> {
    // Afterpay payments are captured via Square — same API
    const response = await fetch(`${SQUARE_API_BASE}/payments/${intentId}`, {
      headers: {
        'Square-Version': '2024-11-20',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) {
      throw new GatewayError('afterpay', `Failed to get payment: ${response.status}`);
    }

    const data = await response.json();
    const payment = data.payment;

    return {
      gateway_payment_id: payment.id,
      status: payment.status === 'COMPLETED' ? 'succeeded' : payment.status === 'FAILED' ? 'failed' : 'processing',
      amount_cents: Number(payment.amount_money?.amount || 0),
      fee_cents: Number(payment.processing_fee?.[0]?.amount_money?.amount || 0),
      gateway_response: data,
    };
  }

  async refund(paymentId: string, amount_cents?: number): Promise<RefundResult> {
    const idempotencyKey = `ap_refund_${paymentId}_${Date.now()}`;

    const body: Record<string, unknown> = {
      idempotency_key: idempotencyKey,
      payment_id: paymentId,
    };
    if (amount_cents) {
      body.amount_money = { amount: BigInt(amount_cents), currency: 'AUD' };
    }

    const response = await fetch(`${SQUARE_API_BASE}/refunds`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-11-20',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new GatewayError('afterpay', `Afterpay refund failed: ${response.status}`);
    }

    const data = await response.json();
    return {
      gateway_refund_id: data.refund.id,
      status: data.refund.status === 'COMPLETED' ? 'succeeded' : 'pending',
      amount_cents: Number(data.refund.amount_money?.amount || amount_cents || 0),
      gateway_response: data,
    };
  }

  async getPayment(paymentId: string): Promise<PaymentConfirmResult> {
    return this.confirmPayment(paymentId);
  }

  async createCustomer(_params: {
    email: string;
    name: string;
    phone?: string;
  }): Promise<GatewayCustomer> {
    // Afterpay doesn't maintain customers — handled by Square
    return { gateway_customer_id: `ap_${Date.now()}` };
  }

  async listPaymentMethods(_customerId: string): Promise<GatewayPaymentMethod[]> {
    return []; // Afterpay manages its own payment methods
  }

  async verifyWebhook(
    payload: string | Buffer,
    signature: string,
    headers?: Record<string, string>
  ): Promise<WebhookVerifyResult> {
    // Afterpay webhooks come through Square — use Square verification
    const crypto = await import('crypto');
    const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf8');
    const url = headers?.['x-square-notification-url'] || '';
    const toSign = url + payloadStr;
    const expectedSig = crypto
      .createHmac('sha256', signatureKey)
      .update(toSign)
      .digest('base64');

    if (signature !== expectedSig) {
      throw new GatewayError('afterpay', 'Invalid webhook signature');
    }

    const data = JSON.parse(payloadStr);
    return {
      verified: true,
      event_type: data.type || 'payment.updated',
      event_data: data.data || data,
    };
  }
}
```

---

## 10. Fee Comparison Logger

### File: `src/lib/payments/fee-logger.ts`

```typescript
// ============================================================
// NexDrive Academy — Gateway Fee Logger
// Logs fees per transaction so Rob can compare actual costs
// across gateways over time. Stored in gateway_response JSONB.
// ============================================================

import { db } from '@/db';
import { payments } from '@/db/schema';
import { eq } from 'drizzle-orm';

export interface FeeLogEntry {
  gateway: string;
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  fee_percentage: number;
  timestamp: string;
}

/**
 * Log gateway fees for a payment. Call after webhook confirms payment.
 * Updates the gateway_response JSONB with fee data.
 */
export async function logGatewayFees(
  paymentId: string,
  gatewayResponse: Record<string, unknown>,
  fee_cents?: number,
  net_cents?: number
): Promise<void> {
  if (!fee_cents && !net_cents) return;

  const [payment] = await db
    .select({ amount_cents: payments.amountCents, gateway_response: payments.gatewayResponse })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!payment) return;

  const actualFeeCents = fee_cents || (net_cents ? payment.amount_cents - net_cents : 0);
  const feePercentage = payment.amount_cents > 0
    ? Number(((actualFeeCents / payment.amount_cents) * 100).toFixed(3))
    : 0;

  const feeLog: FeeLogEntry = {
    gateway: (gatewayResponse as Record<string, unknown>)?.gateway as string || 'unknown',
    amount_cents: payment.amount_cents,
    fee_cents: actualFeeCents,
    net_cents: net_cents || payment.amount_cents - actualFeeCents,
    fee_percentage: feePercentage,
    timestamp: new Date().toISOString(),
  };

  const existingResponse = (payment.gateway_response as Record<string, unknown>) || {};

  await db
    .update(payments)
    .set({
      gatewayResponse: {
        ...existingResponse,
        ...gatewayResponse,
        _fee_log: feeLog,
      },
      updatedAt: new Date(),
    })
    .where(eq(payments.id, paymentId));
}
```

---

## 11. Core Payment Service

### File: `src/lib/payments/payment.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Payment Service (Core Business Logic)
// Reference: System Architecture v1.1 §4.2.7
//
// All payment operations go through this service. No direct
// gateway calls from API routes.
// ============================================================

import { db } from '@/db';
import { payments, students, contacts } from '@/db/schema';
import { and, eq, desc, gte, lte, sql } from 'drizzle-orm';
import { getDefaultGateway, getGateway, getGatewayForWebhook } from './gateway-factory';
import { validatePaymentTransition } from './state-machine';
import { generateInvoice, uploadInvoicePdf } from './invoice.service';
import { logGatewayFees } from './fee-logger';
import { eventBus } from '@/lib/events';
import type {
  CreatePaymentIntentInput,
  RecordManualPaymentInput,
  ConfirmTransferInput,
  PaymentResponse,
  PaymentIntentResponse,
  GatewayName,
  PaymentStatus,
} from './types';
import type { AuthContext } from '@/lib/auth/types';
import {
  PaymentNotFoundError,
  PaymentFailedError,
  RefundExceedsPaymentError,
} from './errors';
import { INVOICE_PREFIX, INVOICE_REDIS_COUNTER_KEY } from './constants';
import { redis } from '@/lib/redis';

// ─── Invoice Numbering ─────────────────────

async function generateInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const counter = await redis.incr(`${INVOICE_REDIS_COUNTER_KEY}:${year}`);
  return `${INVOICE_PREFIX}-${year}-${String(counter).padStart(4, '0')}`;
}

// ─── Create Payment Intent ─────────────────

/**
 * Create a payment intent via a gateway.
 * Returns client_secret for frontend to complete payment.
 */
export async function createPaymentIntent(
  input: CreatePaymentIntentInput,
  auth: AuthContext
): Promise<PaymentIntentResponse> {
  // 1. Get the appropriate gateway
  const gateway = getDefaultGateway(input.gateway as GatewayName | undefined);

  // 2. Create payment record (pending)
  const invoiceNumber = await generateInvoiceNumber();

  const [paymentRecord] = await db.insert(payments).values({
    studentId: auth.student_id || null,
    contactId: null,
    bookingId: input.booking_id || null,
    packageId: input.package_id || null,
    amountCents: input.amount_cents,
    currency: 'AUD',
    paymentMethod: input.payment_method || 'card',
    gateway: gateway.name,
    status: 'pending',
    invoiceNumber,
    description: input.description || null,
  }).returning();

  // 3. Create intent via gateway
  try {
    const result = await gateway.createIntent({
      amount_cents: input.amount_cents,
      currency: 'AUD',
      customer_email: auth.email,
      customer_name: auth.name,
      description: input.description || `NexDrive Payment ${invoiceNumber}`,
      metadata: {
        payment_id: paymentRecord.id,
        invoice_number: invoiceNumber,
        booking_id: input.booking_id || '',
        package_id: input.package_id || '',
      },
      return_url: input.return_url,
    });

    // 4. Update record with gateway intent ID
    await db.update(payments).set({
      gatewayPaymentId: result.gateway_intent_id,
      gatewayResponse: result.gateway_response as Record<string, unknown>,
      status: 'processing',
      updatedAt: new Date(),
    }).where(eq(payments.id, paymentRecord.id));

    return {
      payment_id: paymentRecord.id,
      client_secret: result.client_secret,
      gateway: gateway.name,
      gateway_intent_id: result.gateway_intent_id,
      amount_cents: input.amount_cents,
      currency: 'AUD',
      status: result.status,
    };
  } catch (error) {
    // Mark payment as failed if gateway errors
    await db.update(payments).set({
      status: 'failed',
      gatewayResponse: { error: String(error) },
      updatedAt: new Date(),
    }).where(eq(payments.id, paymentRecord.id));
    throw error;
  }
}

// ─── Handle Webhook ────────────────────────

/**
 * Process a webhook from a specific gateway.
 * Called by gateway-specific webhook route handlers.
 */
export async function handleWebhook(
  gatewayName: GatewayName,
  payload: string | Buffer,
  signature: string,
  headers?: Record<string, string>
): Promise<void> {
  // 1. Verify signature
  const adapter = getGatewayForWebhook(gatewayName);
  const { event_type, event_data } = await adapter.verifyWebhook(
    payload, signature, headers
  );

  // 2. Extract payment ID from event data
  const gatewayPaymentId = extractGatewayPaymentId(event_data, gatewayName);
  if (!gatewayPaymentId) {
    console.warn(`[WEBHOOK:${gatewayName}] No payment ID in event: ${event_type}`);
    return;
  }

  // 3. Find our payment record
  const [paymentRecord] = await db
    .select()
    .from(payments)
    .where(eq(payments.gatewayPaymentId, gatewayPaymentId))
    .limit(1);

  if (!paymentRecord) {
    console.warn(`[WEBHOOK:${gatewayName}] Payment not found: ${gatewayPaymentId}`);
    return;
  }

  // 4. Process based on event type
  if (isPaymentSucceededEvent(event_type, gatewayName)) {
    await handlePaymentSucceeded(paymentRecord.id, adapter, gatewayPaymentId, event_data);
  } else if (isPaymentFailedEvent(event_type, gatewayName)) {
    await handlePaymentFailed(paymentRecord.id, event_data);
  } else if (isRefundEvent(event_type, gatewayName)) {
    await handleRefundCompleted(paymentRecord.id, event_data);
  }
}

async function handlePaymentSucceeded(
  paymentId: string,
  adapter: import('./adapters/gateway.interface').PaymentGateway,
  gatewayPaymentId: string,
  eventData: Record<string, unknown>
): Promise<void> {
  // Get full payment details from gateway (includes fees)
  let paymentDetails;
  try {
    paymentDetails = await adapter.getPayment(gatewayPaymentId);
  } catch {
    paymentDetails = null;
  }

  validatePaymentTransition('processing', 'completed');

  await db.update(payments).set({
    status: 'completed',
    gatewayResponse: eventData,
    updatedAt: new Date(),
  }).where(eq(payments.id, paymentId));

  // Log fees
  if (paymentDetails?.fee_cents || paymentDetails?.net_cents) {
    await logGatewayFees(
      paymentId,
      eventData,
      paymentDetails.fee_cents,
      paymentDetails.net_cents
    );
  }

  // Generate and upload invoice PDF
  try {
    await generateAndStoreInvoice(paymentId);
  } catch (err) {
    console.error(`[PAYMENT] Failed to generate invoice for ${paymentId}:`, err);
  }

  // Emit event for notification engine
  eventBus.emit('PAYMENT_RECEIVED', { payment_id: paymentId });
}

async function handlePaymentFailed(
  paymentId: string,
  eventData: Record<string, unknown>
): Promise<void> {
  await db.update(payments).set({
    status: 'failed',
    gatewayResponse: eventData,
    updatedAt: new Date(),
  }).where(eq(payments.id, paymentId));

  eventBus.emit('PAYMENT_FAILED', { payment_id: paymentId });
}

async function handleRefundCompleted(
  paymentId: string,
  eventData: Record<string, unknown>
): Promise<void> {
  const refundAmount = extractRefundAmount(eventData);

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!payment) return;

  const totalRefunded = (payment.refundAmountCents || 0) + (refundAmount || 0);
  const newStatus = totalRefunded >= payment.amountCents ? 'refunded' : 'partially_refunded';

  await db.update(payments).set({
    status: newStatus,
    refundAmountCents: totalRefunded,
    refundedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(payments.id, paymentId));

  eventBus.emit('PAYMENT_REFUNDED', { payment_id: paymentId, amount_cents: refundAmount });
}

// ─── Record Manual Payment ─────────────────

/**
 * Record a cash or bank transfer payment. Instructor-only.
 */
export async function recordManualPayment(
  input: RecordManualPaymentInput,
  auth: AuthContext
): Promise<PaymentResponse> {
  if (auth.role !== 'instructor' && auth.role !== 'admin') {
    throw new PaymentFailedError('Only instructors can record manual payments');
  }

  const invoiceNumber = await generateInvoiceNumber();

  const status = input.payment_method === 'cash' ? 'completed' : 'pending';

  const [record] = await db.insert(payments).values({
    studentId: input.student_id || null,
    contactId: input.contact_id || null,
    bookingId: input.booking_id || null,
    amountCents: input.amount_cents,
    currency: 'AUD',
    paymentMethod: input.payment_method,
    gateway: null,
    status,
    invoiceNumber,
    description: input.description || (input.payment_method === 'cash' ? 'Cash payment' : 'Bank transfer'),
    gatewayResponse: input.bank_reference
      ? { bank_reference: input.bank_reference, notes: input.notes }
      : input.notes ? { notes: input.notes } : null,
  }).returning();

  if (status === 'completed') {
    eventBus.emit('PAYMENT_RECEIVED', { payment_id: record.id });
    try {
      await generateAndStoreInvoice(record.id);
    } catch (err) {
      console.error(`[PAYMENT] Failed to generate invoice for manual payment ${record.id}:`, err);
    }
  }

  return toPaymentResponse(record);
}

// ─── Confirm Bank Transfer ─────────────────

/**
 * Instructor confirms a pending bank transfer.
 */
export async function confirmTransfer(
  input: ConfirmTransferInput,
  auth: AuthContext
): Promise<PaymentResponse> {
  if (auth.role !== 'instructor' && auth.role !== 'admin') {
    throw new PaymentFailedError('Only instructors can confirm transfers');
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, input.payment_id))
    .limit(1);

  if (!payment) throw new PaymentNotFoundError(input.payment_id);

  validatePaymentTransition(payment.status, 'completed');

  const [updated] = await db.update(payments).set({
    status: 'completed',
    gatewayResponse: {
      ...((payment.gatewayResponse as Record<string, unknown>) || {}),
      bank_reference: input.bank_reference,
      confirmed_by: auth.user_id,
      confirmed_at: new Date().toISOString(),
      notes: input.notes,
    },
    updatedAt: new Date(),
  }).where(eq(payments.id, input.payment_id)).returning();

  eventBus.emit('PAYMENT_RECEIVED', { payment_id: updated.id });

  try {
    await generateAndStoreInvoice(updated.id);
  } catch (err) {
    console.error(`[PAYMENT] Failed to generate invoice for transfer ${updated.id}:`, err);
  }

  return toPaymentResponse(updated);
}

// ─── Get Payment ───────────────────────────

export async function getPayment(
  paymentId: string,
  auth: AuthContext
): Promise<PaymentResponse> {
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!payment) throw new PaymentNotFoundError(paymentId);

  // Students can only see their own payments
  if (auth.role === 'student' && payment.studentId !== auth.student_id) {
    throw new PaymentNotFoundError(paymentId);
  }

  return toPaymentResponse(payment);
}

// ─── List Payments ─────────────────────────

export async function listPayments(
  auth: AuthContext,
  filters?: {
    student_id?: string;
    status?: string;
    date_from?: string;
    date_to?: string;
    cursor?: string;
    limit?: number;
  }
): Promise<{ payments: PaymentResponse[]; cursor?: string; has_more: boolean }> {
  const limit = Math.min(filters?.limit || 20, 50);
  const conditions = [];

  // Students can only see their own
  if (auth.role === 'student') {
    conditions.push(eq(payments.studentId, auth.student_id!));
  } else if (filters?.student_id) {
    conditions.push(eq(payments.studentId, filters.student_id));
  }

  if (filters?.status) {
    conditions.push(eq(payments.status, filters.status));
  }
  if (filters?.date_from) {
    conditions.push(gte(payments.createdAt, new Date(filters.date_from)));
  }
  if (filters?.date_to) {
    conditions.push(lte(payments.createdAt, new Date(filters.date_to)));
  }
  if (filters?.cursor) {
    conditions.push(lte(payments.createdAt, new Date(filters.cursor)));
  }

  const rows = await db
    .select()
    .from(payments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(payments.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const results = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? results[results.length - 1].createdAt.toISOString() : undefined;

  return {
    payments: results.map(toPaymentResponse),
    cursor: nextCursor,
    has_more: hasMore,
  };
}

// ─── Helpers ───────────────────────────────

function toPaymentResponse(row: typeof payments.$inferSelect): PaymentResponse {
  return {
    id: row.id,
    student_id: row.studentId,
    contact_id: row.contactId,
    booking_id: row.bookingId,
    package_id: row.packageId,
    amount_cents: row.amountCents,
    currency: row.currency,
    payment_method: row.paymentMethod as PaymentResponse['payment_method'],
    gateway: row.gateway as PaymentResponse['gateway'],
    status: row.status as PaymentResponse['status'],
    refund_amount_cents: row.refundAmountCents || 0,
    invoice_number: row.invoiceNumber,
    invoice_url: row.invoiceUrl,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function extractGatewayPaymentId(
  eventData: Record<string, unknown>,
  gateway: GatewayName
): string | null {
  // Different gateways nest the ID differently
  switch (gateway) {
    case 'tyro':
      return (eventData.payRequestId || eventData.pay_request_id || eventData.id) as string || null;
    case 'square':
    case 'afterpay':
      return (eventData.object?.payment?.id || eventData.payment?.id || eventData.id) as string || null;
    case 'pin':
      return (eventData.response?.token || eventData.token) as string || null;
    case 'stripe':
      return (eventData.id || eventData.payment_intent) as string || null;
    default:
      return null;
  }
}

function isPaymentSucceededEvent(eventType: string, gateway: GatewayName): boolean {
  const successEvents: Record<string, string[]> = {
    tyro: ['payment.completed', 'payment.approved'],
    square: ['payment.completed', 'payment.updated'],
    pin: ['charge.captured', 'charge.succeeded'],
    stripe: ['payment_intent.succeeded', 'charge.succeeded'],
    afterpay: ['payment.completed'],
  };
  return (successEvents[gateway] || []).includes(eventType);
}

function isPaymentFailedEvent(eventType: string, gateway: GatewayName): boolean {
  const failEvents: Record<string, string[]> = {
    tyro: ['payment.failed', 'payment.declined'],
    square: ['payment.failed'],
    pin: ['charge.failed'],
    stripe: ['payment_intent.payment_failed'],
    afterpay: ['payment.failed'],
  };
  return (failEvents[gateway] || []).includes(eventType);
}

function isRefundEvent(eventType: string, gateway: GatewayName): boolean {
  const refundEvents: Record<string, string[]> = {
    tyro: ['refund.completed'],
    square: ['refund.completed', 'refund.updated'],
    pin: ['refund.succeeded'],
    stripe: ['charge.refunded'],
    afterpay: ['refund.completed'],
  };
  return (refundEvents[gateway] || []).includes(eventType);
}

function extractRefundAmount(eventData: Record<string, unknown>): number {
  // Try common paths for refund amount
  return (
    (eventData.amount_cents as number) ||
    (eventData.amount as number) ||
    (eventData.refund?.amount as number) ||
    (eventData.amount_money?.amount as number) ||
    0
  );
}

async function generateAndStoreInvoice(paymentId: string): Promise<void> {
  const pdfBuffer = await generateInvoice(paymentId);
  const url = await uploadInvoicePdf(paymentId, pdfBuffer);

  await db.update(payments).set({
    invoiceUrl: url,
    updatedAt: new Date(),
  }).where(eq(payments.id, paymentId));
}
```

---

## 12. Package Service

### File: `src/lib/payments/package.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Package Credit Service
// Purchase prepaid lesson packages, track balance, redeem.
// ============================================================

import { db } from '@/db';
import { packages, studentPackages, payments } from '@/db/schema';
import { and, eq, gt, gte, lte, desc, sql, isNull, or } from 'drizzle-orm';
import { addDays } from 'date-fns';
import type { AuthContext } from '@/lib/auth/types';
import type { StudentPackageResponse, PurchasePackageInput } from './types';
import {
  PackageNotFoundError,
  InsufficientCreditsError,
  NoActivePackageError,
} from './errors';
import { createPaymentIntent } from './payment.service';
import { eventBus } from '@/lib/events';

// ─── List Available Packages ───────────────

export async function listAvailablePackages(): Promise<typeof packages.$inferSelect[]> {
  return db
    .select()
    .from(packages)
    .where(eq(packages.isActive, true))
    .orderBy(packages.priceCents);
}

// ─── Purchase Package ──────────────────────

/**
 * Initiate package purchase. Creates a payment intent for the package.
 * After payment succeeds (via webhook), the package is activated.
 */
export async function purchasePackage(
  packageId: string,
  input: PurchasePackageInput,
  auth: AuthContext
): Promise<{ payment_intent: Awaited<ReturnType<typeof createPaymentIntent>> }> {
  // 1. Get the package
  const [pkg] = await db
    .select()
    .from(packages)
    .where(and(eq(packages.id, packageId), eq(packages.isActive, true)))
    .limit(1);

  if (!pkg) throw new PackageNotFoundError(packageId);

  // 2. Create payment intent for the package price
  const paymentIntent = await createPaymentIntent(
    {
      amount_cents: pkg.priceCents,
      package_id: packageId,
      gateway: input.gateway,
      payment_method: input.gateway === 'afterpay' ? 'afterpay' : 'card',
      description: `NexDrive Package: ${pkg.name}`,
      return_url: input.return_url,
    },
    auth
  );

  return { payment_intent: paymentIntent };
}

// ─── Activate Package (called after payment succeeds) ──

/**
 * Activate a purchased package. Called by the PAYMENT_RECEIVED
 * event handler when a package payment completes.
 */
export async function activatePackage(
  paymentId: string,
  studentId: string,
  packageId: string
): Promise<void> {
  const [pkg] = await db
    .select()
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);

  if (!pkg) return;

  const expiresAt = pkg.validForDays
    ? addDays(new Date(), pkg.validForDays)
    : null;

  await db.insert(studentPackages).values({
    studentId,
    packageId,
    paymentId,
    creditsTotal: pkg.totalCredits,
    creditsUsed: 0,
    expiresAt,
    status: 'active',
  });

  eventBus.emit('PACKAGE_PURCHASED', {
    student_id: studentId,
    package_id: packageId,
    credits: pkg.totalCredits,
  });
}

// ─── Get Student Packages ──────────────────

export async function getStudentPackages(
  studentId: string
): Promise<StudentPackageResponse[]> {
  const rows = await db
    .select({
      sp: studentPackages,
      pkg: packages,
    })
    .from(studentPackages)
    .innerJoin(packages, eq(studentPackages.packageId, packages.id))
    .where(eq(studentPackages.studentId, studentId))
    .orderBy(desc(studentPackages.purchasedAt));

  return rows.map(({ sp, pkg }) => ({
    id: sp.id,
    package_name: pkg.name,
    package_description: pkg.description,
    credits_total: sp.creditsTotal,
    credits_used: sp.creditsUsed,
    credits_remaining: sp.creditsTotal - sp.creditsUsed,
    purchased_at: sp.purchasedAt.toISOString(),
    expires_at: sp.expiresAt?.toISOString() || null,
    status: sp.status as StudentPackageResponse['status'],
    applicable_services: (pkg.applicableServices || []) as string[],
  }));
}

// ─── Redeem Package Credit ─────────────────

/**
 * Deduct one credit from the student's active package.
 * Used during booking confirmation when payment_method = 'package_credit'.
 * Returns the student_package_id used.
 *
 * Selection priority: earliest expiry first, then earliest purchase.
 */
export async function redeemCredit(
  studentId: string,
  serviceId?: string
): Promise<{ student_package_id: string; credits_remaining: number }> {
  // Find active packages with remaining credits, ordered by expiry
  const activePkgs = await db
    .select({
      sp: studentPackages,
      pkg: packages,
    })
    .from(studentPackages)
    .innerJoin(packages, eq(studentPackages.packageId, packages.id))
    .where(
      and(
        eq(studentPackages.studentId, studentId),
        eq(studentPackages.status, 'active'),
        gt(sql`${studentPackages.creditsTotal} - ${studentPackages.creditsUsed}`, 0),
        or(
          isNull(studentPackages.expiresAt),
          gte(studentPackages.expiresAt, new Date())
        )
      )
    )
    .orderBy(studentPackages.expiresAt, studentPackages.purchasedAt);

  // Filter by applicable service if specified
  let eligiblePkg = activePkgs.find(({ pkg }) => {
    if (!serviceId) return true;
    if (!pkg.applicableServices || pkg.applicableServices.length === 0) return true;
    return pkg.applicableServices.includes(serviceId);
  });

  if (!eligiblePkg) {
    throw new NoActivePackageError();
  }

  // Deduct credit
  const newUsed = eligiblePkg.sp.creditsUsed + 1;
  const newRemaining = eligiblePkg.sp.creditsTotal - newUsed;
  const newStatus = newRemaining <= 0 ? 'exhausted' : 'active';

  await db.update(studentPackages).set({
    creditsUsed: newUsed,
    status: newStatus,
    updatedAt: new Date(),
  }).where(eq(studentPackages.id, eligiblePkg.sp.id));

  // Low credits alert (≤2 remaining)
  if (newRemaining > 0 && newRemaining <= 2) {
    eventBus.emit('PACKAGE_LOW_CREDITS', {
      student_id: studentId,
      student_package_id: eligiblePkg.sp.id,
      credits_remaining: newRemaining,
    });
  }

  return {
    student_package_id: eligiblePkg.sp.id,
    credits_remaining: newRemaining,
  };
}

// ─── Expire Packages (Cron Job) ────────────

/**
 * Mark expired packages. Run daily via Vercel cron.
 */
export async function expirePackages(): Promise<number> {
  const result = await db.update(studentPackages).set({
    status: 'expired',
    updatedAt: new Date(),
  }).where(
    and(
      eq(studentPackages.status, 'active'),
      lte(studentPackages.expiresAt, new Date())
    )
  ).returning();

  return result.length;
}
```

---

## 13. Voucher Service

### File: `src/lib/payments/voucher.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Voucher Validation & Redemption
// Types: percentage, fixed_amount, free_lesson
// ============================================================

import { db } from '@/db';
import { vouchers } from '@/db/schema';
import { and, eq, gte, lte, or, isNull, sql } from 'drizzle-orm';
import type { ValidateVoucherInput, VoucherValidationResponse } from './types';
import {
  VoucherNotFoundError,
  VoucherExpiredError,
  VoucherExhaustedError,
  VoucherNotApplicableError,
} from './errors';

/**
 * Validate a voucher code. Does NOT consume it.
 * Returns discount calculation if amount_cents provided.
 */
export async function validateVoucher(
  input: ValidateVoucherInput
): Promise<VoucherValidationResponse> {
  const code = input.code.toUpperCase().trim();

  // 1. Find the voucher
  const [voucher] = await db
    .select()
    .from(vouchers)
    .where(eq(vouchers.code, code))
    .limit(1);

  if (!voucher || !voucher.isActive) {
    throw new VoucherNotFoundError(code);
  }

  // 2. Check date validity
  const now = new Date();
  if (voucher.validFrom > now) {
    throw new VoucherNotFoundError(code); // Not yet active — don't reveal it
  }
  if (voucher.validUntil && voucher.validUntil < now) {
    throw new VoucherExpiredError(code);
  }

  // 3. Check usage limits
  if (voucher.maxUses !== null && voucher.timesUsed >= voucher.maxUses) {
    throw new VoucherExhaustedError(code);
  }

  // 4. Check service applicability
  if (
    input.service_id &&
    voucher.applicableServices &&
    voucher.applicableServices.length > 0 &&
    !voucher.applicableServices.includes(input.service_id)
  ) {
    throw new VoucherNotApplicableError(code, input.service_id);
  }

  // 5. Calculate discount
  let discountAppliedCents: number | null = null;
  if (input.amount_cents) {
    discountAppliedCents = calculateDiscount(voucher, input.amount_cents);
  }

  return {
    valid: true,
    code,
    voucher_type: voucher.voucherType as VoucherValidationResponse['voucher_type'],
    discount_percent: voucher.discountPercent,
    discount_cents: voucher.discountCents,
    discount_applied_cents: discountAppliedCents,
    message: formatVoucherMessage(voucher),
  };
}

/**
 * Consume a voucher (increment usage count).
 * Call AFTER payment is confirmed.
 */
export async function consumeVoucher(
  code: string,
  studentId?: string
): Promise<void> {
  const normalised = code.toUpperCase().trim();

  await db.update(vouchers).set({
    timesUsed: sql`${vouchers.timesUsed} + 1`,
    updatedAt: new Date(),
  }).where(eq(vouchers.code, normalised));
}

function calculateDiscount(
  voucher: typeof vouchers.$inferSelect,
  amountCents: number
): number {
  switch (voucher.voucherType) {
    case 'percentage':
      return Math.round(amountCents * ((voucher.discountPercent || 0) / 100));
    case 'fixed_amount':
      return Math.min(voucher.discountCents || 0, amountCents);
    case 'free_lesson':
      return amountCents; // 100% discount
    default:
      return 0;
  }
}

function formatVoucherMessage(
  voucher: typeof vouchers.$inferSelect
): string {
  switch (voucher.voucherType) {
    case 'percentage':
      return `${voucher.discountPercent}% discount applied`;
    case 'fixed_amount':
      return `$${((voucher.discountCents || 0) / 100).toFixed(2)} discount applied`;
    case 'free_lesson':
      return 'Free lesson voucher applied';
    default:
      return 'Voucher applied';
  }
}
```

---

## 14. Invoice Service

### File: `src/lib/payments/invoice.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Invoice Generation + PDF + R2 Upload
// Auto-numbered: NXD-{YEAR}-{NNNN}
// Must show ABN, GST (if applicable), gateway used.
// ============================================================

import { db } from '@/db';
import { payments, students, contacts, profiles, bookings, services, packages } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { BUSINESS_DETAILS, GST_RATE, INVOICE_R2_PATH } from './constants';
import type { InvoiceData } from './types';
import { PaymentNotFoundError } from './errors';

// Uses @react-pdf/renderer for PDF generation (server-side)
// Alternatively, use pdfkit or jsPDF. The interface is what matters.

/**
 * Generate invoice data for a payment.
 */
export async function getInvoiceData(paymentId: string): Promise<InvoiceData> {
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!payment) throw new PaymentNotFoundError(paymentId);

  // Get student/contact info
  let customerName = 'Customer';
  let customerEmail = '';

  if (payment.studentId) {
    const [student] = await db
      .select({ profile: profiles })
      .from(students)
      .innerJoin(profiles, eq(students.profileId, profiles.id))
      .where(eq(students.id, payment.studentId))
      .limit(1);

    if (student) {
      customerName = `${student.profile.firstName} ${student.profile.lastName}`;
      customerEmail = student.profile.email || '';
    }
  } else if (payment.contactId) {
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, payment.contactId))
      .limit(1);

    if (contact) {
      customerName = `${contact.firstName} ${contact.lastName || ''}`.trim();
      customerEmail = contact.email || '';
    }
  }

  // Build line items
  const lineItems: InvoiceData['line_items'] = [];

  if (payment.bookingId) {
    // Single lesson booking
    const [booking] = await db
      .select({ booking: bookings, service: services })
      .from(bookings)
      .innerJoin(services, eq(bookings.serviceId, services.id))
      .where(eq(bookings.id, payment.bookingId))
      .limit(1);

    if (booking) {
      lineItems.push({
        description: `${booking.service.name} (${booking.service.durationMinutes} min)`,
        quantity: 1,
        unit_price_cents: payment.amountCents,
        total_cents: payment.amountCents,
      });
    }
  } else if (payment.packageId) {
    // Package purchase
    const [pkg] = await db
      .select()
      .from(packages)
      .where(eq(packages.id, payment.packageId))
      .limit(1);

    if (pkg) {
      lineItems.push({
        description: `${pkg.name} (${pkg.totalCredits} lesson credits)`,
        quantity: 1,
        unit_price_cents: payment.amountCents,
        total_cents: payment.amountCents,
      });
    }
  }

  // Fallback line item
  if (lineItems.length === 0) {
    lineItems.push({
      description: payment.description || 'Driving Lesson Payment',
      quantity: 1,
      unit_price_cents: payment.amountCents,
      total_cents: payment.amountCents,
    });
  }

  // GST calculation
  const gstCents = BUSINESS_DETAILS.gst_registered
    ? Math.round(payment.amountCents * GST_RATE / (1 + GST_RATE)) // GST-inclusive
    : 0;
  const subtotalCents = payment.amountCents - gstCents;

  return {
    invoice_number: payment.invoiceNumber || 'DRAFT',
    business_name: BUSINESS_DETAILS.name,
    abn: BUSINESS_DETAILS.abn,
    business_address: BUSINESS_DETAILS.address,
    student_name: customerName,
    student_email: customerEmail,
    line_items: lineItems,
    subtotal_cents: subtotalCents,
    gst_cents: gstCents,
    total_cents: payment.amountCents,
    payment_method: payment.paymentMethod,
    gateway: payment.gateway,
    paid_at: payment.updatedAt.toISOString(),
    invoice_date: payment.createdAt.toISOString(),
  };
}

/**
 * Generate invoice PDF from payment data.
 * Returns a Buffer containing the PDF bytes.
 */
export async function generateInvoice(paymentId: string): Promise<Buffer> {
  const data = await getInvoiceData(paymentId);

  // Using pdfkit for server-side PDF generation
  const PDFDocument = (await import('pdfkit')).default;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(24).text(data.business_name, { align: 'left' });
    if (data.abn) {
      doc.fontSize(10).text(`ABN: ${data.abn}`);
    }
    doc.text(data.business_address);
    doc.moveDown();

    // Invoice details
    doc.fontSize(18).text('TAX INVOICE', { align: 'right' });
    doc.fontSize(10)
      .text(`Invoice: ${data.invoice_number}`, { align: 'right' })
      .text(`Date: ${new Date(data.invoice_date).toLocaleDateString('en-AU')}`, { align: 'right' });
    doc.moveDown();

    // Bill To
    doc.fontSize(12).text('Bill To:');
    doc.fontSize(10).text(data.student_name);
    if (data.student_email) doc.text(data.student_email);
    doc.moveDown();

    // Line items table
    doc.fontSize(10);
    const tableTop = doc.y;
    doc.text('Description', 50, tableTop, { width: 250 });
    doc.text('Qty', 310, tableTop, { width: 40, align: 'center' });
    doc.text('Unit Price', 360, tableTop, { width: 80, align: 'right' });
    doc.text('Total', 450, tableTop, { width: 80, align: 'right' });

    doc.moveTo(50, doc.y + 5).lineTo(530, doc.y + 5).stroke();
    doc.moveDown(0.5);

    for (const item of data.line_items) {
      const y = doc.y;
      doc.text(item.description, 50, y, { width: 250 });
      doc.text(String(item.quantity), 310, y, { width: 40, align: 'center' });
      doc.text(formatCurrency(item.unit_price_cents), 360, y, { width: 80, align: 'right' });
      doc.text(formatCurrency(item.total_cents), 450, y, { width: 80, align: 'right' });
      doc.moveDown();
    }

    doc.moveTo(50, doc.y).lineTo(530, doc.y).stroke();
    doc.moveDown(0.5);

    // Totals
    doc.text('Subtotal:', 360, doc.y, { width: 80, align: 'right' });
    doc.text(formatCurrency(data.subtotal_cents), 450, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });
    doc.moveDown(0.3);

    if (data.gst_cents > 0) {
      doc.text('GST (10%):', 360, doc.y, { width: 80, align: 'right' });
      doc.text(formatCurrency(data.gst_cents), 450, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });
      doc.moveDown(0.3);
    }

    doc.fontSize(12).font('Helvetica-Bold');
    doc.text('Total:', 360, doc.y, { width: 80, align: 'right' });
    doc.text(formatCurrency(data.total_cents), 450, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });

    doc.moveDown(2);
    doc.font('Helvetica').fontSize(9);
    doc.text(`Payment method: ${data.payment_method}${data.gateway ? ` via ${data.gateway}` : ''}`, 50);
    doc.text(`Paid: ${new Date(data.paid_at).toLocaleDateString('en-AU')}`, 50);

    if (!BUSINESS_DETAILS.gst_registered) {
      doc.moveDown();
      doc.text('NexDrive Academy is not registered for GST. No GST is included in this invoice.', 50);
    }

    doc.end();
  });
}

/**
 * Upload invoice PDF to Cloudflare R2.
 */
export async function uploadInvoicePdf(
  paymentId: string,
  pdfBuffer: Buffer
): Promise<string> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });

  const key = `${INVOICE_R2_PATH}/${paymentId}.pdf`;

  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME || 'nexdrive',
    Key: key,
    Body: pdfBuffer,
    ContentType: 'application/pdf',
  }));

  // Return the R2 object path (signed URLs generated on access)
  return key;
}

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
```

---

## 15. Refund Service

### File: `src/lib/payments/refund.service.ts`

```typescript
// ============================================================
// NexDrive Academy — Refund Processing
// Full and partial refunds. Routes through original gateway.
// ============================================================

import { db } from '@/db';
import { payments, studentPackages } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getGatewayForWebhook } from './gateway-factory';
import { validatePaymentTransition } from './state-machine';
import type { RefundPaymentInput, PaymentResponse, GatewayName } from './types';
import type { AuthContext } from '@/lib/auth/types';
import { PaymentNotFoundError, RefundExceedsPaymentError, PaymentFailedError } from './errors';
import { eventBus } from '@/lib/events';

/**
 * Initiate a refund for a payment.
 * Instructor/Admin only. Routes through the original gateway.
 */
export async function initiateRefund(
  paymentId: string,
  input: RefundPaymentInput,
  auth: AuthContext
): Promise<PaymentResponse> {
  if (auth.role !== 'instructor' && auth.role !== 'admin') {
    throw new PaymentFailedError('Only instructors/admins can process refunds');
  }

  // 1. Get the payment
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!payment) throw new PaymentNotFoundError(paymentId);

  // 2. Calculate refund amount
  const maxRefundable = payment.amountCents - (payment.refundAmountCents || 0);
  const refundAmount = input.amount_cents || maxRefundable; // Default = full refund

  if (refundAmount > maxRefundable) {
    throw new RefundExceedsPaymentError(refundAmount, maxRefundable);
  }

  if (refundAmount <= 0) {
    throw new PaymentFailedError('Nothing to refund');
  }

  // 3. Process refund through gateway (if applicable)
  if (payment.gateway && payment.gatewayPaymentId) {
    const adapter = getGatewayForWebhook(payment.gateway as GatewayName);
    
    try {
      const result = await adapter.refund(
        payment.gatewayPaymentId,
        refundAmount < maxRefundable ? refundAmount : undefined // Full = no amount param
      );

      // For async gateways, status will be updated via webhook
      if (result.status === 'succeeded') {
        return await completeRefund(paymentId, refundAmount, input.reason);
      }

      // Mark as refund requested (webhook will complete it)
      const newStatus = 'partially_refunded'; // Temporary until webhook
      await db.update(payments).set({
        refundReason: input.reason,
        gatewayResponse: {
          ...((payment.gatewayResponse as Record<string, unknown>) || {}),
          refund_request: result.gateway_response,
        },
        updatedAt: new Date(),
      }).where(eq(payments.id, paymentId));
      
    } catch (error) {
      throw new PaymentFailedError(`Refund failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    // Manual payment (cash/transfer) — refund immediately
    return await completeRefund(paymentId, refundAmount, input.reason);
  }

  // Return current state
  const [updated] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  return toPaymentResponse(updated);
}

async function completeRefund(
  paymentId: string,
  refundAmountCents: number,
  reason: string
): Promise<PaymentResponse> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!payment) throw new PaymentNotFoundError(paymentId);

  const totalRefunded = (payment.refundAmountCents || 0) + refundAmountCents;
  const newStatus = totalRefunded >= payment.amountCents ? 'refunded' : 'partially_refunded';

  validatePaymentTransition(payment.status, newStatus);

  const [updated] = await db.update(payments).set({
    status: newStatus,
    refundAmountCents: totalRefunded,
    refundReason: reason,
    refundedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(payments.id, paymentId)).returning();

  // If a package was refunded, adjust credits
  if (payment.packageId) {
    await handlePackageRefund(payment.studentId!, payment.packageId, newStatus === 'refunded');
  }

  eventBus.emit('PAYMENT_REFUNDED', {
    payment_id: paymentId,
    amount_cents: refundAmountCents,
    reason,
  });

  return toPaymentResponse(updated);
}

/**
 * If a package payment is refunded, cancel the package.
 */
async function handlePackageRefund(
  studentId: string,
  packageId: string,
  fullRefund: boolean
): Promise<void> {
  if (!fullRefund) return; // Partial refund doesn't cancel the package

  await db.update(studentPackages).set({
    status: 'cancelled',
    updatedAt: new Date(),
  }).where(
    eq(studentPackages.packageId, packageId)
  );
}

function toPaymentResponse(row: typeof payments.$inferSelect): PaymentResponse {
  return {
    id: row.id,
    student_id: row.studentId,
    contact_id: row.contactId,
    booking_id: row.bookingId,
    package_id: row.packageId,
    amount_cents: row.amountCents,
    currency: row.currency,
    payment_method: row.paymentMethod as PaymentResponse['payment_method'],
    gateway: row.gateway as PaymentResponse['gateway'],
    status: row.status as PaymentResponse['status'],
    refund_amount_cents: row.refundAmountCents || 0,
    invoice_number: row.invoiceNumber,
    invoice_url: row.invoiceUrl,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
```

---

## 16. API Route Handlers

### 16.1 POST /api/v1/payments/create-intent

```typescript
// File: src/app/api/v1/payments/create-intent/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { CreatePaymentIntentSchema } from '@/lib/payments/types';
import { createPaymentIntent } from '@/lib/payments/payment.service';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request);
    requireRole(auth, ['student', 'instructor', 'admin']);

    const body = await request.json();
    const input = CreatePaymentIntentSchema.parse(body);
    const result = await createPaymentIntent(input, auth);

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[PAYMENT:CREATE-INTENT] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 16.2 POST /api/v1/payments/webhook/:gateway

```typescript
// File: src/app/api/v1/payments/webhook/tyro/route.ts
// (Replicate pattern for /square, /pin, /stripe, /afterpay routes)

import { NextRequest, NextResponse } from 'next/server';
import { handleWebhook } from '@/lib/payments/payment.service';

export async function POST(request: NextRequest) {
  try {
    const payload = await request.text();
    const signature = request.headers.get('x-tyro-signature') || // Tyro
      request.headers.get('x-square-hmacsha256-signature') || // Square
      request.headers.get('x-pin-signature') || // Pin
      request.headers.get('stripe-signature') || // Stripe
      '';

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    await handleWebhook('tyro', payload, signature, headers);

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    console.error('[WEBHOOK:TYRO] Error:', error);
    // Always return 200 to webhooks to prevent retries on verification failures
    // Log the error for debugging
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
```

### 16.3 GET /api/v1/payments

```typescript
// File: src/app/api/v1/payments/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { listPayments } from '@/lib/payments/payment.service';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request);
    requireRole(auth, ['student', 'instructor', 'admin']);

    const params = request.nextUrl.searchParams;
    const result = await listPayments(auth, {
      student_id: params.get('student_id') || undefined,
      status: params.get('status') || undefined,
      date_from: params.get('date_from') || undefined,
      date_to: params.get('date_to') || undefined,
      cursor: params.get('cursor') || undefined,
      limit: params.get('limit') ? Number(params.get('limit')) : undefined,
    });

    return NextResponse.json({
      data: result.payments,
      meta: {
        cursor: result.cursor,
        has_more: result.has_more,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[PAYMENTS:LIST] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 16.4 GET /api/v1/payments/:id

```typescript
// File: src/app/api/v1/payments/[id]/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getPayment } from '@/lib/payments/payment.service';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext(request);
    requireRole(auth, ['student', 'instructor', 'admin']);

    const payment = await getPayment(params.id, auth);
    return NextResponse.json({ data: payment });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[PAYMENT:GET] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 16.5 GET /api/v1/payments/:id/invoice

```typescript
// File: src/app/api/v1/payments/[id]/invoice/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getPayment } from '@/lib/payments/payment.service';
import { generateInvoice } from '@/lib/payments/invoice.service';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext(request);
    requireRole(auth, ['student', 'instructor', 'admin']);

    // Verify access
    await getPayment(params.id, auth);

    // Generate fresh PDF
    const pdfBuffer = await generateInvoice(params.id);

    return new NextResponse(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="invoice-${params.id}.pdf"`,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[INVOICE:GET] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 16.6 POST /api/v1/payments/:id/refund

```typescript
// File: src/app/api/v1/payments/[id]/refund/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { RefundPaymentSchema } from '@/lib/payments/types';
import { initiateRefund } from '@/lib/payments/refund.service';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext(request);
    requireRole(auth, ['instructor', 'admin']);

    const body = await request.json();
    const input = RefundPaymentSchema.parse(body);
    const result = await initiateRefund(params.id, input, auth);

    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[REFUND] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 16.7 POST /api/v1/payments/record-manual

```typescript
// File: src/app/api/v1/payments/record-manual/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { RecordManualPaymentSchema } from '@/lib/payments/types';
import { recordManualPayment } from '@/lib/payments/payment.service';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request);
    requireRole(auth, ['instructor', 'admin']);

    const body = await request.json();
    const input = RecordManualPaymentSchema.parse(body);
    const result = await recordManualPayment(input, auth);

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[PAYMENT:MANUAL] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 16.8 POST /api/v1/payments/confirm-transfer

```typescript
// File: src/app/api/v1/payments/confirm-transfer/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { ConfirmTransferSchema } from '@/lib/payments/types';
import { confirmTransfer } from '@/lib/payments/payment.service';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request);
    requireRole(auth, ['instructor', 'admin']);

    const body = await request.json();
    const input = ConfirmTransferSchema.parse(body);
    const result = await confirmTransfer(input, auth);

    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[PAYMENT:CONFIRM-TRANSFER] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 16.9 POST /api/v1/packages/:id/purchase

```typescript
// File: src/app/api/v1/packages/[id]/purchase/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { PurchasePackageSchema } from '@/lib/payments/types';
import { purchasePackage } from '@/lib/payments/package.service';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthContext(request);
    requireRole(auth, ['student', 'instructor', 'admin']);

    const body = await request.json().catch(() => ({}));
    const input = PurchasePackageSchema.parse(body);
    const result = await purchasePackage(params.id, input, auth);

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[PACKAGE:PURCHASE] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 16.10 GET /api/v1/me/packages

```typescript
// File: src/app/api/v1/me/packages/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getStudentPackages } from '@/lib/payments/package.service';
import { getAuthContext } from '@/lib/auth/middleware';
import { requireRole } from '@/lib/auth/rbac';
import { ApiError } from '@/lib/auth/errors';

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request);
    requireRole(auth, ['student']);

    if (!auth.student_id) {
      return NextResponse.json(
        { error: { code: 'NO_STUDENT_PROFILE', message: 'Student profile not found' } },
        { status: 403 }
      );
    }

    const pkgs = await getStudentPackages(auth.student_id);
    return NextResponse.json({ data: pkgs });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    console.error('[ME:PACKAGES] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

### 16.11 POST /api/v1/vouchers/validate

```typescript
// File: src/app/api/v1/vouchers/validate/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { ValidateVoucherSchema } from '@/lib/payments/types';
import { validateVoucher } from '@/lib/payments/voucher.service';
import { ApiError } from '@/lib/auth/errors';

// Public endpoint (🌍) — no auth required
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const input = ValidateVoucherSchema.parse(body);
    const result = await validateVoucher(input);

    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: error.message } },
        { status: 422 }
      );
    }
    console.error('[VOUCHER:VALIDATE] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
```

---

## 17. Event Handlers

The Payment Engine emits events consumed by other components (primarily the Notification Engine, C18). Register these listeners in the app's event bootstrap.

### File: `src/lib/payments/event-handlers.ts`

```typescript
// ============================================================
// NexDrive Academy — Payment Event Handlers
// Listens for payment events and triggers downstream effects.
// ============================================================

import { eventBus } from '@/lib/events';
import { activatePackage } from './package.service';
import { db } from '@/db';
import { payments } from '@/db/schema';
import { eq } from 'drizzle-orm';

export function registerPaymentEventHandlers(): void {
  // When payment succeeds, check if it's a package purchase
  eventBus.on('PAYMENT_RECEIVED', async (data: { payment_id: string }) => {
    try {
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, data.payment_id))
        .limit(1);

      if (payment?.packageId && payment.studentId) {
        await activatePackage(payment.id, payment.studentId, payment.packageId);
      }

      // Notification engine will pick up PAYMENT_RECEIVED separately
    } catch (error) {
      console.error('[EVENT:PAYMENT_RECEIVED] Error:', error);
    }
  });
}
```

---

## 18. Environment Variables

```env
# ─── Tyro (Primary Gateway) ─────────────
TYRO_API_KEY=
TYRO_MERCHANT_ID=
TYRO_WEBHOOK_SECRET=
TYRO_API_URL=https://api.tyro.com

# ─── Square (Fallback + Afterpay) ───────
SQUARE_ACCESS_TOKEN=
SQUARE_LOCATION_ID=
SQUARE_WEBHOOK_SIGNATURE_KEY=
SQUARE_API_URL=https://connect.squareup.com/v2

# ─── Pin Payments ────────────────────────
PIN_SECRET_KEY=
PIN_WEBHOOK_KEY=
PIN_API_URL=https://api.pinpayments.com/1

# ─── Stripe (Last Fallback) ─────────────
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# ─── Gateway Config ─────────────────────
NEXT_PUBLIC_DEFAULT_GATEWAY=tyro

# ─── Business Details (Invoices) ────────
NEXDRIVE_ABN=
NEXDRIVE_ADDRESS=Canberra, ACT, Australia
NEXDRIVE_EMAIL=hello@nexdriveacademy.com.au
NEXDRIVE_PHONE=
NEXDRIVE_GST_REGISTERED=false

# ─── Bank Details (Direct Transfer) ─────
NEXDRIVE_BANK_ACCOUNT_NAME=NexDrive Academy
NEXDRIVE_BANK_BSB=
NEXDRIVE_BANK_ACCOUNT=
NEXDRIVE_PAYID=

# ─── R2 (Invoice Storage) ───────────────
R2_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=nexdrive
```

---

## 19. Cron Jobs

### File: `src/app/api/cron/expire-packages/route.ts`

```typescript
// Vercel Cron: Runs daily at 2am AEST
// vercel.json: { "crons": [{ "path": "/api/cron/expire-packages", "schedule": "0 15 * * *" }] }
// (15:00 UTC = 02:00 AEST next day)

import { NextRequest, NextResponse } from 'next/server';
import { expirePackages } from '@/lib/payments/package.service';

export async function GET(request: NextRequest) {
  // Verify Vercel cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const count = await expirePackages();
  return NextResponse.json({ expired: count });
}
```

---

## 20. Integration Points

### 20.1 Booking Engine → Payment Engine

The Booking Engine (SPEC-03) calls the Payment Engine during booking confirmation:

```typescript
// In booking.service.ts confirmBooking():
// 1. If payment_method === 'package_credit'
//    → call redeemCredit(studentId, serviceId)
//    → record internal payment with method='package_credit'
// 2. If payment_method === 'card'/'afterpay'
//    → payment intent already created before booking confirmation
//    → link payment_id to booking record
// 3. If payment_method === 'cash'/'direct_debit'
//    → booking confirmed without payment
//    → instructor records payment later via record-manual
```

### 20.2 Notification Engine Events

| Event | Trigger | Notification |
|-------|---------|-------------|
| `PAYMENT_RECEIVED` | Payment succeeds | Email receipt to student |
| `PAYMENT_FAILED` | Payment fails | SMS + Email to student |
| `PAYMENT_REFUNDED` | Refund processed | Email to student |
| `PACKAGE_PURCHASED` | Package activated | Email confirmation |
| `PACKAGE_LOW_CREDITS` | ≤2 credits left | SMS + Email to student |

### 20.3 Audit Trail

All payment mutations should emit audit events via the audit trail service (SPEC-15/C14):

```typescript
// After every payment state change:
await auditService.log({
  event_type: 'payment.status_changed',
  actor_id: auth.user_id,
  subject_type: 'payment',
  subject_id: paymentId,
  details: {
    old_status: previousStatus,
    new_status: newStatus,
    amount_cents: amountCents,
    gateway: gatewayName,
  },
});
```

---

## 21. Testing Strategy

### Unit Tests

| Test Suite | Covers |
|-----------|--------|
| `state-machine.test.ts` | All valid/invalid transitions |
| `voucher.service.test.ts` | Validation: expired, exhausted, not applicable, all discount types |
| `package.service.test.ts` | Credit redemption: priority ordering, exhaustion, expiry, service filtering |
| `refund.service.test.ts` | Full/partial refunds, exceeds-payment guard, package cancellation |
| `gateway-factory.test.ts` | Default resolution, fallback chain, unavailable handling |
| `invoice.service.test.ts` | Invoice numbering, GST calculation, PDF generation |

### Integration Tests

| Test | Description |
|------|-------------|
| Card payment E2E | Create intent → mock webhook → verify completed + invoice generated |
| Package purchase E2E | Purchase → activate → redeem credits → low balance alert |
| Voucher redemption | Validate → apply discount → create intent with reduced amount → consume |
| Refund E2E | Complete payment → initiate refund → verify gateway called → status updated |
| Manual cash payment | Record → verify completed immediately → invoice generated |
| Bank transfer flow | Record pending → confirm → verify completed |
| Gateway fallback | Primary unavailable → falls back to secondary → creates intent |

### Gateway Adapter Tests

Each adapter should have tests using mocked HTTP responses (use `msw` or `nock`):

```typescript
// Example: tyro.adapter.test.ts
describe('TyroAdapter', () => {
  it('creates a payment intent and returns client_secret');
  it('maps COMPLETED status to succeeded');
  it('maps DECLINED status to failed');
  it('verifies webhook HMAC signature');
  it('rejects invalid webhook signature');
  it('processes refund and returns refund_id');
  it('reports isAvailable=false when API key missing');
});
```

---

## 22. Dependencies

```json
{
  "dependencies": {
    "stripe": "^17.0.0",
    "pdfkit": "^0.15.0",
    "@aws-sdk/client-s3": "^3.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "msw": "^2.x",
    "@types/pdfkit": "^0.13.x"
  }
}
```

**Note:** Tyro, Square, Pin, and Afterpay do NOT have official Node.js SDKs (or their SDKs are limited). All adapters use `fetch()` with their REST APIs directly. Stripe is the only adapter using the official SDK (`stripe` npm package).

---

## 23. Security Considerations

1. **No card data touches our servers.** All gateways use hosted payment pages, iframes, or frontend tokenisation. We never see raw card numbers. This keeps us at PCI DSS SAQ-A (simplest compliance level).

2. **Webhook signature verification.** Every gateway webhook route verifies the request signature before processing. Invalid signatures are rejected.

3. **Idempotency.** All gateway API calls include idempotency keys to prevent double-charges on retries.

4. **Rate limiting.** Payment endpoints are rate-limited: 10 mutations/min per user, 100 reads/min per user (via Upstash Redis, as per arch doc §4.1).

5. **Amount validation.** All amounts are validated as positive integers. No negative payments or zero-amount charges.

6. **Gateway response sanitisation.** The `gateway_response` JSONB column stores gateway responses but should never contain raw card numbers, CVVs, or full tokens. Each adapter is responsible for sanitising before storage.

7. **Instructor-only manual payments.** Cash/bank transfer recording requires `instructor` or `admin` role. Students cannot create manual payment records.

---

*Document generated by BMAD Architect Agent | NexDrive Academy Project*  
*SPEC-04: Payment Engine API v1.0 — 20 February 2026*
