import { FastifyRequest, FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { getConfig } from '../config.js';

let redis: Redis | null = null;
const fallbackMap = new Map<string, { count: number; resetAt: number }>();

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(getConfig().REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

export function rateLimit(maxAttempts: number, windowSeconds: number) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ip = request.ip;
    const key = `rl:${request.routeOptions.url}:${ip}`;
    const r = getRedis();

    try {
      const current = await r.incr(key);
      if (current === 1) {
        await r.expire(key, windowSeconds);
      }

      reply.header('X-RateLimit-Limit', maxAttempts);
      reply.header('X-RateLimit-Remaining', Math.max(0, maxAttempts - current));

      if (current > maxAttempts) {
        const ttl = await r.ttl(key);
        reply.header('Retry-After', ttl);
        reply.status(429).send({
          error: 'Too many requests',
          retryAfter: ttl,
        });
        return;
      }
    } catch (err) {
      console.error('Rate limit Redis error:', err);
      const now = Date.now();
      for (const [k, v] of fallbackMap.entries()) {
        if (v.resetAt < now) fallbackMap.delete(k);
      }
      
      let record = fallbackMap.get(key);
      if (!record || record.resetAt < now) {
        record = { count: 0, resetAt: now + windowSeconds * 1000 };
      }
      record.count++;
      fallbackMap.set(key, record);
      
      const current = record.count;
      reply.header('X-RateLimit-Limit', maxAttempts);
      reply.header('X-RateLimit-Remaining', Math.max(0, maxAttempts - current));

      if (current > maxAttempts) {
        const ttl = Math.ceil((record.resetAt - now) / 1000);
        reply.header('Retry-After', Math.max(1, ttl));
        reply.status(429).send({
          error: 'Too many requests',
          retryAfter: Math.max(1, ttl),
        });
        return;
      }
    }
  };
}

export function loginRateLimit() {
  const config = getConfig();
  return rateLimit(config.LOGIN_RATE_LIMIT, config.LOGIN_RATE_WINDOW);
}

export function globalRateLimit() {
  const config = getConfig();
  return rateLimit(config.GLOBAL_RATE_LIMIT, config.GLOBAL_RATE_WINDOW);
}
