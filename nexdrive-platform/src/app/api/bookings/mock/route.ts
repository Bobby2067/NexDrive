import { NextResponse } from 'next/server'
import { createMockBooking, getMockBookings } from '@/lib/mock/bookings'
import type { CreateBookingRequest } from '@/lib/types/booking.types'
import { isLocalModeEnabled } from '@/lib/runtime'

export async function GET(req: Request) {
  if (!isLocalModeEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const limit = Math.min(Number(searchParams.get('limit') ?? 20), 100)
  const offset = Number(searchParams.get('offset') ?? 0)

  return NextResponse.json({
    bookings: getMockBookings(limit, offset),
    mode: 'local-mock',
  })
}

export async function POST(req: Request) {
  if (!isLocalModeEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let body: CreateBookingRequest
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.instructorId || !body.serviceId || !body.scheduledAt) {
    return NextResponse.json({ error: 'instructorId, serviceId and scheduledAt are required' }, { status: 400 })
  }

  return NextResponse.json({
    booking: createMockBooking(body),
    mode: 'local-mock',
  }, { status: 201 })
}
