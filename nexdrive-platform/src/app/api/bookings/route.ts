import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bookings, profiles, instructors, students } from '@/lib/schema'
import { eq, and, desc } from 'drizzle-orm'
import { createBooking } from '@/lib/services/booking.service'
import type { CreateBookingRequest } from '@/lib/types/booking.types'

export async function GET(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const profile = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId)).limit(1).then(r => r[0] ?? null)
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  const { searchParams } = new URL(req.url)
  const limit = Math.min(Number(searchParams.get('limit') ?? 20), 100)
  const offset = Number(searchParams.get('offset') ?? 0)

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
}

export async function POST(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const profile = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId)).limit(1).then(r => r[0] ?? null)
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  let body: CreateBookingRequest
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.instructorId || !body.serviceId || !body.scheduledAt) {
    return NextResponse.json({ error: 'instructorId, serviceId and scheduledAt are required' }, { status: 400 })
  }

  try {
    const booking = await createBooking(body, profile.id)
    return NextResponse.json({ booking }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create booking'
    return NextResponse.json({ error: message }, { status: message === 'This slot is no longer available' ? 409 : 400 })
  }
}
