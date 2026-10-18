// Synthetic sample data. Safe to run again: existing rows are left as they are.
import { createPool } from '../src/db.js';

const products = [
  ['H2', 'ML Hub H2', 'Hub', 1490000],
  ['C5', 'ML Cam C5', 'Indoor camera', 890000],
  ['O7', 'ML Cam O7', 'Outdoor camera', 1650000],
  ['L9', 'ML Lock L9', 'Fingerprint door lock', 4990000],
  ['M3', 'ML Mesh M3', 'Mesh Wi-Fi', 2790000],
  ['P1', 'ML Plug P1', 'Smart plug', 190000],
  ['S4', 'ML Sensor S4', 'Door sensor', 290000],
  ['D6', 'ML Bell D6', 'Video doorbell', 1290000],
];

const devices = [
  ['H2-0001', 'H2', '2025-03-10', '0901000001'],
  ['C5-0001', 'C5', '2025-11-02', '0901000002'],
  ['C5-0002', 'C5', '2024-06-15', '0901000003'],
  ['O7-0001', 'O7', '2025-01-20', '0901000004'],
  ['L9-0001', 'L9', '2024-12-01', '0901000005'],
  ['M3-0001', 'M3', '2023-11-30', '0901000006'],
  ['P1-0001', 'P1', '2026-09-25', '0901000007'],
  ['S4-0001', 'S4', '2025-08-08', '0901000008'],
  ['D6-0001', 'D6', '2025-05-05', '0901000009'],
];

const db = createPool();
try {
  for (const row of products) {
    await db.query('INSERT INTO products (code, name, kind, price_vnd) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING', row);
  }
  for (const row of devices) {
    await db.query('INSERT INTO devices (serial, product_code, purchase_date, owner_phone) VALUES ($1, $2, $3, $4) ON CONFLICT (serial) DO NOTHING', row);
  }
  process.stdout.write(`seeded ${products.length} products, ${devices.length} devices\n`);
} finally {
  await db.end();
}
