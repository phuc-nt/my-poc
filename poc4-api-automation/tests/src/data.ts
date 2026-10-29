// Test data that each test creates for itself, so runs never depend on or collide with each other.
import { randomInt } from 'node:crypto';

const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

/** A syntactically valid VIN that no real vehicle has: the PWT prefix marks it as test data. */
export function testVin(): string {
  let vin = 'PWT';
  while (vin.length < 17) vin += VIN_CHARS[randomInt(VIN_CHARS.length)];
  return vin;
}

export function pushToken(): string {
  return `pw-push-${Date.now().toString(36)}-${randomInt(1e9).toString(36)}`;
}

export const SEED = {
  pin: '246810',
  otherPin: '975318',
  /** auth0|seed-010..013 are created in March 2026 (sim/db/init.sql). */
  marchUsers: 4,
};
