import mongoose from 'mongoose';

export async function connectDB() {
  try {
    const isProd = process.env.NODE_ENV === 'production';
    const envMongoUri = process.env.MONGODB_URI;

    if (isProd && !envMongoUri) {
      throw new Error('MONGODB_URI environment variable is required in production');
    }

    const mongoUri = envMongoUri || 'mongodb://localhost:27017/ludo-game';
    const usingAtlas = mongoUri.includes('mongodb.net');
    const connectOptions: mongoose.ConnectOptions = !isProd && usingAtlas ? {
      // Relax TLS only for local development against Atlas to avoid dev cert issues.
      tls: true,
      tlsAllowInvalidCertificates: true,
    } as mongoose.ConnectOptions : {};

    try {
      await mongoose.connect(mongoUri, connectOptions);
      console.log('MongoDB connected successfully');
    } catch (err) {
      console.error('Primary MongoDB connection failed:', err);
      // If using Atlas in development and it fails, attempt local fallback
      if (!isProd && mongoUri.includes('mongodb.net')) {
        try {
          console.warn('Falling back to local MongoDB at mongodb://localhost:27017/ludo-game');
          await mongoose.connect('mongodb://localhost:27017/ludo-game');
          console.log('Connected to local MongoDB fallback');
          return;
        } catch (fallbackErr) {
          console.error('Fallback MongoDB connection failed:', fallbackErr);
        }
      }
      throw err;
    }
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

export async function disconnectDB() {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      console.log('MongoDB disconnected');
    }
  } catch (error) {
    console.error('MongoDB disconnection error:', error);
  }
}
