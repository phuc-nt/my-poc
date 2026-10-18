# AGENTS.md

Instructions for coding agents working on this repository. People should read [README.md](README.md) first.

## What this is

The service desk API of Moc Lan Home, a fictional seller of smart-home devices. It keeps the product catalogue, the devices customers registered (by serial number) and the service tickets opened for them. Node.js 22, plain `node:http`, PostgreSQL through `pg`. No framework.

Business rules (warranty periods, ticket number formats, fees, error codes, return rules) are **not** in this repository. They are in the company knowledge base (Confluence and SharePoint). Look them up there; never invent a business rule or a number.

## Commands

All commands run from the repository root and need `DATABASE_URL` (already set in the agent sandbox).

| Purpose | Command |
|---|---|
| Install | `npm ci` |
| Create or update the schema | `npm run db:migrate` |
| Load sample data | `npm run db:seed` |
| Lint | `npm run lint` |
| Unit tests (no database) | `npm run test:unit` |
| Integration tests (database) | `npm run test:integration` |
| Start the API on port 3000 | `npm start` |

A change is verified when `npm run lint`, `npm run test:unit` and `npm run test:integration` all pass. CI runs exactly these.

## Structure

- `src/app.js`: routes. Each route returns `{ status, body }` or throws `HttpError`.
- `src/http.js`: JSON helpers and `HttpError`.
- `src/tickets.js`: ticket logic and validation.
- `migrations/NNN_name.sql`: schema changes, applied once each, in order.
- `scripts/`: migrate, seed, lint.
- `test/unit/`: tests without a database. `test/integration/`: tests against the API and the database.

## Conventions

- ES modules, two-space indent, single quotes, semicolons.
- JSON fields in responses are camelCase; database columns are snake_case.
- Errors are `{ "error": { "code": "snake_case_code", "message": "..." } }` with the right HTTP status. Never let a database error reach the client as a 500 when the input was wrong.
- Money is an integer number of Vietnamese dong (`*_vnd` columns, `*Vnd` fields). No decimals.
- Dates are `YYYY-MM-DD`; timestamps are ISO 8601 in UTC.
- Every behaviour change comes with a test: unit tests for logic, integration tests for routes.
- Do not add dependencies unless the work item needs one; say why in the pull request.

## Do not

- Edit a migration that already exists. Add a new numbered file instead.
- Commit secrets, real customer data or production settings. This repository has no production configuration and must not get one.
- Change CI (`buildspec.yml`) or `.aipf/` unless the work item asks for it.

## Pull requests

- Title: `<work item key>: <what changed>`.
- Description: what changed and why; how it was verified (the commands and their result); a **Knowledge used** section listing each knowledge base passage you relied on, with its source title; open questions or risks.
