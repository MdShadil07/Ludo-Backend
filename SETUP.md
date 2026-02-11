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
   - `CORS_ORIGIN`: Frontend URL (default: `http://localhost:5173`)

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
- `status`: String ('waiting' | 'playing' | 'finished')
- `createdAt`: Date
- `updatedAt`: Date

Unique index: `{ roomId, userId }`
