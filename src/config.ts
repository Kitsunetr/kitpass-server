import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Database
  DB_HOST: z.string().default('db'),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_NAME: z.string().default('kitpass'),
  DB_USER: z.string().default('kitpass'),
  DB_PASSWORD: z.string().min(1, 'DB_PASSWORD is required'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SERVER_ENCRYPTION_KEY: z.string().length(64, 'SERVER_ENCRYPTION_KEY must be 64 hex chars (256-bit)'),

  // Redis
  REDIS_PASSWORD: z.string().min(1, 'REDIS_PASSWORD is required'),
  REDIS_URL: z.string().default('redis://redis:6379'),

  // Rate limiting
  LOGIN_RATE_LIMIT: z.coerce.number().int().default(5),
  LOGIN_RATE_WINDOW: z.coerce.number().int().default(900), // 15 min
  GLOBAL_RATE_LIMIT: z.coerce.number().int().default(100), // 100 req/window
  GLOBAL_RATE_WINDOW: z.coerce.number().int().default(60), // 60 seconds

  // Token expiry (seconds)
  ACCESS_TOKEN_EXPIRY: z.coerce.number().int().default(900),   // 15 min
  REFRESH_TOKEN_EXPIRY: z.coerce.number().int().default(604800), // 7 days

  // Domain (for CORS, Nginx)
  DOMAIN: z.string().default('localhost'),

  // Crypto Parameters (Argon2id)
  // Enforce strong security minimums per finding L3
  ARGON2_TIME_COST: z.coerce.number().int().min(3).default(3),
  ARGON2_MEMORY: z.coerce.number().int().min(65536).default(65536),
  ARGON2_PARALLELISM: z.coerce.number().int().min(4).default(4),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}
