# Backend Configuration

1. **Set up MongoDB**:
   - Install MongoDB locally or use MongoDB Atlas (cloud)
   - Update `MONGODB_URI` in `.env`

2. **Environment Variables**:
   ```bash
   cp .env.example .env
   ```
   
   Update the following variables in `.env`:
   - `MONGODB_URI`: Connection string to your MongoDB (default: `mongodb://localhost:27017/ludo-game`)
   - `JWT_SECRET`: Random secret key for JWT tokens (e.g., `your-secret-key-here`)
   - `JWT_EXPIRY`: Token expiry duration (default: `7d`)
   - `PORT`: Server port (default: `5000`)
   - `NODE_ENV`: Environment (default: `development`)
   - `CORS_ORIGIN`: Frontend URL(s), comma-separated. Example: `https://your-frontend-domain.com,http://localhost:8081`
   - `ALLOW_LOCALHOST_ORIGINS`: Allow local dev origins (`localhost` / `127.0.0.1`) in CORS (default: `true`)

3. **Install Dependencies**:
   ```bash
   npm install
   ```

4. **Run Development Server**:
   ```bash
   npm run dev
   ```
   Server will start at `http://localhost:5000`

5. **Build for Production**:
   ```bash
   npm run build
   npm start
   ```

## API Endpoints

### Authentication Routes (`/api/auth`)
- `POST /register` - Register new user
  - Body: `{ email, password, displayName }`
- `POST /login` - Login user
  - Body: `{ email, password }`
- `GET /profile` - Get user profile (requires auth)

### Room Routes (`/api/rooms`)
- `POST /` - Create a new room (requires auth)
  - Body: `{ maxPlayers, mode, visibility }`
- `GET /` - Get all public rooms
- `POST /join` - Join a room by code (requires auth)
  - Body: `{ code }`
- `GET /:roomId` - Get room details
- `GET /:roomId/teams` - Get persisted team snapshots (requires auth)
- `GET /:roomId/events` - Get persisted room/game events (requires auth)
- `DELETE /:roomId` - Leave a room (requires auth)

## Database Models

### User Collection
- `_id`: ObjectId
- `email`: String (unique, lowercase)
- `password`: String (hashed)
- `displayName`: String
- `avatarUrl`: String
- `googleId`: String (optional)
- `xp`: Number (default: 0)
- `level`: Number (default: 1)
- `gamesPlayed`: Number (default: 0)
- `wins`: Number (default: 0)
- `createdAt`: Date
- `updatedAt`: Date

### Room Collection
- `_id`: ObjectId
- `code`: String (unique, uppercase)
- `hostId`: ObjectId (ref: User)
- `settings` -> Object
  - `maxPlayers`: Number (2-8)
  - `mode`: String ('individual' | 'team')
  - `visibility`: String ('public' | 'private')
- `status`: String ('waiting' | 'in_progress' | 'completed')
- `createdAt`: Date
- `updatedAt`: Date

### RoomPlayer Collection
- `_id`: ObjectId
- `roomId`: ObjectId (ref: Room)
- `userId`: ObjectId (ref: User)
- `color`: String
- `position`: Number (optional)
- `teamIndex`: Number | null (derived team partition in team mode)
- `status`: String ('waiting' | 'playing' | 'finished')
- `createdAt`: Date
- `updatedAt`: Date

Unique index: `{ roomId, userId }`
Additional indexes:
- `{ roomId, position }`
- `{ roomId, teamIndex }`
- `{ roomId, ready }`

### RoomTeam Collection
- `roomId`: ObjectId (ref: Room)
- `teamIndex`: Number
- `name`: String
- `slotIndexes`: Number[]
- `members`: Snapshot array with `roomPlayerId`, `userId`, `displayName`, `color`, `position`

Unique index: `{ roomId, teamIndex }`

### GameEvent Collection
- `roomId`: ObjectId (ref: Room)
- `type`: String (`room:*`, `game:*`, `dice:roll`, `move`, `turn:advance`, etc.)
- `actorUserId`: ObjectId | null
- `actorRoomPlayerId`: ObjectId | null
- `revision`: Number
- `payload`: Mixed (event details)
- `createdAt` / `updatedAt`: Date

Indexes:
- `{ roomId, createdAt: -1 }`
- `{ roomId, type, createdAt: -1 }`
