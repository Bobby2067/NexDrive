import type { CreateBookingRequest, UpdateBookingStatusRequest } from '@/lib/types/booking.types'

export interface MockBooking {
  id: string
  instructorId: string
  studentId: string
  serviceId: string
  scheduledAt: string
  durationMinutes: number
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show'
  meetingLocation: string | null
  notes: string | null
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
}

const BASE_MOCK_BOOKINGS: MockBooking[] = [
  {
    id: 'mock-booking-001',
    instructorId: 'mock-instructor',
    studentId: 'mock-student-1',
    serviceId: 'mock-service-60',
    scheduledAt: '2026-03-02T00:00:00.000Z',
    durationMinutes: 60,
    status: 'confirmed',
    meetingLocation: 'Canberra Civic',
    notes: 'Mock booking generated for local mode.',
    confirmedAt: '2026-02-27T00:00:00.000Z',
    createdAt: '2026-02-26T22:00:00.000Z',
    updatedAt: '2026-02-27T00:00:00.000Z',
  },
  {
    id: 'mock-booking-002',
    instructorId: 'mock-instructor',
    studentId: 'mock-student-2',
    serviceId: 'mock-service-90',
    scheduledAt: '2026-03-03T02:00:00.000Z',
    durationMinutes: 90,
    status: 'pending',
    meetingLocation: 'Belconnen',
    notes: 'Second local-mode booking.',
    confirmedAt: null,
    createdAt: '2026-02-27T01:00:00.000Z',
    updatedAt: '2026-02-27T01:00:00.000Z',
  },
]

function clone(booking: MockBooking): MockBooking {
  return { ...booking }
}

export function getMockBookings(limit = 20, offset = 0): MockBooking[] {
  return BASE_MOCK_BOOKINGS.slice(offset, offset + limit).map(clone)
}

export function getMockBookingById(id: string): MockBooking | null {
  const booking = BASE_MOCK_BOOKINGS.find(b => b.id === id)
  return booking ? clone(booking) : null
}

export function createMockBooking(input: CreateBookingRequest): MockBooking {
  const now = new Date().toISOString()
  return {
    id: `mock-booking-${Date.now()}`,
    instructorId: input.instructorId,
    studentId: 'mock-student-created',
    serviceId: input.serviceId,
    scheduledAt: input.scheduledAt,
    durationMinutes: input.serviceId === 'mock-service-90' ? 90 : 60,
    status: 'pending',
    meetingLocation: input.meetingLocation ?? null,
    notes: input.notes ?? 'Created in local mock mode.',
    confirmedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function updateMockBookingStatus(
  id: string,
  input: UpdateBookingStatusRequest
): MockBooking | null {
  const existing = getMockBookingById(id)
  if (!existing) return null

  const now = new Date().toISOString()
  const nextStatus = input.status
  return {
    ...existing,
    status: nextStatus,
    confirmedAt: nextStatus === 'confirmed' ? now : existing.confirmedAt,
    updatedAt: now,
  }
}
