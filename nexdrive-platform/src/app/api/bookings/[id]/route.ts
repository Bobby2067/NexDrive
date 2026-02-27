import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles, students } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { updateBookingStatus, getBookingWithDetails } from '@/lib/services/booking.service'
import type { UpdateBookingStatusRequest } from '@/lib/types/booking.types'
import { dependencyPayload, isClerkConfigured, isDependencyError, isLocalModeEnabled } from '@/lib/runtime'
import { getMockBookingById, updateMockBookingStatus } from '@/lib/mock/bookings'

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (isLocalModeEnabled() && !isClerkConfigured()) {
    const booking = getMockBookingById(params.id)
    if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    return NextResponse.json({
      booking,
      mode: 'local-mock',
      warning: 'Clerk not configured, returning mock booking details.',
    })
  }
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const profile = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId)).limit(1).then(r => r[0] ?? null)
    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

    const booking = await getBookingWithDetails(params.id)
    if (profile.role === 'student') {
      const student = await db.select().from(students).where(eq(students.profileId, profile.id)).limit(1).then(r => r[0] ?? null)
      if (!student || booking.studentId !== student.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({ booking })
  } catch (error) {
    if (isLocalModeEnabled() && isDependencyError(error)) {
      const booking = getMockBookingById(params.id)
      if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

      return NextResponse.json({
        booking,
        mode: 'local-mock',
        warning: 'Database/auth dependency unavailable, returning mock booking details.',
      })
    }
    if (isDependencyError(error)) {
      return NextResponse.json(dependencyPayload(error, 'database/auth'), { status: 503 })
    }

    return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let body: UpdateBookingStatusRequest
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.status) return NextResponse.json({ error: 'status is required' }, { status: 400 })

  const validStatuses = ['confirmed', 'cancelled', 'completed', 'no_show']
  if (!validStatuses.includes(body.status)) return NextResponse.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, { status: 400 })

  if (isLocalModeEnabled() && !isClerkConfigured()) {
    const booking = updateMockBookingStatus(params.id, body)
    if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    return NextResponse.json({
      booking,
      mode: 'local-mock',
      warning: 'Clerk not configured, returning mock booking status update result.',
    })
  }
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const profile = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId)).limit(1).then(r => r[0] ?? null)
    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

    const booking = await updateBookingStatus(params.id, body.status, profile.id, profile.role === 'instructor' ? 'instructor' : 'student')
    return NextResponse.json({ booking })
  } catch (error) {
    if (isLocalModeEnabled() && isDependencyError(error)) {
      const booking = updateMockBookingStatus(params.id, body)
      if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

      return NextResponse.json({
        booking,
        mode: 'local-mock',
        warning: 'Database/auth dependency unavailable, returning mock booking status update result.',
      })
    }
    if (isDependencyError(error)) {
      return NextResponse.json(dependencyPayload(error, 'database/auth'), { status: 503 })
    }

    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to update booking' }, { status: 400 })
  }
}
