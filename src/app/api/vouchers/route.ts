import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { vouchers, profiles, instructors } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { validateVoucher } from '@/lib/services/payment.service'
import type { VoucherValidateRequest } from '@/lib/types/payment.types'

// POST /api/vouchers/validate — public (needs no auth, called during checkout)
export async function POST(req: Request) {
  let body: VoucherValidateRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.code || !body.amountAud) {
    return NextResponse.json({ error: 'code and amountAud are required' }, { status: 400 })
  }

  const result = await validateVoucher(body.code, body.amountAud)
  return NextResponse.json(result)
}

// GET /api/vouchers — instructor only, list all vouchers
export async function GET(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const instructor = await db
    .select({ instructor: instructors })
    .from(instructors)
    .innerJoin(profiles, eq(instructors.profileId, profiles.id))
    .where(eq(profiles.clerkUserId, userId))
    .limit(1)
    .then(r => r[0]?.instructor ?? null)

  if (!instructor) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const all = await db.select().from(vouchers).orderBy(vouchers.createdAt)
  return NextResponse.json({ vouchers: all })
}