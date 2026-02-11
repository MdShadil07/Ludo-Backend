import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { connectDB } from './utils/database';
import authRoutes from './routes/authRoutes';
import roomRoutes from './routes/roomRoutes';
import { initSocket } from './socket';
// Register Mongoose models
import './models/User';
import './models/Room';
import './models/RoomPlayer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

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
  res.json({ status: 'Server is running' });
});

// Start server
async function start() {
  try {
    await connectDB();

    // ONLY set up routes AFTER the database is connected
    app.use('/api/auth', authRoutes);
    app.use('/api/rooms', roomRoutes);

    const server = http.createServer(app);
    initSocket(server, CORS_ORIGIN);

    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
