import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import cors from 'cors';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from './utils/database';
import { logSupabaseProfileStorageStatus } from './controllers/profileController';
import { initSocket } from './socket';
import { gameStateCache } from './state/gameStateCache';
import { engagementStateCache } from './game-logic/engagement-engine/engagementStateCache';
import { tauntStateCache } from './engagement/taunts';
import { registerHttpModules } from './modules/http/registerHttpModules';
// Register Mongoose models
import './models/User';
import './models/Room';
import './models/RoomPlayer';
import './models/RoomTeam';
import './models/GameEvent';
import './messages/models/Conversation';
import './messages/models/Message';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const ALLOW_LOCALHOST_ORIGINS = process.env.ALLOW_LOCALHOST_ORIGINS !== 'false';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
let server: http.Server | null = null;

if (Number.isNaN(PORT) || PORT <= 0) {
  throw new Error('PORT must be a valid positive number');
}

if (IS_PRODUCTION && !process.env.CORS_ORIGIN) {
  throw new Error('CORS_ORIGIN environment variable is required in production');
}

if (IS_PRODUCTION && !process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required in production');
}

if (IS_PRODUCTION && ALLOW_LOCALHOST_ORIGINS) {
  console.warn('ALLOW_LOCALHOST_ORIGINS=true in production. Set it to false unless explicitly required.');
}

const LOCALHOST_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8080',
  'http://localhost:8081',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8081',
];

// Parse allowed origins from env (comma-separated) and optionally allow local dev origins.
const configuredOrigins = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
for (const origin of configuredOrigins) {
  try {
    new URL(origin);
  } catch {
    throw new Error(`Invalid CORS_ORIGIN entry: "${origin}"`);
  }
}
const allowedOrigins = Array.from(
  new Set([
    ...configuredOrigins,
    ...(ALLOW_LOCALHOST_ORIGINS ? LOCALHOST_ORIGINS : []),
  ])
);

// Middleware
app.use(express.json({ limit: "8mb" }));
app.disable('x-powered-by');
if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g., server-to-server, testing tools)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Not allowed
    return callback(new Error(`CORS policy: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// Routes

// Health check
app.get('/health', (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const dbState = dbStates[mongoose.connection.readyState] || 'unknown';

  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    dbState,
    redisConnected: gameStateCache.isRedisConnected(),
    engagementRedisConnected: engagementStateCache.isRedisConnected(),
    tauntRedisConnected: tauntStateCache.isRedisConnected(),
  });
});

// Start server
async function start() {
  try {
    await connectDB();
    await gameStateCache.init();
    await engagementStateCache.init();
    await tauntStateCache.init();
    await logSupabaseProfileStorageStatus();

    // ONLY set up routes AFTER the database is connected
    registerHttpModules(app);

    server = http.createServer(app);
    initSocket(server, allowedOrigins.join(','));

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down gracefully...`);

  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close(err => (err ? reject(err) : resolve()));
      });
    }
    await engagementStateCache.shutdown();
    await tauntStateCache.shutdown();
    await gameStateCache.shutdown();
    await disconnectDB();
    process.exit(0);
  } catch (error) {
    console.error('Graceful shutdown failed:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  void shutdown('uncaughtException');
});

start();
