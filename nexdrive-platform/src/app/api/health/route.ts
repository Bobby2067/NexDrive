import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, isDatabaseConfigured } from '@/lib/db'
import { redis, isRedisConfigured } from '@/lib/redis'
import { getRuntimeMode, toErrorMessage } from '@/lib/runtime'

async function checkDatabase() {
  if (!isDatabaseConfigured) {
    return { configured: false, healthy: false, message: 'DATABASE_URL missing' }
  }

  try {
    await db.execute(sql`select 1`)
    return { configured: true, healthy: true, message: 'ok' }
  } catch (error) {
    return { configured: true, healthy: false, message: toErrorMessage(error) }
  }
}

async function checkRedis() {
  if (!isRedisConfigured) {
    return { configured: false, healthy: false, message: 'UPSTASH_REDIS_* missing' }
  }

  try {
    await redis.ping()
    return { configured: true, healthy: true, message: 'ok' }
  } catch (error) {
    return { configured: true, healthy: false, message: toErrorMessage(error) }
  }
}

function checkStripe() {
  return {
    configured: Boolean(process.env.STRIPE_SECRET_KEY),
    healthy: Boolean(process.env.STRIPE_SECRET_KEY),
    message: process.env.STRIPE_SECRET_KEY ? 'configured' : 'STRIPE_SECRET_KEY missing',
  }
}

function checkClerk() {
  const configured = Boolean(process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
  return {
    configured,
    healthy: configured,
    message: configured ? 'configured' : 'CLERK keys missing',
  }
}

export async function GET() {
  const [database, redisStatus] = await Promise.all([checkDatabase(), checkRedis()])
  const stripe = checkStripe()
  const clerk = checkClerk()
  const mode = getRuntimeMode()

  const readyForFullFeatures = database.healthy && stripe.healthy && clerk.healthy

  return NextResponse.json({
    status: readyForFullFeatures ? 'ok' : mode === 'local' ? 'local-degraded' : 'degraded',
    mode,
    timestamp: new Date().toISOString(),
    readyForFullFeatures,
    dependencies: {
      database,
      redis: redisStatus,
      stripe,
      clerk,
    },
  })
}
