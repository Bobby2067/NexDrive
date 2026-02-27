import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { createBookingCheckout } from '@/lib/services/payment.service'
import type { CreateCheckoutRequest } from '@/lib/types/payment.types'

// POST /api/payments/checkout
export async function POST(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const profile = await db
    .select()
    .from(profiles)
    .where(eq(profiles.clerkUserId, userId))
    .limit(1)
    .then(r => r[0] ?? null)

  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  let body: CreateCheckoutRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.bookingId) {
    return NextResponse.json({ error: 'bookingId is required' }, { status: 400 })
  }

  try {
    const result = await createBookingCheckout(body.bookingId, profile.id, body.voucherCode)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Checkout failed'
    const status = message === 'Forbidden' ? 403 : 400
    return NextResponse.json({ error: message }, { status })
  }
}