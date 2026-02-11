import mongoose from 'mongoose';

export async function connectDB() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ludo-game';
    const isProd = process.env.NODE_ENV === 'production';
    const connectOptions: mongoose.ConnectOptions = isProd ? {} : {
      // Relax TLS for local development if Atlas TLS causes handshake issues
      tls: true,
      tlsAllowInvalidCertificates: true,
    } as mongoose.ConnectOptions;

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
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
  } catch (error) {
    console.error('MongoDB disconnection error:', error);
  }
}
