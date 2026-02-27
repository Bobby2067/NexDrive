import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { services, profiles, instructors } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import type { CreateServiceRequest } from '@/lib/types/booking.types'
import { dependencyPayload, isDependencyError, isLocalModeEnabled } from '@/lib/runtime'

function getLocalMockServices(instructorId: string | null) {
  return [
    {
      id: 'mock-service-60',
      instructorId: instructorId ?? 'mock-instructor',
      name: 'Driving Lesson (60m)',
      description: 'Local mock service for brownfield development mode.',
      durationMinutes: 60,
      priceCents: 9500,
      isActive: true,
    },
    {
      id: 'mock-service-90',
      instructorId: instructorId ?? 'mock-instructor',
      name: 'Driving Lesson (90m)',
      description: 'Extended lesson available in local mock mode.',
      durationMinutes: 90,
      priceCents: 13500,
      isActive: true,
    },
  ]
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const instructorId = searchParams.get('instructorId')

  try {
    const rows = instructorId
      ? await db.select().from(services).where(and(eq(services.isActive, true), eq(services.instructorId, instructorId)))
      : await db.select().from(services).where(eq(services.isActive, true))

    return NextResponse.json({ services: rows })
  } catch (error) {
    if (isLocalModeEnabled() && isDependencyError(error)) {
      return NextResponse.json({
        services: getLocalMockServices(instructorId),
        mode: 'local-mock',
        warning: 'Database unavailable, returning local mock services.',
      })
    }

    if (isDependencyError(error)) {
      return NextResponse.json(dependencyPayload(error, 'database'), { status: 503 })
    }

    return NextResponse.json({ error: 'Failed to load services' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const instructor = await db.select({ instructor: instructors }).from(instructors).innerJoin(profiles, eq(instructors.profileId, profiles.id)).where(eq(profiles.clerkUserId, userId)).limit(1).then(r => r[0]?.instructor ?? null)
    if (!instructor) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    let body: CreateServiceRequest
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

    if (!body.name || !body.durationMinutes || !body.priceAud) return NextResponse.json({ error: 'name, durationMinutes and priceAud are required' }, { status: 400 })

    // Convert AUD decimal string ("95.00") to integer cents (9500) — schema stores priceCents
    const priceCents = Math.round(parseFloat(body.priceAud) * 100)
    if (isNaN(priceCents) || priceCents <= 0) return NextResponse.json({ error: 'priceAud must be a positive number' }, { status: 400 })

    const [service] = await db.insert(services).values({
      instructorId: instructor.id,
      name: body.name,
      description: body.description,
      durationMinutes: body.durationMinutes,
      priceCents,
      isActive: true,
    }).returning()

    return NextResponse.json({ service }, { status: 201 })
  } catch (error) {
    if (isDependencyError(error)) {
      return NextResponse.json(dependencyPayload(error, 'database'), { status: 503 })
    }

    return NextResponse.json({ error: 'Failed to create service' }, { status: 500 })
  }
}
