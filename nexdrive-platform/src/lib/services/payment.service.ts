import { db } from '../db'
import {
  payments,
  bookings,
  vouchers,
  services,
  profiles,
  students,
  auditLog,
} from '../schema'
import { eq, and } from 'drizzle-orm'
import { stripeAdapter } from '../adapters/stripe.adapter'
import type {
  VoucherValidateResponse,
  CheckoutResponse,
} from '../types/payment.types'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

export async function validateVoucher(
  code: string,
  amountCents: number
): Promise<VoucherValidateResponse> {
  const rows = await db
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.code, code), eq(vouchers.isActive, true)))
    .limit(1)

  if (rows.length === 0) return { valid: false, error: 'Invalid voucher code' }

  const voucher = rows[0]
  const now = new Date()

  if (voucher.validUntil && voucher.validUntil < now) {
    return { valid: false, error: 'Voucher has expired' }
  }

  if (voucher.validFrom && voucher.validFrom > now) {
    return { valid: false, error: 'Voucher is not yet active' }
  }

  if (voucher.maxUses !== null && (voucher.timesUsed ?? 0) >= voucher.maxUses) {
    return { valid: false, error: 'Voucher usage limit reached' }
  }

  let discountCentsValue = 0
  if (voucher.voucherType === 'percentage' && voucher.discountPercent) {
    discountCentsValue = Math.round((amountCents * voucher.discountPercent) / 100)
  } else if (voucher.voucherType === 'fixed_amount' && voucher.discountCents) {
    discountCentsValue = Math.min(voucher.discountCents, amountCents)
  } else if (voucher.voucherType === 'free_lesson') {
    discountCentsValue = amountCents
  }

  const finalCents = Math.max(0, amountCents - discountCentsValue)

  return {
    valid: true,
    discountAud: (discountCentsValue / 100).toFixed(2),
    finalAud: (finalCents / 100).toFixed(2),
    discountCents: discountCentsValue,
    finalCents,
  }
}

export async function createBookingCheckout(
  bookingId: string,
  studentProfileId: string,
  voucherCode?: string
): Promise<CheckoutResponse> {
  const bookingRows = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1)
  if (bookingRows.length === 0) throw new Error('Booking not found')
  const booking = bookingRows[0]

  const studentRows = await db.select().from(students).where(eq(students.profileId, studentProfileId)).limit(1)
  if (studentRows.length === 0 || booking.studentId !== studentRows[0].id) {
    throw new Error('Forbidden')
  }

  let amountCents = 0
  let serviceName = 'Driving Lesson'

  if (booking.serviceId) {
    const serviceRows = await db.select().from(services).where(eq(services.id, booking.serviceId)).limit(1)
    if (serviceRows.length > 0) {
      amountCents = serviceRows[0].priceCents
      serviceName = serviceRows[0].name
    }
  }

  let discountCents = 0
  if (voucherCode) {
    const validation = await validateVoucher(voucherCode, amountCents)
    if (validation.valid && validation.discountCents) {
      discountCents = validation.discountCents
      amountCents = validation.finalCents ?? Math.max(0, amountCents - discountCents)

      const voucherRow = await db.select().from(vouchers).where(eq(vouchers.code, voucherCode)).limit(1)
      if (voucherRow.length > 0) {
        await db.update(vouchers).set({ timesUsed: (voucherRow[0].timesUsed ?? 0) + 1 }).where(eq(vouchers.code, voucherCode))
      }
    }
  }

  const profileRows = await db.select().from(profiles).where(eq(profiles.id, studentProfileId)).limit(1)

  const result = await stripeAdapter.createCheckoutSession({
    amountCents,
    currency: 'aud',
    description: serviceName,
    successUrl: `${APP_URL}/booking/success?bookingId=${bookingId}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${APP_URL}/book?cancelled=true`,
    customerEmail: profileRows[0]?.email,
    metadata: { bookingId, studentProfileId, voucherCode: voucherCode ?? '' },
  })

  await db.insert(payments).values({
    instructorId: booking.instructorId,
    studentId: studentRows[0].id,
    bookingId,
    amountCents,
    discountCents,
    currency: 'AUD',
    status: 'pending',
    provider: 'stripe',
    providerSessionId: result.sessionId,
    description: serviceName,
    voucherCode: voucherCode,
  })

  return { checkoutUrl: result.url, sessionId: result.sessionId }
}

export async function handlePaymentSuccess(stripeSessionId: string): Promise<void> {
  const session = await stripeAdapter.getSession(stripeSessionId)
  const { bookingId } = session.metadata ?? {}
  if (!bookingId) throw new Error('No bookingId in session metadata')

  await db.update(payments)
    .set({ status: 'completed', paidAt: new Date(), updatedAt: new Date() })
    .where(eq(payments.providerSessionId, stripeSessionId))

  await db.update(bookings)
    .set({ status: 'confirmed', confirmedAt: new Date(), updatedAt: new Date() })
    .where(eq(bookings.id, bookingId))

  await db.insert(auditLog).values({
    action: 'PAYMENT_SUCCESS',
    entityType: 'payment',
    entityId: bookingId,
    payload: { bookingId, stripeSessionId },
  })
}

export async function processRefund(paymentId: string, instructorProfileId: string): Promise<void> {
  const rows = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1)
  if (rows.length === 0) throw new Error('Payment not found')
  const payment = rows[0]

  if (payment.status !== 'completed') throw new Error('Only completed payments can be refunded')
  if (!payment.providerSessionId) throw new Error('No provider session reference on payment')

  const session = await stripeAdapter.getSession(payment.providerSessionId)
  const paymentIntentId = session.payment_intent as string

  await stripeAdapter.refund(paymentIntentId)

  await db.update(payments)
    .set({ status: 'refunded', refundedAt: new Date(), refundedCents: payment.amountCents, updatedAt: new Date() })
    .where(eq(payments.id, paymentId))

  await db.insert(auditLog).values({
    actorProfileId: instructorProfileId,
    action: 'PAYMENT_REFUNDED',
    entityType: 'payment',
    entityId: paymentId,
    payload: { paymentIntentId },
  })
}
