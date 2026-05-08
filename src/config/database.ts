import { MongoClient, Db } from 'mongodb';

export async function connectDB(mongoUrl: string): Promise<Db> {
  try {
    const client = await MongoClient.connect(mongoUrl, {
      appName: 'redirect',
      maxPoolSize: 30,
      minPoolSize: 5,
      maxIdleTimeMS: 60_000,
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 20_000,
      connectTimeoutMS: 5_000,
      waitQueueTimeoutMS: 2_000,
      retryWrites: true,
      retryReads: true,
    });
    const db = client.db('admanager');
    return db;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}
