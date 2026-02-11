import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY: jwt.SignOptions['expiresIn'] = (process.env.JWT_EXPIRY as jwt.SignOptions['expiresIn']) || '7d';

if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET environment variable is required in production');
}

const JWT_SECRET_VALUE = JWT_SECRET || 'dev_only_jwt_secret_change_me';

export function generateToken(userId: Types.ObjectId): string {
  return jwt.sign({ userId }, JWT_SECRET_VALUE, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): { userId: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET_VALUE) as { userId: string };
  } catch (error) {
    return null;
  }
}

export function parseToken(authHeader: string): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}
