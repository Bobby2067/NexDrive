import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { services, profiles, instructors } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import type { CreateServiceRequest } from '@/lib/types/booking.types'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const instructorId = searchParams.get('instructorId')

  const rows = instructorId
    ? await db.select().from(services).where(and(eq(services.isActive, true), eq(services.instructorId, instructorId)))
    : await db.select().from(services).where(eq(services.isActive, true))

  return NextResponse.json({ services: rows })
}

export async function POST(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const instructor = await db.select({ instructor: instructors }).from(instructors).innerJoin(profiles, eq(instructors.profileId, profiles.id)).where(eq(profiles.clerkUserId, userId)).limit(1).then(r => r[0]?.instructor ?? null)
  if (!instructor) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: CreateServiceRequest
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.name || !body.durationMinutes || !body.priceAud) return NextResponse.json({ error: 'name, durationMinutes and priceAud are required' }, { status: 400 })

  const [service] = await db.insert(services).values({ instructorId: instructor.id, name: body.name, description: body.description, durationMinutes: body.durationMinutes, priceAud: body.priceAud, isActive: true }).returning()
  return NextResponse.json({ service }, { status: 201 })
}
