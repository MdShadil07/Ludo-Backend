import { Request, Response, NextFunction } from 'express';
import { verifyToken, parseToken } from '../utils/jwt';
import { Types } from 'mongoose';

declare global {
  namespace Express {
    interface Request {
      userId?: Types.ObjectId;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = parseToken(req.headers.authorization || '');

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }

  req.userId = new Types.ObjectId(payload.userId);
  next();
}
