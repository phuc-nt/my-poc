CREATE TABLE products (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  price_vnd INTEGER NOT NULL CHECK (price_vnd >= 0)
);

CREATE TABLE devices (
  serial TEXT PRIMARY KEY,
  product_code TEXT NOT NULL REFERENCES products (code),
  purchase_date DATE NOT NULL,
  owner_phone TEXT NOT NULL
);

CREATE TABLE tickets (
  id SERIAL PRIMARY KEY,
  ticket_no TEXT NOT NULL UNIQUE,
  serial TEXT NOT NULL REFERENCES devices (serial),
  issue TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
