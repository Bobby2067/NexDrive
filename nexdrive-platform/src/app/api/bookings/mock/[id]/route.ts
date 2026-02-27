import { NextResponse } from 'next/server'
import { getMockBookingById, updateMockBookingStatus } from '@/lib/mock/bookings'
import type { UpdateBookingStatusRequest } from '@/lib/types/booking.types'
import { isLocalModeEnabled } from '@/lib/runtime'

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!isLocalModeEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const booking = getMockBookingById(params.id)
  if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

  return NextResponse.json({
    booking,
    mode: 'local-mock',
  })
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!isLocalModeEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let body: UpdateBookingStatusRequest
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.status) return NextResponse.json({ error: 'status is required' }, { status: 400 })
  const validStatuses = ['confirmed', 'cancelled', 'completed', 'no_show']
  if (!validStatuses.includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, { status: 400 })
  }

  const booking = updateMockBookingStatus(params.id, body)
  if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

  return NextResponse.json({
    booking,
    mode: 'local-mock',
  })
}
