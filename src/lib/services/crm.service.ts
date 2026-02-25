import { db } from '../db'
import {
  contacts,
  profiles,
  students,
  auditLog,
} from '../schema'
import { eq, and, ilike, or, desc } from 'drizzle-orm'
import type {
  Contact,
  ContactLifecycle,
  ContactSearchFilters,
  CreateContactRequest,
  UpdateContactRequest,
  ContactWithMeta,
} from '../types/crm.types'
import { LIFECYCLE_TRANSITIONS } from '../types/crm.types'

// ── Search & list ──────────────────────────────────────────────────────────

export async function searchContacts(
  instructorId: string,
  filters: ContactSearchFilters
): Promise<ContactWithMeta[]> {
  const { lifecycle, search, limit = 20, offset = 0 } = filters

  let query = db
    .select()
    .from(contacts)
    .where(eq(contacts.instructorId, instructorId))
    .$dynamic()

  if (lifecycle) {
    query = query.where(
      and(
        eq(contacts.instructorId, instructorId),
        eq(contacts.lifecycle, lifecycle)
      )
    )
  }

  if (search) {
    query = query.where(
      and(
        eq(contacts.instructorId, instructorId),
        or(
          ilike(contacts.firstName, `%${search}%`),
          ilike(contacts.lastName ?? '', `%${search}%`),
          ilike(contacts.email ?? '', `%${search}%`),
          ilike(contacts.phone ?? '', `%${search}%`)
        )
      )
    )
  }

  const rows = await query
    .orderBy(desc(contacts.updatedAt))
    .limit(Math.min(limit, 100))
    .offset(offset)

  return rows
}

// ── Create ─────────────────────────────────────────────────────────────────

export async function createContact(
  instructorId: string,
  data: CreateContactRequest,
  actorProfileId: string
): Promise<Contact> {
  // Check if email matches an existing profile — link if so
  let linkedProfileId: string | null = null
  if (data.email) {
    const existingProfile = await db
      .select()
      .from(profiles)
      .where(eq(profiles.email, data.email))
      .limit(1)
    if (existingProfile.length > 0) {
      linkedProfileId = existingProfile[0].id
    }
  }

  const [contact] = await db
    .insert(contacts)
    .values({
      instructorId,
      profileId: linkedProfileId,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: data.phone,
      source: data.source,
      notes: data.notes,
      lifecycle: 'prospect',
    })
    .returning()

  await db.insert(auditLog).values({
    actorProfileId,
    action: 'CONTACT_CREATED',
    entityType: 'contact',
    entityId: contact.id,
    payload: { instructorId, email: data.email },
  })

  return contact
}

// ── Update ─────────────────────────────────────────────────────────────────

export async function updateContact(
  contactId: string,
  instructorId: string,
  data: UpdateContactRequest,
  actorProfileId: string
): Promise<Contact> {
  const existing = await getContactOrThrow(contactId, instructorId)

  const [updated] = await db
    .update(contacts)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(contacts.id, contactId))
    .returning()

  await db.insert(auditLog).values({
    actorProfileId,
    action: 'CONTACT_UPDATED',
    entityType: 'contact',
    entityId: contactId,
    payload: data,
  })

  return updated
}

// ── Lifecycle transitions ──────────────────────────────────────────────────

export async function advanceLifecycle(
  contactId: string,
  instructorId: string,
  newStage: ContactLifecycle,
  actorProfileId: string
): Promise<Contact> {
  const contact = await getContactOrThrow(contactId, instructorId)
  const currentStage = contact.lifecycle as ContactLifecycle

  const allowed = LIFECYCLE_TRANSITIONS[currentStage]
  if (!allowed.includes(newStage)) {
    throw new Error(
      `Cannot transition from '${currentStage}' to '${newStage}'. Allowed: ${allowed.join(', ')}`
    )
  }

  const [updated] = await db
    .update(contacts)
    .set({ lifecycle: newStage, updatedAt: new Date() })
    .where(eq(contacts.id, contactId))
    .returning()

  await db.insert(auditLog).values({
    actorProfileId,
    action: 'LIFECYCLE_CHANGED',
    entityType: 'contact',
    entityId: contactId,
    payload: { from: currentStage, to: newStage },
  })

  // Auto-create student record when enrolling
  if (newStage === 'enrolled') {
    await enrollContact(contact, instructorId, actorProfileId)
  }

  return updated
}

// ── Enrolment ──────────────────────────────────────────────────────────────

async function enrollContact(
  contact: Contact,
  instructorId: string,
  actorProfileId: string
): Promise<void> {
  if (!contact.profileId) return // no linked profile yet — student will create account later

  // Check if student record already exists
  const existing = await db
    .select()
    .from(students)
    .where(eq(students.profileId, contact.profileId))
    .limit(1)

  if (existing.length > 0) return // already enrolled

  await db.insert(students).values({
    profileId: contact.profileId,
    instructorId,
    isActive: true,
    enrolledAt: new Date(),
  })

  await db.insert(auditLog).values({
    actorProfileId,
    action: 'STUDENT_ENROLLED',
    entityType: 'student',
    entityId: contact.profileId,
    payload: { contactId: contact.id, instructorId },
  })
}

// ── Soft delete ────────────────────────────────────────────────────────────

export async function softDeleteContact(
  contactId: string,
  instructorId: string,
  actorProfileId: string
): Promise<void> {
  await getContactOrThrow(contactId, instructorId)

  // We don't have deleted_at on the schema yet — set lifecycle to inactive as soft delete
  await db
    .update(contacts)
    .set({ lifecycle: 'inactive', updatedAt: new Date() })
    .where(eq(contacts.id, contactId))

  await db.insert(auditLog).values({
    actorProfileId,
    action: 'CONTACT_DELETED',
    entityType: 'contact',
    entityId: contactId,
    payload: {},
  })
}

// ── Helper ─────────────────────────────────────────────────────────────────

async function getContactOrThrow(contactId: string, instructorId: string): Promise<Contact> {
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.instructorId, instructorId)))
    .limit(1)

  if (rows.length === 0) throw new Error('Contact not found')
  return rows[0]
}