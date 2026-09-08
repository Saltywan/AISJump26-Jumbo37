# Oracle Cloud Deployment & Setup Guide (JumpAIS)

This guide documents the end-to-end setup process for deploying the JumpAIS docker-compose stack onto a fresh Oracle Cloud Infrastructure (OCI) Ubuntu instance.

---

## 1. Prerequisites & Initial SSH Access

When creating an Oracle Cloud instance, an SSH key pair is generated or provided.

1. **Secure your private key permissions locally:**
   ```bash
   chmod 600 ~/.ssh/ais_alloy
   ```
2. **Connect to the instance:**
   ```bash
   ssh -i ~/.ssh/ais_alloy ubuntu@<PUBLIC_IP>
   ```
   *(Note: Oracle Cloud Ubuntu images use `ubuntu` as the default username. Oracle Linux images use `opc`.)*

---

## 2. Install Docker & Docker Compose

Run the official Docker convenience script and add the `ubuntu` user to the `docker` group so `sudo` is not required for running containers:

```bash
# 1. Download and run Docker installation script
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# 2. Add your user to the docker group
sudo usermod -aG docker $USER

# 3. Apply group changes to current shell
newgrp docker

# 4. Verify installation
docker --version
docker compose version
```

---

## 3. Host Firewall Configuration (The Oracle Cloud Gotcha)

Oracle Cloud Ubuntu images ship with preconfigured `iptables` rules that drop all incoming traffic except port 22 (`-A INPUT -j REJECT --reject-with icmp-host-prohibited`). Even if you allow ports in the Oracle Cloud Console, the VM itself will reject the connection unless you update its internal firewall.

To allow web traffic to the containers:

```bash
# Insert ACCEPT rules before the REJECT rule for our ports:
# 5173 = Web App, 8000 = FastAPI Backend, 8080 = Static Pages (Nginx)
sudo iptables -I INPUT 5 -p tcp -m state --state NEW -m tcp --dport 5173 -j ACCEPT
sudo iptables -I INPUT 6 -p tcp -m state --state NEW -m tcp --dport 8000 -j ACCEPT
sudo iptables -I INPUT 7 -p tcp -m state --state NEW -m tcp --dport 8080 -j ACCEPT

# Save the rules so they persist across reboots
sudo netfilter-persistent save
```

---

## 4. Oracle Cloud VCN Security Rules (Cloud Layer)

Oracle Cloud blocks non-SSH traffic at the Virtual Cloud Network (VCN) hypervisor layer.

In the **Oracle Cloud Console**:
1. Navigate to **Networking** > **Virtual Cloud Networks (VCN)**.
2. Select your VCN and click **Security Lists** (or the Default Security List).
3. Click **Add Ingress Rules**:
   - **Stateless:** Unchecked
   - **Source Type:** CIDR
   - **Source CIDR:** `0.0.0.0/0`
   - **IP Protocol:** TCP
   - **Source Port Range:** All (leave blank)
   - **Destination Port Range:** `5173,8000,8080` (or `5173-8080`)
   - **Description:** `Allow JumpAIS Web, API, and Pages`

---

## 5. Codebase Adjustments for Remote Deployment

When moving from local development (`localhost`) to a remote IP/domain:

### A. Environment Configuration in `docker-compose.yml`
In `docker-compose.yml`, environment variables were updated with fallback defaults so local development continues working without changes while allowing remote IP overrides:

```yaml
services:
  api:
    environment:
      PAGES_ORIGIN: ${PAGES_ORIGIN:-http://localhost:8080}
      WEB_ORIGIN: ${WEB_ORIGIN:-http://localhost:5173}

  web:
    environment:
      VITE_API_URL: ${VITE_API_URL:-http://localhost:8000}
      VITE_PAGES_URL: ${VITE_PAGES_URL:-http://localhost:8080}
```

### B. Architecture Fix for Web Container (`apps/web/Dockerfile`)
When building the Node Alpine image on x86_64 Linux with a lockfile created on macOS (Apple Silicon / ARM64), Rollup's optional native binary fails to resolve. The Dockerfile was updated to install platform-specific musl packages:

```dockerfile
COPY apps/web/package.json apps/web/package-lock.json* ./
RUN npm install
RUN npm install --no-save @rollup/rollup-linux-x64-musl || true
RUN npm install --no-save @rollup/rollup-linux-arm64-musl || true
```

---

## 6. Transfer Files & Configure Remote Environment

From your **local machine**, sync the project directory to the server:

```bash
rsync -avz -e "ssh -i ~/.ssh/ais_alloy" \
  --exclude '.git' \
  --exclude '.venv' \
  --exclude 'node_modules' \
  --exclude '__pycache__' \
  --exclude '.DS_Store' \
  --exclude 'docker-compose.override.yml' \
  /Users/saltywan/Dev/jumpais-app/ ubuntu@<PUBLIC_IP>:~/jumpais-app/
```

`docker-compose.override.yml` holds dev-only extras (`--reload`, live source
mounts) that Compose reads automatically with no flags — excluding it from
the sync is what makes `docker-compose.yml` prod-shaped on the server by
default, rather than something you have to remember a flag for on every
`docker compose` command typed over SSH. If it were rsynced, the server
would silently run the dev config: `--reload` reloading uvicorn mid-request
on every future sync, killing any open SSE stream or in-flight tutor
question at that exact moment.

On the **remote server**, ensure `~/jumpais-app/.env` contains your production URLs:

```bash
GOOGLE_CLOUD_API_KEY=<YOUR_KEY>
ADMIN_EMAILS=admin@test.com
PAGES_ORIGIN=http://<PUBLIC_IP>:8080
WEB_ORIGIN=http://<PUBLIC_IP>:5173,http://localhost:5173
VITE_API_URL=http://<PUBLIC_IP>:8000
VITE_PAGES_URL=http://<PUBLIC_IP>:8080
COOKIE_SECURE=false
COOKIE_SAMESITE=lax
```

---

## 7. Launching the Services

On the **remote server**:

```bash
cd ~/jumpais-app

# Build and start all backend profile services in detached mode
docker compose --profile backend up -d --build

# Check status of containers
docker compose ps
```

The stack includes:
- **`web`** (`http://<PUBLIC_IP>:5173`): Vite/React frontend
- **`api`** (`http://<PUBLIC_IP>:8000`): FastAPI backend (Docs at `/docs`)
- **`pages`** (`http://<PUBLIC_IP>:8080`): Nginx serving approved/draft generated pages
- **`db`** (`5432`): PostgreSQL 16
- **`worker`**: Background queue worker for problem/page generation
- **`seed`**: Runs once to populate initial demo chapters and admin account

---

## 8. Data Migration (Copying User Questions & Drafts)

To migrate personal questions created in a local environment:

1. **Export SQL from local Postgres:**
   ```bash
   docker exec <LOCAL_DB_CONTAINER> psql -U jumpais -d jumpais -t -A \
     -c "SELECT json_agg(p) FROM (SELECT * FROM problem WHERE owner_id = '<LOCAL_USER_ID>') p;"
   ```
2. **Import into remote Postgres with updated `owner_id`:**
   Insert rows into `problem`, `page`, and `job` pointing to the remote user's ID.
3. **Transfer generated HTML files in `/storage`:**
   Copy files from local `/storage` to remote `/storage`:
   ```bash
   # Extract from local container
   docker cp <LOCAL_API_CONTAINER>:/storage/. /tmp/storage_export/

   # Copy to remote server
   rsync -avz -e "ssh -i ~/.ssh/ais_alloy" /tmp/storage_export/ ubuntu@<PUBLIC_IP>:~/storage_import/

   # Copy into remote container volume
   ssh -i ~/.ssh/ais_alloy ubuntu@<PUBLIC_IP> "docker cp ~/storage_import/. jumpais-app-api-1:/storage/"
   ```
