# Workflows

## 1. stdio — Claude Code auto-launch

The simplest mode. Claude Code spawns the process on demand and communicates via stdin/stdout. No separate server process needed.

```bash
claude mcp add fsolar \
  -e FELICITY_USER=you@example.com \
  -e FELICITY_PASS=yourpassword \
  -- npx fsolar-mcp
```

**Verify it's working:**
```
> get_fleet_summary
```

Claude will call the tool and return live battery data. No further setup needed.

---

## 2. HTTP — persistent server (REST + SSE + /events)

Run the server as a long-lived process for dashboards, multi-client access, and webhook integrations.

### Step 1: create `.env`

```bash
cp .env.example .env
# edit .env with your credentials
```

Minimum required:
```
FELICITY_USER=you@example.com
FELICITY_PASS=yourpassword
```

### Step 2: start the server

```bash
npm run build
node dist/server.js
```

Or with Docker:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/server.js"]
```

### Step 3: connect Claude Code via SSE

```bash
claude mcp add fsolar --transport sse http://localhost:3010/sse
```

If you set `FELICITY_API_KEY`:
```bash
claude mcp add fsolar --transport sse http://localhost:3010/sse \
  -H "Authorization: Bearer your-key"
```

### Step 4: verify

```bash
curl http://localhost:3010/health
curl -H "Authorization: Bearer your-key" http://localhost:3010/batteries
```

---

## 3. Embedded library

Use inside another Node.js service (Next.js, Express, Home Assistant add-on, etc.).

```typescript
import { FelicityClient, createServer, startPoller } from 'fsolar-mcp';

const client = new FelicityClient({
  user: process.env.FELICITY_USER!,
  pass: process.env.FELICITY_PASS!,
});

const { httpServer, close, setPollError } = createServer(client, {
  port:     3010,
  apiKey:   process.env.FELICITY_API_KEY ?? null,
  rateLimit: 60,
});

startPoller(client, {
  onTick: ({ batteries, health }) => {
    console.log(`${batteries.length} batteries online`);
  },
  onError: setPollError,
});

httpServer.listen(3010, () => console.log('fsolar-mcp ready'));
```

---

## 4. Webhook setup

### Register a webhook

```bash
curl -X POST http://localhost:3010/hooks \
  -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.example.com/battery-events",
    "events": ["cell_delta_crit", "temp_crit", "low_soc"],
    "secret": "your-hmac-secret"
  }'
```

Omit `events` to receive all events. Omit `secret` to skip HMAC signing.

### Verify HMAC signature (Node.js receiver example)

```typescript
import crypto from 'crypto';

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

app.post('/battery-events', (req, res) => {
  const sig  = req.headers['x-hub-signature-256'] as string;
  const body = req.rawBody; // raw string, before JSON parse
  if (sig && !verifySignature(body, sig, 'your-hmac-secret')) {
    return res.status(401).send('invalid signature');
  }
  const event = req.body;
  console.log(event.event, event.alias, event.value);
  res.sendStatus(200);
});
```

### View delivery history

```bash
curl -H "Authorization: Bearer your-key" \
  http://localhost:3010/hooks/{hookId}/deliveries
```

### Remove a webhook

```bash
curl -X DELETE -H "Authorization: Bearer your-key" \
  http://localhost:3010/hooks/{hookId}
```

---

## 5. Behind a reverse proxy (nginx / Caddy)

When the server runs behind a proxy, set `FELICITY_TRUST_PROXY=1` so rate limiting uses the real client IP from `X-Forwarded-For` instead of the proxy address.

**Caddy example:**
```
reverse_proxy localhost:3010 {
  header_up X-Forwarded-For {remote_host}
}
```

**nginx example:**
```nginx
location / {
  proxy_pass         http://localhost:3010;
  proxy_set_header   X-Forwarded-For $remote_addr;
}
```

**`.env` setting:**
```
FELICITY_TRUST_PROXY=1
```

---

## 6. Upgrade guide

### Checking for breaking changes

Each release's breaking changes are noted in `CHANGELOG.md` under `### Breaking` or `### Security`.

### v1.0.30 — SSE auth enforcement (breaking)

`GET /sse` now requires authentication when `FELICITY_API_KEY` is set. If you connect via MCP over HTTP with a key, add the header to your MCP client config:

```bash
# Claude Code
claude mcp add fsolar --transport sse http://localhost:3010/sse \
  -H "Authorization: Bearer your-key"
```

### General upgrade steps

```bash
npm install fsolar-mcp@latest
npm run build
node dist/server.js
```

Check `CHANGELOG.md` for migration notes specific to your version jump.
