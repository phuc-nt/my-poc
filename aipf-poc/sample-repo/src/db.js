import pg from 'pg';

// DATE columns stay 'YYYY-MM-DD' strings; parsing them into a local-time Date shifts the day.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString, max: 5 });
}
