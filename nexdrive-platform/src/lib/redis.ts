import { Redis } from '@upstash/redis';
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim()
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()

export const isRedisConfigured = Boolean(redisUrl && redisToken)

const unavailableRedis = new Proxy(
  {},
  {
    get() {
      throw new Error('Upstash Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.')
    },
  }
) as Redis

export const redis = isRedisConfigured
  ? new Redis({
      url: redisUrl!,
      token: redisToken!,
    })
  : unavailableRedis
