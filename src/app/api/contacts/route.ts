import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles, instructors } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import {
  searchContacts,
  createContact,
} from '@/lib/services/crm.service'
import type { ContactLifecycle, CreateContactRequest } from '@/lib/types/crm.types'

// GET /api/contacts?lifecycle=active&search=rob&limit=20&offset=0
export async function GET(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const instructor = await getInstructorFromClerkId(userId)
  if (!instructor) return NextResponse.json({ error: 'Forbidden — instructors only' }, { status: 403 })

  const { searchParams } = new URL(req.url)

  const results = await searchContacts(instructor.id, {
    lifecycle: searchParams.get('lifecycle') as ContactLifecycle | undefined,
    search: searchParams.get('search') ?? undefined,
    limit: Number(searchParams.get('limit') ?? 20),
    offset: Number(searchParams.get('offset') ?? 0),
  })

  return NextResponse.json({ contacts: results })
}

// POST /api/contacts
export async function POST(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { instructor, profile } = await getInstructorAndProfile(userId)
  if (!instructor || !profile) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: CreateContactRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.firstName) {
    return NextResponse.json({ error: 'firstName is required' }, { status: 400 })
  }

  const contact = await createContact(instructor.id, body, profile.id)
  return NextResponse.json({ contact }, { status: 201 })
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function getInstructorFromClerkId(clerkUserId: string) {
  const rows = await db
    .select({ instructor: instructors })
    .from(instructors)
    .innerJoin(profiles, eq(instructors.profileId, profiles.id))
    .where(eq(profiles.clerkUserId, clerkUserId))
    .limit(1)
  return rows[0]?.instructor ?? null
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