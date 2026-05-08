# Deploying KochHeute API to a VM

This guide walks you through getting the KochHeute backend running on
your existing Ubuntu 22.04 VM (the same one that hosts `resumely`).

## What you need

- An Ubuntu 22.04 VM with Docker + docker-compose already installed
  (you set this up for resumely)
- SSH access to the VM
- A domain or subdomain (e.g., `kochheute-api.canigom.de`) with DNS
  pointing at the VM's IP
- An Anthropic API key (for `/api/analyze`)

## 1. Prepare the VM (skip if Docker is already installed)

```bash
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
docker --version && docker compose version
```

## 2. Get the code onto the VM

### Option A — Push to GitHub, then clone

On your **laptop**:

```bash
cd /c/Users/Dell/Desktop/kochheute-api
git init && git add -A && git commit -m "initial deploy"
# create the repo on GitHub, then:
git remote add origin git@github.com:<you>/kochheute-api.git
git push -u origin main
```

On the **VM**:

```bash
git clone git@github.com:<you>/kochheute-api.git
cd kochheute-api
```

### Option B — rsync directly

From your **laptop** (Git Bash or WSL):

```bash
rsync -avz --exclude node_modules --exclude .next \
  /c/Users/Dell/Desktop/kochheute-api/ user@VM_IP:/home/user/kochheute-api/
```

Then SSH in and `cd kochheute-api`.

## 3. Configure secrets

On the VM:

```bash
cp .env.example .env.production

# Generate the session-signing secret
sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=\"$(openssl rand -base64 32)\"|" .env.production

# Pick a strong DB password
sed -i "s|CHANGEME|$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)|g" .env.production

# Add your Anthropic API key
nano .env.production
```

Verify the file:
- `AUTH_SECRET` — non-empty, 32+ random bytes
- `POSTGRES_PASSWORD` — non-default
- `DATABASE_URL` — references the SAME password as POSTGRES_PASSWORD
- `ANTHROPIC_API_KEY` — set (otherwise `/api/analyze` 500s)
- `AUTH_URL` — your public domain, e.g. `https://kochheute-api.canigom.de`

## 4. Build & run

```bash
docker compose --env-file .env.production up -d --build
```

First build is ~3-5 minutes. The entrypoint runs `prisma migrate deploy`
automatically on every container start, so the DB is ready as soon as the
healthcheck flips green.

If you ever need to apply migrations manually (debugging, fresh DB, etc.):

```bash
docker compose --env-file .env.production exec app \
  node ./node_modules/prisma/build/index.js migrate deploy
```

Verify it's healthy:

```bash
curl http://localhost:3001/api/health
# {"ok":true,"timestamp":"..."}
```

## 5. nginx reverse proxy + Let's Encrypt SSL

Add a new nginx vhost alongside the resumely one. Create
`/etc/nginx/sites-available/kochheute-api`:

```nginx
server {
    listen 80;
    server_name kochheute-api.canigom.de;

    # Vision uploads carry base64-encoded JPEGs — bump body size from the
    # nginx default of 1 MB so they don't get rejected at the edge.
    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Claude vision calls can take 20-30s; raise read timeouts so
        # nginx doesn't 504 before the model finishes.
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
```

Enable + reload:

```bash
sudo ln -s /etc/nginx/sites-available/kochheute-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Issue an SSL cert:

```bash
sudo certbot --nginx -d kochheute-api.canigom.de
# Pick "redirect HTTP to HTTPS" when asked.
```

Verify: `https://kochheute-api.canigom.de/api/health` should return
`{"ok":true,...}`.

## 6. Firewall (probably already done for resumely)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Port 3001 stays internal — only nginx proxies to it.

## Operations cheat sheet

```bash
# Live logs
docker compose --env-file .env.production logs -f app

# Restart after env changes
docker compose --env-file .env.production restart

# Update after pushing new code
git pull
docker compose --env-file .env.production up -d --build

# Apply migrations explicitly
docker compose --env-file .env.production exec app \
  node ./node_modules/prisma/build/index.js migrate deploy

# psql shell
docker compose --env-file .env.production exec db \
  psql -U kochheute -d kochheute

# Back up the DB
docker compose --env-file .env.production exec -T db \
  pg_dump -U kochheute kochheute > backup-$(date +%F).sql

# Restore
cat backup-2026-05-05.sql | docker compose --env-file .env.production \
  exec -T db psql -U kochheute -d kochheute

# Open a shell inside the running container (debugging)
docker compose --env-file .env.production exec app sh
```

## When things go wrong

- **`docker compose up` fails during build with "out of memory"**: add a
  swap file (see resumely's DEPLOY.md step 1 for the snippet).
- **App boots but `/api/health` returns 502 from nginx**: container probably
  crashed. Run `docker compose --env-file .env.production logs app`.
  Common cause: missing `AUTH_SECRET` or unreachable `db` service.
- **`/api/analyze` returns 500 "ANTHROPIC_API_KEY is not set"**: you forgot
  to fill in `.env.production`. Edit and `docker compose restart app`.
- **NextAuth complains about `UntrustedHost`**: `AUTH_TRUST_HOST` must be
  `true` (already hardcoded in the Dockerfile, but if you override it in
  `.env.production`, keep it `true`).
- **Port 3001 already taken**: `sudo lsof -i :3001`. Pick a different
  port in `docker-compose.yml` and the matching `proxy_pass` in nginx.
- **Migrations fail on first boot**: usually a stale volume. For a fresh
  deploy: `docker compose --env-file .env.production down -v` (wipes the
  named volume + DB) then `up -d --build`.
