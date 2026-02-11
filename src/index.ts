import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import cors from 'cors';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from './utils/database';
import authRoutes from './routes/authRoutes';
import roomRoutes from './routes/roomRoutes';
import { initSocket } from './socket';
// Register Mongoose models
import './models/User';
import './models/Room';
import './models/RoomPlayer';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
let server: http.Server | null = null;

if (Number.isNaN(PORT) || PORT <= 0) {
  throw new Error('PORT must be a valid positive number');
}

if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  throw new Error('CORS_ORIGIN environment variable is required in production');
}

// Parse allowed origins from env (comma-separated) and handle dynamic origin
const allowedOrigins = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

// Middleware
app.use(express.json());
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
  });
});

// Start server
async function start() {
  try {
    await connectDB();

    // ONLY set up routes AFTER the database is connected
    app.use('/api/auth', authRoutes);
    app.use('/api/rooms', roomRoutes);

    server = http.createServer(app);
    initSocket(server, CORS_ORIGIN);

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
