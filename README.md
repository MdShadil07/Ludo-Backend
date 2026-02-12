# Ludo Backend

Backend API and Socket.IO server for the Ludo game.

## Requirements

- Node.js 20+
- npm 10+
- MongoDB (local or cloud)

## Environment Variables

Copy `.env.example` to `.env` and set real values:

```bash
cp .env.example .env
```

Required for production:

- `MONGODB_URI`
- `JWT_SECRET`
- `CORS_ORIGIN`
- `SUPABASE_URL` (required for profile avatar upload)
- `SUPABASE_SERVICE_ROLE_KEY` (required for profile avatar upload)
- `PORT` (optional, defaults to `5000`)
- `JWT_EXPIRY` (optional, defaults to `7d`)
- `REDIS_URL` (recommended for low-latency game state + crash recovery)
- `SUPABASE_AVATAR_BUCKET` (optional, defaults to `uploads`)

Optional cache tuning:

- `GAME_STATE_FLUSH_INTERVAL_MS` (default `2000`)
- `GAME_STATE_CACHE_TTL_SECONDS` (default `3600`)
- `GAME_MOVE_LOG_TTL_SECONDS` (default `86400`)
- `GAME_MOVE_LOG_MAX_ITEMS` (default `300`)
- `GAME_CACHE_DEBUG=true` (logs per move/roll cache revision updates)
- `GAME_PERF_DEBUG=true` (logs per-endpoint latency segments)
- `SOCKET_DEBUG=true` (logs room:update payload size)
- `ENGAGEMENT_DICE_ENABLED=true` (enable weighted engagement dice strategy)
- `ENGAGEMENT_DICE_DEBUG=true` (logs dice weight/context calculation)
- `ROOM_PLAYERS_CACHE_TTL_MS` (default `15000`, hot cache for room players)

Cache debug checks:

- `GET /health` returns `redisConnected`.
- `GET /api/rooms/:roomId/cache-status` returns in-memory and Redis revisions/state.

## Local Development

```bash
npm install
npm run dev
```

## Production (Without Docker)

```bash
npm ci
npm run build
npm start
```

## Render Deployment

This project is configured for Render using `render.yaml`.

### Option 1: Blueprint Deploy (Recommended)

1. Push this repo to GitHub.
2. In Render, click `New +` -> `Blueprint`.
3. Select the repo.
4. Set secret env vars in Render:
   - `MONGODB_URI`
   - `JWT_SECRET`
   - `CORS_ORIGIN`
5. Deploy.

### Option 2: Manual Web Service

- Runtime: `Node`
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check path: `/health`

Health endpoint:

```bash
GET /health
```
