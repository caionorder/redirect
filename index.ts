import { setupCluster } from './src/config/cluster.js';
import { createApp } from './src/app.js';
import dotenv from 'dotenv';

dotenv.config();

setupCluster(async () => {
  const app = await createApp();
  const port = process.env.PORT || 3000;

  app.listen(port, () => {
    console.log(`Worker ${process.pid} started on port ${port}`);
  });
});
