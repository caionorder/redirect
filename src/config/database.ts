import { MongoClient, Db } from 'mongodb';

export async function connectDB(mongoUrl: string): Promise<Db> {
  try {
    const client = await MongoClient.connect(mongoUrl);
    const db = client.db('admanager');
    return db;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}
