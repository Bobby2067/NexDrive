import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { contacts, profiles, instructors } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import {
  updateContact,
  softDeleteContact,
} from '@/lib/services/crm.service'
import type { UpdateContactRequest } from '@/lib/types/crm.types'

// GET /api/contacts/[id]
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { instructor } = await getInstructorAndProfile(userId)
  if (!instructor) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, params.id), eq(contacts.instructorId, instructor.id)))
    .limit(1)

  if (rows.length === 0) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

  return NextResponse.json({ contact: rows[0] })
}

// PATCH /api/contacts/[id]
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { instructor, profile } = await getInstructorAndProfile(userId)
  if (!instructor || !profile) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: UpdateContactRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    const contact = await updateContact(params.id, instructor.id, body, profile.id)
    return NextResponse.json({ contact })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

// DELETE /api/contacts/[id] — soft delete
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { instructor, profile } = await getInstructorAndProfile(userId)
  if (!instructor || !profile) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    await softDeleteContact(params.id, instructor.id, profile.id)
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

// ── Helper ─────────────────────────────────────────────────────────────────

async function getInstructorAndProfile(clerkUserId: string) {
  const rows = await db
    .select({ instructor: instructors, profile: profiles })
    .from(instructors)
    .innerJoin(profiles, eq(instructors.profileId, profiles.id))
    .where(eq(profiles.clerkUserId, clerkUserId))
    .limit(1)
  return rows[0] ?? { instructor: null, profile: null }
}