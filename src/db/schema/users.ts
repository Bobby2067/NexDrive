import {
    pgTable,
    uuid,
    text,
    date,
    timestamp,
    boolean,
    integer,
    numeric,
    index,
} from 'drizzle-orm/pg-core';

// ─────────────────────────────────────────────
// PROFILES
// Extended user data for all user types.
// Clerk owns identity/auth externally.
// ─────────────────────────────────────────────
export const profiles = pgTable('profiles', {
    id: uuid('id').primaryKey().defaultRandom(),

    // Clerk user ID — TEXT, not a foreign key
    userId: text('user_id').notNull().unique(),

    // Identity
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),                          // AU format: +61XXXXXXXXX
    dateOfBirth: date('date_of_birth'),

    // Address
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    suburb: text('suburb'),
    state: text('state').default('ACT'),
    postcode: text('postcode'),

    // Role
    role: text('role', { enum: ['admin', 'instructor', 'student', 'parent'] }).notNull(),

    // Status
    status: text('status', { enum: ['active', 'inactive', 'suspended'] }).notNull().default('active'),
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),

    // Avatar
    avatarUrl: text('avatar_url'),

    // Meta
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
    index('idx_profiles_user_id').on(table.userId),
    index('idx_profiles_role').on(table.role),
    index('idx_profiles_email').on(table.email),
    index('idx_profiles_phone').on(table.phone),
]);

// ─────────────────────────────────────────────
// INSTRUCTORS
// ─────────────────────────────────────────────
export const instructors = pgTable('instructors', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull().unique(), // Clerk user ID
    profileId: uuid('profile_id').notNull().unique().references(() => profiles.id),

    // ADI Details (ACT Government)
    adiNumber: text('adi_number').notNull(),
    adiExpiry: date('adi_expiry').notNull(),

    // Vehicle
    vehicleRego: text('vehicle_rego'),
    vehicleMake: text('vehicle_make'),
    vehicleModel: text('vehicle_model'),
    vehicleYear: integer('vehicle_year'),
    transmission: text('transmission', { enum: ['manual', 'auto', 'both'] }),

    // Business
    isOwner: boolean('is_owner').notNull().default(false), // Platform owner (Rob) vs contractor
    hourlyRate: integer('hourly_rate'), // Cents
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }),
    territory: text('territory'),
    bio: text('bio'),

    // Availability defaults
    defaultBufferMinutes: integer('default_buffer_minutes').notNull().default(15),
    maxLessonsPerDay: integer('max_lessons_per_day').notNull().default(8),

    // Status
    status: text('status', {
        enum: ['active', 'inactive', 'onboarding', 'suspended'],
    }).notNull().default('active'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index('idx_instructors_user_id').on(table.userId),
    index('idx_instructors_adi_number').on(table.adiNumber),
]);
