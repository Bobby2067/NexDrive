import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bookings, profiles, instructors, students } from '@/lib/schema'
import { eq, desc } from 'drizzle-orm'
import { createBooking } from '@/lib/services/booking.service'
import type { CreateBookingRequest } from '@/lib/types/booking.types'
import { dependencyPayload, isClerkConfigured, isDependencyError, isLocalModeEnabled } from '@/lib/runtime'
import { createMockBooking, getMockBookings } from '@/lib/mock/bookings'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit = Math.min(Number(searchParams.get('limit') ?? 20), 100)
  const offset = Number(searchParams.get('offset') ?? 0)

  if (isLocalModeEnabled() && !isClerkConfigured()) {
    return NextResponse.json({
      bookings: getMockBookings(limit, offset),
      mode: 'local-mock',
      warning: 'Clerk not configured, returning local mock bookings.',
    })
  }
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const profile = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId)).limit(1).then(r => r[0] ?? null)
    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

    if (profile.role === 'instructor') {
      const instructor = await db.select().from(instructors).where(eq(instructors.profileId, profile.id)).limit(1).then(r => r[0] ?? null)
      if (!instructor) return NextResponse.json({ error: 'Instructor not found' }, { status: 404 })
      const rows = await db.select().from(bookings).where(eq(bookings.instructorId, instructor.id)).orderBy(desc(bookings.scheduledAt)).limit(limit).offset(offset)
      return NextResponse.json({ bookings: rows })
    }

    if (profile.role === 'student') {
      const student = await db.select().from(students).where(eq(students.profileId, profile.id)).limit(1).then(r => r[0] ?? null)
      if (!student) return NextResponse.json({ error: 'Student not found' }, { status: 404 })
      const rows = await db.select().from(bookings).where(eq(bookings.studentId, student.id)).orderBy(desc(bookings.scheduledAt)).limit(limit).offset(offset)
      return NextResponse.json({ bookings: rows })
    }

    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  } catch (error) {
    if (isLocalModeEnabled() && isDependencyError(error)) {
      return NextResponse.json({
        bookings: getMockBookings(limit, offset),
        mode: 'local-mock',
        warning: 'Database/auth dependency unavailable, returning local mock bookings.',
      })
    }

    if (isDependencyError(error)) {
      return NextResponse.json(dependencyPayload(error, 'database/auth'), { status: 503 })
    }

    return NextResponse.json({ error: 'Failed to load bookings' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  let body: CreateBookingRequest
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.instructorId || !body.serviceId || !body.scheduledAt) {
    return NextResponse.json({ error: 'instructorId, serviceId and scheduledAt are required' }, { status: 400 })
  }

  if (isLocalModeEnabled() && !isClerkConfigured()) {
    return NextResponse.json({
      booking: createMockBooking(body),
      mode: 'local-mock',
      warning: 'Clerk not configured, returning mock booking creation result.',
    }, { status: 201 })
  }
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const profile = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId)).limit(1).then(r => r[0] ?? null)
    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

    try {
      const booking = await createBooking(body, profile.id)
      return NextResponse.json({ booking }, { status: 201 })
    } catch (err) {
      if (isLocalModeEnabled() && isDependencyError(err)) {
        return NextResponse.json({
          booking: createMockBooking(body),
          mode: 'local-mock',
          warning: 'Database dependency unavailable, returning mock booking creation result.',
        }, { status: 201 })
      }
      if (isDependencyError(err)) {
        return NextResponse.json(dependencyPayload(err, 'database'), { status: 503 })
      }

      const message = err instanceof Error ? err.message : 'Failed to create booking'
      return NextResponse.json({ error: message }, { status: message === 'This slot is no longer available' ? 409 : 400 })
    }
  } catch (error) {
    if (isDependencyError(error)) {
      return NextResponse.json(dependencyPayload(error, 'database/auth'), { status: 503 })
    }

    return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 })
  }
}
