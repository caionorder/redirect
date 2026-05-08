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
    const col = db.collection('redirects_links');

    // Verifica duplicatas em (domain, url) ANTES de tentar criar indice unique.
    // Se houver duplicatas, cria como NAO unique para nao abortar.
    const dupes = await col.aggregate([
      { $group: { _id: { domain: '$domain', url: '$url' }, c: { $sum: 1 } } },
      { $match: { c: { $gt: 1 } } },
      { $limit: 10 },
    ]).toArray();

    let domainUrlUnique = true;
    if (dupes.length > 0) {
      console.warn('AVISO: duplicatas em (domain, url) detectadas — criando indice NAO unique. Resolver duplicatas e recriar como unique manualmente.');
      console.warn('Amostra de duplicatas:', JSON.stringify(dupes, null, 2));
      domainUrlUnique = false;
    }

    await col.createIndex(
      { domain: 1, url: 1 },
      { unique: domainUrlUnique, background: true, name: 'domain_url_unique' }
    );
    console.log(`OK indice domain_url_unique (unique=${domainUrlUnique})`);

    await col.createIndex(
      { domain: 1, created_at: -1 },
      { background: true, name: 'domain_createdAt' }
    );
    console.log('OK indice domain_createdAt');

    await col.createIndex(
      { created_at: -1 },
      { background: true, name: 'createdAt' }
    );
    console.log('OK indice createdAt');

    console.log('OK migrations/001-redirects-links-indexes');
  } finally {
    await client.close();
  }
}

up().catch((e) => {
  console.error(e);
  process.exit(1);
});
