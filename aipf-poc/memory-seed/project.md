# mlh-service-desk: project memory

Notes the team keeps for people and agents. They add to `AGENTS.md`; they do not replace it. Agents may propose changes with `memory___propose`; a person reviews each proposal.

## Facts learned the hard way

- Sample serial numbers are short test values (`C5-0001`). Real serial numbers have another format, described in the knowledge base. Do not validate the serial format in code unless a work item asks for it, or the seeded data stops working.
- The integration tests truncate `tickets` before they run, and share one database. A test must not depend on rows another test created, apart from the seeded products and devices.
- `purchase_date` is a `DATE`. The `pg` driver turns it into a JavaScript `Date` at local midnight; use the `toDate` helper in `src/app.js` to format it, never `toISOString()`, or the date shifts by a day.
- Reference data copied from the knowledge base (prices, warranty periods, fees, error codes) goes into a new migration as rows, with the source page or file named in a SQL comment. Do not hard-code it in JavaScript.

## Decisions

- 2026-10-01: errors keep the `{ "error": { "code", "message" } }` shape for every route, including 404 for unknown routes. Clients rely on `code`, not on `message`.
- 2026-10-01: no ORM and no web framework. Plain `node:http` and `pg` are enough for this service.
- 2026-10-08: amounts are integers in Vietnamese dong. A fee or price with decimals is a bug.

## People

- Service desk product owner: decides business rules that the knowledge base does not cover. Ask through `slack___ask_human`.
