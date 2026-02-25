import type { InferSelectModel } from 'drizzle-orm'
import type { payments, packages, vouchers } from '../schema'

export type Payment = InferSelectModel<typeof payments>
export type Package = InferSelectModel<typeof packages>
export type Voucher = InferSelectModel<typeof vouchers>

export interface CreateCheckoutRequest {
  bookingId: string
  voucherCode?: string
}

export interface CreatePackageCheckoutRequest {
  packageId: string
}

export interface RefundRequest {
  paymentId: string
  reason?: string
}

export interface VoucherValidateRequest {
  code: string
  amountAud: string // decimal string
}

export interface VoucherValidateResponse {
  valid: boolean
  discountAud?: string
  finalAud?: string
  error?: string
}

export interface CheckoutResponse {
  checkoutUrl: string
  sessionId: string
}
