import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { loadConfig } from './config.js';
import { getPool, closePool } from './db/connection.js';
import { closeRedis } from './middleware/rate-limit.js';
import { authRoutes } from './routes/auth.routes.js';
import { vaultRoutes } from './routes/vault.routes.js';
import { familyRoutes } from './routes/family.routes.js';
import { folderRoutes } from './routes/folder.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { loginRateLimit, globalRateLimit } from './middleware/rate-limit.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const app = Fastify({
    logger: config.NODE_ENV !== 'test',
    trustProxy: true, // Behind Nginx
    bodyLimit: 10485760, // 10MB — sufficient for bulk re-encryption payloads
  });

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: false, // API-only server
  });

  // CORS
  await app.register(cors, {
    origin: config.NODE_ENV === 'development'
      ? true
      : [`https://${config.DOMAIN}`, `chrome-extension://*`],
    credentials: true,
  });

  // Health check
  app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Global rate limiting — applies to all routes (100 req/min default)
  const globalLimiter = globalRateLimit();
  app.addHook('onRequest', async (request, reply) => {
    await globalLimiter(request, reply);
  });

  // Stricter login rate limiting for auth-sensitive endpoints
  const loginLimiter = loginRateLimit();
  app.addHook('onRequest', async (request, reply) => {
    if (
      request.url === '/api/auth/login' ||
      request.url === '/api/auth/login/2fa' ||
      request.url === '/api/auth/register'
    ) {
      await loginLimiter(request, reply);
    }
  });

  // Register route modules
  await app.register(authRoutes);
  await app.register(vaultRoutes);
  await app.register(familyRoutes);
  await app.register(folderRoutes);
  await app.register(settingsRoutes);

  // Verify database connection
  try {
    await getPool().query('SELECT 1');
    console.log('Database connected.');
  } catch (err) {
    console.error('Failed to connect to database:', err);
    process.exit(1);
  }

  // Start server
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(`KitPass API listening on port ${config.PORT}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`${signal} received. Shutting down...`);
    await app.close();
    await closePool();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
