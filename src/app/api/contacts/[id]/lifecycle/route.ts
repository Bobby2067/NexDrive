import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles, instructors } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { advanceLifecycle } from '@/lib/services/crm.service'
import type { ContactLifecycle } from '@/lib/types/crm.types'

// POST /api/contacts/[id]/lifecycle
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { instructor, profile } = await getInstructorAndProfile(userId)
  if (!instructor || !profile) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: { stage: ContactLifecycle }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.stage) {
    return NextResponse.json({ error: 'stage is required' }, { status: 400 })
  }

  try {
    const contact = await advanceLifecycle(params.id, instructor.id, body.stage, profile.id)
    return NextResponse.json({ contact })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Lifecycle update failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

async function getInstructorAndProfile(clerkUserId: string) {
  const rows = await db
    .select({ instructor: instructors, profile: profiles })
    .from(instructors)
    .innerJoin(profiles, eq(instructors.profileId, profiles.id))
    .where(eq(profiles.clerkUserId, clerkUserId))
    .limit(1)
  return rows[0] ?? { instructor: null, profile: null }
}