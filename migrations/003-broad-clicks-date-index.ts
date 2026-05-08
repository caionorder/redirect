import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

async function up() {
  const url = process.env.MONGODB_URL;
  if (!url) {
    console.error('MONGODB_URL nao definido no .env');
    process.exit(1);
  }

  const client = await MongoClient.connect(url, { appName: 'redirect-migrations' });
  try {
    const db = client.db(process.env.MONGO_DB_NAME || 'admanager');
    const col = db.collection('broad_clicks');

    await col.createIndex(
      { date: 1, broad_id: 1 },
      { background: true, name: 'date_broadId' }
    );
    console.log('OK indice date_broadId');

    console.log('OK migrations/003-broad-clicks-date-index');
  } finally {
    await client.close();
  }
}

up().catch((e) => {
  console.error(e);
  process.exit(1);
});
