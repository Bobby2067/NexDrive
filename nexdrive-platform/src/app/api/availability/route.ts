import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { availabilityRules, availabilityOverrides, profiles, instructors } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getAvailableSlots } from '@/lib/services/booking.service'
import type { CreateAvailabilityRuleRequest, CreateAvailabilityOverrideRequest } from '@/lib/types/booking.types'
import { dependencyPayload, isDependencyError, isLocalModeEnabled } from '@/lib/runtime'

function getLocalMockSlots(date: string) {
  const now = new Date()
  const hours = [9, 10, 11, 12, 13, 14, 15, 16]
  return hours
    .map(hour => {
      const start = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+11:00`)
      const end = new Date(start.getTime() + 60 * 60 * 1000)
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        available: start > now,
      }
    })
    .filter(slot => slot.available)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const instructorId = searchParams.get('instructorId')
  const date = searchParams.get('date')

  if (!instructorId || !date) return NextResponse.json({ error: 'instructorId and date are required' }, { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })

  const maxDate = new Date()
  maxDate.setDate(maxDate.getDate() + 56)
  if (new Date(date) > maxDate) return NextResponse.json({ error: 'Cannot book more than 8 weeks in advance' }, { status: 400 })

  try {
    const slots = await getAvailableSlots(instructorId, date)
    return NextResponse.json({ date, instructorId, slots })
  } catch (error) {
    if (isLocalModeEnabled() && isDependencyError(error)) {
      return NextResponse.json({
        date,
        instructorId,
        slots: getLocalMockSlots(date),
        mode: 'local-mock',
        warning: 'Database unavailable, returning local mock availability.',
      })
    }

    if (isDependencyError(error)) {
      return NextResponse.json(dependencyPayload(error, 'database'), { status: 503 })
    }

    return NextResponse.json({ error: 'Failed to load availability' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const instructor = await db.select({ instructor: instructors }).from(instructors).innerJoin(profiles, eq(instructors.profileId, profiles.id)).where(eq(profiles.clerkUserId, userId)).limit(1).then(r => r[0]?.instructor ?? null)
    if (!instructor) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { searchParams } = new URL(req.url)

    if (searchParams.get('action') === 'override') {
      let body: CreateAvailabilityOverrideRequest
      try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
      if (!body.date) return NextResponse.json({ error: 'date is required' }, { status: 400 })
      const [override] = await db.insert(availabilityOverrides).values({ instructorId: instructor.id, date: new Date(body.date), isAvailable: body.isAvailable, startTime: body.startTime, endTime: body.endTime, reason: body.reason }).returning()
      return NextResponse.json({ override }, { status: 201 })
    }

    let body: CreateAvailabilityRuleRequest
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
    if (body.dayOfWeek === undefined || !body.startTime || !body.endTime) return NextResponse.json({ error: 'dayOfWeek, startTime and endTime are required' }, { status: 400 })
    const [rule] = await db.insert(availabilityRules).values({ instructorId: instructor.id, dayOfWeek: body.dayOfWeek, startTime: body.startTime, endTime: body.endTime, isActive: true }).returning()
    return NextResponse.json({ rule }, { status: 201 })
  } catch (error) {
    if (isDependencyError(error)) {
      return NextResponse.json(dependencyPayload(error, 'database'), { status: 503 })
    }

    return NextResponse.json({ error: 'Failed to update availability' }, { status: 500 })
  }
}
