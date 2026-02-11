import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { generateToken } from '../utils/jwt';
import { formatErrorResponse, formatSuccessResponse } from '../utils/helpers';

export async function register(req: Request, res: Response) {
  try {
    const { email, password, displayName } = req.body;

    if (!email || !password || !displayName) {
      return res.status(400).json(formatErrorResponse('Missing required fields'));
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json(formatErrorResponse('User already exists'));
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({
      email,
      password: hashedPassword,
      displayName,
      avatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${email}`,
    });

    await user.save();

    const token = generateToken(user._id);

    return res.status(201).json(
      formatSuccessResponse({
        userId: user._id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        token,
      }, 'User registered successfully')
    );
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json(formatErrorResponse('Registration failed'));
  }
}

export async function login(req: Request, res: Response) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json(formatErrorResponse('Email and password required'));
    }

    const user = await User.findOne({ email });
    if (!user || !user.password) {
      return res.status(401).json(formatErrorResponse('Invalid credentials'));
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json(formatErrorResponse('Invalid credentials'));
    }

    const token = generateToken(user._id);

    return res.json(
      formatSuccessResponse({
        userId: user._id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        xp: user.xp,
        level: user.level,
        gamesPlayed: user.gamesPlayed,
        wins: user.wins,
        token,
      }, 'Login successful')
    );
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json(formatErrorResponse('Login failed'));
  }
}

export async function getProfile(req: Request, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json(formatErrorResponse('Unauthorized'));
    }

    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json(formatErrorResponse('User not found'));
    }

    return res.json(
      formatSuccessResponse({
        userId: user._id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        xp: user.xp,
        level: user.level,
        gamesPlayed: user.gamesPlayed,
        wins: user.wins,
      })
    );
  } catch (error) {
    console.error('Get profile error:', error);
    return res.status(500).json(formatErrorResponse('Failed to fetch profile'));
  }
}
