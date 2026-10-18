# mlh-service-desk

Service desk API of Moc Lan Home, a fictional seller of smart-home devices: product catalogue, registered devices and service tickets. All data is synthetic.

It is the sample repository of the AIPF proof of concept, at level 3 of the AI-ready repository standard: one command each to set up, migrate, seed, lint and test, with the database in a container.

## Run it

```sh
docker run -d --name mlh-db -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=app -p 5432:5432 postgres:16-alpine
export DATABASE_URL=postgres://postgres:dev@localhost:5432/app
npm ci
npm run db:migrate && npm run db:seed
npm run lint && npm test
npm start            # http://localhost:3000/products
```

## API

| Route | Does |
|---|---|
| `GET /health` | Liveness |
| `GET /products` | The product catalogue |
| `GET /devices/:serial` | A registered device and its product |
| `POST /tickets` | Open a service ticket: `{ "serial": "...", "issue": "..." }` |
| `GET /tickets/:id` | A ticket |

Agents: read [AGENTS.md](AGENTS.md). The environment is described in [.aipf/environment.yaml](.aipf/environment.yaml).
