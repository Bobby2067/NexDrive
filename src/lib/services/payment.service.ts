import { db } from '../db'
import {
  payments,
  bookings,
  vouchers,
  packages,
  studentPackages,
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

// ── Voucher validation ─────────────────────────────────────────────────────

export async function validateVoucher(
  code: string,
  amountAud: string
): Promise<VoucherValidateResponse> {
  const rows = await db
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.code, code), eq(vouchers.isActive, true)))
    .limit(1)

  if (rows.length === 0) return { valid: false, error: 'Invalid voucher code' }

  const voucher = rows[0]
  const now = new Date()

  if (voucher.expiresAt && voucher.expiresAt < now) {
    return { valid: false, error: 'Voucher has expired' }
  }

  if (voucher.usageLimit !== null && voucher.usageCount >= voucher.usageLimit) {
    return { valid: false, error: 'Voucher usage limit reached' }
  }

  const amount = parseFloat(amountAud)
  const discountValue = parseFloat(voucher.discountValue)
  let discountAud: number

  if (voucher.discountType === 'percent') {
    discountAud = Math.round((amount * discountValue) / 100 * 100) / 100
  } else {
    discountAud = Math.min(discountValue, amount)
  }

  const finalAud = Math.max(0, amount - discountAud)

  return {
    valid: true,
    discountAud: discountAud.toFixed(2),
    finalAud: finalAud.toFixed(2),
  }
}

// ── Booking checkout ───────────────────────────────────────────────────────

export async function createBookingCheckout(
  bookingId: string,
  studentProfileId: string,
  voucherCode?: string
): Promise<CheckoutResponse> {
  // Load booking with service
  const bookingRows = await db
    .select({ booking: bookings })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (bookingRows.length === 0) throw new Error('Booking not found')
  const booking = bookingRows[0].booking

  // Verify this student owns the booking
  const studentRows = await db
    .select()
    .from(students)
    .where(eq(students.profileId, studentProfileId))
    .limit(1)

  if (studentRows.length === 0 || booking.studentId !== studentRows[0].id) {
    throw new Error('Forbidden')
  }

  // Get price from service
  const serviceRows = booking.serviceId
    ? await db.query.services?.findFirst({
        where: (s, { eq }) => eq(s.id, booking.serviceId!),
      })
    : null

  let amountAud = serviceRows ? parseFloat(serviceRows.priceAud) : 0

  // Apply voucher if provided
  let voucherDiscount = 0
  if (voucherCode) {
    const validation = await validateVoucher(voucherCode, amountAud.toFixed(2))
    if (validation.valid && validation.discountAud) {
      voucherDiscount = parseFloat(validation.discountAud)
      amountAud = parseFloat(validation.finalAud!)

      // Increment voucher usage
      const voucherRow = await db
        .select()
        .from(vouchers)
        .where(eq(vouchers.code, voucherCode))
        .limit(1)
      if (voucherRow.length > 0) {
        await db
          .update(vouchers)
          .set({ usageCount: voucherRow[0].usageCount + 1 })
          .where(eq(vouchers.code, voucherCode))
      }
    }
  }

  const amountCents = Math.round(amountAud * 100)

  // Get student email for Stripe
  const profileRows = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, studentProfileId))
    .limit(1)

  const result = await stripeAdapter.createCheckoutSession({
    amountCents,
    currency: 'aud',
    description: serviceRows?.name ?? 'Driving Lesson',
    successUrl: `${APP_URL}/booking/success?bookingId=${bookingId}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${APP_URL}/book?cancelled=true`,
    customerEmail: profileRows[0]?.email,
    metadata: {
      bookingId,
      studentProfileId,
      voucherCode: voucherCode ?? '',
    },
  })

  // Record pending payment
  await db.insert(payments).values({
    studentId: studentRows[0].id,
    bookingId,
    amountAud: amountAud.toFixed(2),
    status: 'pending',
    provider: 'stripe',
    providerRef: result.sessionId,
    metadata: { sessionId: result.sessionId, voucherDiscount },
  })

  return { checkoutUrl: result.url, sessionId: result.sessionId }
}

// ── Handle webhook payment success ─────────────────────────────────────────

export async function handlePaymentSuccess(stripeSessionId: string): Promise<void> {
  const session = await stripeAdapter.getSession(stripeSessionId)
  const { bookingId, studentProfileId } = session.metadata ?? {}

  if (!bookingId) throw new Error('No bookingId in session metadata')

  // Update payment to paid
  await db
    .update(payments)
    .set({ status: 'paid', updatedAt: new Date() })
    .where(eq(payments.providerRef, stripeSessionId))

  // Confirm booking
  await db
    .update(bookings)
    .set({ status: 'confirmed', updatedAt: new Date() })
    .where(eq(bookings.id, bookingId))

  // Audit log
  await db.insert(auditLog).values({
    action: 'PAYMENT_SUCCESS',
    entityType: 'payment',
    entityId: stripeSessionId,
    payload: { bookingId, stripeSessionId },
  })
}

// ── Refund ─────────────────────────────────────────────────────────────────

export async function processRefund(
  paymentId: string,
  instructorProfileId: string
): Promise<void> {
  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1)

  if (rows.length === 0) throw new Error('Payment not found')
  const payment = rows[0]

  if (payment.status !== 'paid') throw new Error('Only paid payments can be refunded')
  if (!payment.providerRef) throw new Error('No provider reference on payment')

  // Get the Stripe payment intent from the session
  const session = await stripeAdapter.getSession(payment.providerRef)
  const paymentIntentId = session.payment_intent as string

  await stripeAdapter.refund(paymentIntentId)

  await db
    .update(payments)
    .set({ status: 'refunded', updatedAt: new Date() })
    .where(eq(payments.id, paymentId))

  await db.insert(auditLog).values({
    actorProfileId: instructorProfileId,
    action: 'PAYMENT_REFUNDED',
    entityType: 'payment',
    entityId: paymentId,
    payload: { paymentIntentId },
  })
}