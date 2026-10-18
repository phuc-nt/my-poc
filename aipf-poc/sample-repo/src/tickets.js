import { HttpError } from './http.js';

export function validateTicketInput(body) {
  const serial = typeof body.serial === 'string' ? body.serial.trim() : '';
  const issue = typeof body.issue === 'string' ? body.issue.trim() : '';
  if (!serial) throw new HttpError(400, 'invalid_input', 'serial is required');
  if (!issue) throw new HttpError(400, 'invalid_input', 'issue is required');
  return { serial, issue };
}

export function formatTicketNo(id) {
  return `T-${id}`;
}

export async function createTicket(db, input) {
  const { serial, issue } = validateTicketInput(input);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "INSERT INTO tickets (ticket_no, serial, issue) VALUES ('pending-' || gen_random_uuid(), $1, $2) RETURNING id",
      [serial, issue],
    );
    const id = rows[0].id;
    const ticketNo = formatTicketNo(id);
    const result = await client.query(
      'UPDATE tickets SET ticket_no = $1 WHERE id = $2 RETURNING id, ticket_no, serial, issue, status, created_at',
      [ticketNo, id],
    );
    await client.query('COMMIT');
    return toTicket(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getTicket(db, id) {
  const { rows } = await db.query('SELECT id, ticket_no, serial, issue, status, created_at FROM tickets WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'not_found', `Ticket ${id} not found`);
  return toTicket(rows[0]);
}

function toTicket(row) {
  return {
    id: row.id,
    ticketNo: row.ticket_no,
    serial: row.serial,
    issue: row.issue,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}
