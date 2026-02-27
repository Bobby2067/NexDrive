import type { InferSelectModel } from 'drizzle-orm'
import type {
  bookings,
  services,
  students,
  profiles,
  availabilityRules,
  availabilityOverrides,
} from '../schema'

// ── Drizzle inferred types ─────────────────────────────────────────────────

export type Booking = InferSelectModel<typeof bookings>
export type Service = InferSelectModel<typeof services>
export type AvailabilityRule = InferSelectModel<typeof availabilityRules>
export type AvailabilityOverride = InferSelectModel<typeof availabilityOverrides>

// ── Slot types ─────────────────────────────────────────────────────────────

export interface TimeSlot {
  start: string // ISO 8601
  end: string   // ISO 8601
  available: boolean
}

// ── Request shapes ─────────────────────────────────────────────────────────

export interface CreateBookingRequest {
  instructorId: string
  serviceId: string
  scheduledAt: string // ISO 8601
  notes?: string
  meetingLocation?: string
}

export interface UpdateBookingStatusRequest {
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show'
  reason?: string
}

export interface CreateServiceRequest {
  name: string
  description?: string
  durationMinutes: number
  priceAud: string // decimal string e.g. "95.00"
  instructorId?: string
}

export interface CreateAvailabilityRuleRequest {
  instructorId: string
  dayOfWeek: number // 0=Sun, 6=Sat
  startTime: string // "HH:MM"
  endTime: string
}

export interface CreateAvailabilityOverrideRequest {
  instructorId: string
  date: string // ISO date "YYYY-MM-DD"
  isAvailable: boolean
  startTime?: string
  endTime?: string
  reason?: string
}

// ── Response shapes ────────────────────────────────────────────────────────

export interface BookingWithDetails extends Booking {
  service: Service | null
  student: {
    id: string
    firstName: string | null
    lastName: string | null
    email: string
    phone: string | null
  } | null
}

export interface AvailabilityResponse {
  date: string
  instructorId: string
  slots: TimeSlot[]
}

export interface ServiceResponse {
  id: string
  name: string
  description: string | null
  durationMinutes: number
  priceAud: string
  isActive: boolean
}
