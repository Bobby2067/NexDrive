import { db } from '../db'
import {
  bookings,
  services,
  availabilityRules,
  availabilityOverrides,
  students,
  profiles,
  auditLog,
} from '../schema'
import { eq, and, gte, lte, or, ne } from 'drizzle-orm'
import type {
  TimeSlot,
  CreateBookingRequest,
  BookingWithDetails,
} from '../types/booking.types'

// ── Slot generation ────────────────────────────────────────────────────────

function generateSlots(date: string, startTime: string, endTime: string, durationMinutes = 60): TimeSlot[] {
  const slots: TimeSlot[] = []
  const [startH, startM] = startTime.split(':').map(Number)
  const [endH, endM] = endTime.split(':').map(Number)

  let current = startH * 60 + startM
  const end = endH * 60 + endM

  while (current + durationMinutes <= end) {
    const slotStart = new Date(`${date}T${String(Math.floor(current / 60)).padStart(2, '0')}:${String(current % 60).padStart(2, '0')}:00+11:00`)
    const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60 * 1000)

    slots.push({
      start: slotStart.toISOString(),
      end: slotEnd.toISOString(),
      available: true,
    })

    current += durationMinutes
  }

  return slots
}

export async function getAvailableSlots(
  instructorId: string,
  date: string
): Promise<TimeSlot[]> {
  const dateObj = new Date(`${date}T00:00:00+11:00`)
  const dayOfWeek = dateObj.getDay()

  const rules = await db
    .select()
    .from(availabilityRules)
    .where(
      and(
        eq(availabilityRules.instructorId, instructorId),
        eq(availabilityRules.dayOfWeek, dayOfWeek),
        eq(availabilityRules.isActive, true)
      )
    )

  if (rules.length === 0) return []

  const dayStart = new Date(`${date}T00:00:00+11:00`)
  const dayEnd = new Date(`${date}T23:59:59+11:00`)

  const overrides = await db
    .select()
    .from(availabilityOverrides)
    .where(
      and(
        eq(availabilityOverrides.instructorId, instructorId),
        gte(availabilityOverrides.date, dayStart),
        lte(availabilityOverrides.date, dayEnd)
      )
    )

  if (overrides.length > 0 && !overrides[0].isAvailable) return []

  const rule = rules[0]
  const override = overrides.find(o => o.isAvailable)
  const startTime = override?.startTime ?? rule.startTime
  const endTime = override?.endTime ?? rule.endTime

  let slots = generateSlots(date, startTime, endTime)

  const now = new Date()
  slots = slots.filter(slot => new Date(slot.start) > now)

  const existingBookings = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.instructorId, instructorId),
        gte(bookings.scheduledAt, dayStart),
        lte(bookings.scheduledAt, dayEnd),
        or(
          eq(bookings.status, 'pending'),
          eq(bookings.status, 'confirmed')
        )
      )
    )

  slots = slots.filter(slot => {
    const slotStart = new Date(slot.start)
    const slotEnd = new Date(slot.end)

    return !existingBookings.some(booking => {
      const bookingStart = new Date(booking.scheduledAt)
      const bookingEnd = new Date(
        bookingStart.getTime() + booking.durationMinutes * 60 * 1000
      )
      return slotStart < bookingEnd && slotEnd > bookingStart
    })
  })

  return slots
}

export async function createBooking(
  data: CreateBookingRequest,
  studentProfileId: string
): Promise<BookingWithDetails> {
  const studentRows = await db
    .select()
    .from(students)
    .where(eq(students.profileId, studentProfileId))
    .limit(1)

  if (studentRows.length === 0) {
    throw new Error('Student profile not found')
  }

  const student = studentRows[0]

  const serviceRows = await db
    .select()
    .from(services)
    .where(
      and(
        eq(services.id, data.serviceId),
        eq(services.isActive, true)
      )
    )
    .limit(1)

  if (serviceRows.length === 0) {
    throw new Error('Service not found')
  }

  const service = serviceRows[0]

  const scheduledDate = new Date(data.scheduledAt)
  const dateStr = scheduledDate.toISOString().split('T')[0]
  const availableSlots = await getAvailableSlots(data.instructorId, dateStr)

  const slotAvailable = availableSlots.some(
    slot => new Date(slot.start).getTime() === scheduledDate.getTime()
  )

  if (!slotAvailable) {
    throw new Error('This slot is no longer available')
  }

  const [booking] = await db
    .insert(bookings)
    .values({
      instructorId: data.instructorId,
      studentId: student.id,
      serviceId: data.serviceId,
      scheduledAt: scheduledDate,
      durationMinutes: service.durationMinutes,
      status: 'pending',
      meetingLocation: data.meetingLocation,
      notes: data.notes,
    })
    .returning()

  await db.insert(auditLog).values({
    actorProfileId: studentProfileId,
    action: 'BOOKING_CREATED',
    entityType: 'booking',
    entityId: booking.id,
    payload: {
      instructorId: data.instructorId,
      serviceId: data.serviceId,
      scheduledAt: data.scheduledAt,
    },
  })

  return getBookingWithDetails(booking.id)
}

export async function updateBookingStatus(
  bookingId: string,
  newStatus: 'confirmed' | 'cancelled' | 'completed' | 'no_show',
  actorProfileId: string,
  actorRole: 'instructor' | 'student'
): Promise<BookingWithDetails> {
  const existing = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (existing.length === 0) throw new Error('Booking not found')

  const booking = existing[0]

  if (actorRole === 'student') {
    if (newStatus !== 'cancelled') {
      throw new Error('Students can only cancel bookings')
    }
    const hoursUntilLesson =
      (new Date(booking.scheduledAt).getTime() - Date.now()) / (1000 * 60 * 60)
    if (hoursUntilLesson < 24) {
      throw new Error('Cancellations must be made at least 24 hours in advance')
    }
  }

  const [updated] = await db
    .update(bookings)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(bookings.id, bookingId))
    .returning()

  await db.insert(auditLog).values({
    actorProfileId,
    action: `BOOKING_${newStatus.toUpperCase()}`,
    entityType: 'booking',
    entityId: bookingId,
    payload: { previousStatus: booking.status, newStatus },
  })

  return getBookingWithDetails(updated.id)
}

export async function getBookingWithDetails(bookingId: string): Promise<BookingWithDetails> {
  const rows = await db
    .select({
      booking: bookings,
      service: services,
      student: students,
      profile: profiles,
    })
    .from(bookings)
    .leftJoin(services, eq(bookings.serviceId, services.id))
    .leftJoin(students, eq(bookings.studentId, students.id))
    .leftJoin(profiles, eq(students.profileId, profiles.id))
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (rows.length === 0) throw new Error('Booking not found')

  const row = rows[0]

  return {
    ...row.booking,
    service: row.service,
    student: row.profile
      ? {
          id: row.student!.id,
          firstName: row.profile.firstName,
          lastName: row.profile.lastName,
          email: row.profile.email,
          phone: row.profile.phone,
        }
      : null,
  }
}
