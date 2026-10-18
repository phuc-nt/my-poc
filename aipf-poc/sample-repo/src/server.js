import { createServer } from 'node:http';
import { createHandler } from './app.js';
import { createPool } from './db.js';

const port = Number(process.env.PORT || 3000);
const db = createPool();
createServer(createHandler(db)).listen(port, () => {
  process.stdout.write(`mlh-service-desk listening on ${port}\n`);
});
