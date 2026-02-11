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
- `PORT` (optional, defaults to `5000`)
- `JWT_EXPIRY` (optional, defaults to `7d`)

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
