import type { InferSelectModel } from 'drizzle-orm'
import type { contacts, profiles } from '../schema'

export type Contact = InferSelectModel<typeof contacts>

export type ContactLifecycle =
  | 'prospect'
  | 'lead'
  | 'qualified'
  | 'enrolled'
  | 'active'
  | 'completed'
  | 'inactive'

// Valid forward transitions
export const LIFECYCLE_TRANSITIONS: Record<ContactLifecycle, ContactLifecycle[]> = {
  prospect:  ['lead', 'inactive'],
  lead:      ['qualified', 'inactive'],
  qualified: ['enrolled', 'inactive'],
  enrolled:  ['active', 'inactive'],
  active:    ['completed', 'inactive'],
  completed: ['inactive'],
  inactive:  ['prospect'], // re-engage
}

export interface CreateContactRequest {
  firstName: string
  lastName?: string
  email?: string
  phone?: string
  source?: string
  notes?: string
}

export interface UpdateContactRequest {
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  notes?: string
  source?: string
}

export interface ContactSearchFilters {
  lifecycle?: ContactLifecycle
  search?: string
  limit?: number
  offset?: number
}

export interface ContactWithMeta extends Contact {
  latestMessage?: string | null
}
