# Deployment, Syncing & Incident Prevention Guide

This document defines the sync procedure, explains environmental boundaries between Local Dev and Cloud Production, and includes the postmortem from the September 9, 2026 login outage.

---

## 1. Golden Rules of Syncing

1. **NEVER sync `.env`:**
   - Local `.env` has `localhost` URLs or omitted URLs which default to `localhost:8000`.
   - Production cloud `.env` has the public IP/domain (`168.107.139.50`), cookie attributes (`COOKIE_SAMESITE=lax`, `COOKIE_SECURE=false`), and CORS origin allowlists.
   - Overwriting cloud `.env` breaks client network requests and authentication.
2. **NEVER use `rsync --delete` indiscriminately:**
   - The remote VM contains state, media files (`exports/*.mp4`, `exports/*.jpg`), and manual scripts (`scripts/record_animation.mjs`).
   - `--delete` will permanently wipe any server-side generated artifacts not present locally.
3. **Always use the safe sync script:**
   - `./scripts/sync-cloud.sh` has built-in exclusions for `.env`, `exports/`, `.git/`, and dev overrides.

---

## 2. Using `scripts/sync-cloud.sh`

The project root includes an automated, hardened deployment script:

### A. Preview Sync (Dry Run)
Inspect what files will be sent without making changes on the server:
```bash
./scripts/sync-cloud.sh --dry-run
```

### B. Sync & Rebuild Web + Worker
Syncs the code changes and automatically rebuilds Docker containers for the web frontend and worker:
```bash
./scripts/sync-cloud.sh --rebuild
```

### C. Sync Only (No Container Restart)
Syncs files without touching running containers:
```bash
./scripts/sync-cloud.sh
```

### D. Pull Remote Media Exports to Local Machine
Safely download any remote animations and videos without risk of deletion:
```bash
./scripts/sync-cloud.sh --pull-media
```

---

## 3. Remote Server `.env` Reference

The remote environment file at `/home/ubuntu/jumpais-app/.env` must contain:

```bash
# LLM & AI Keys
GOOGLE_CLOUD_API_KEY=AQ.Ab8RN6K9iVWTjlIWHYRBlI7decJoejC1Po_y3YXRO4OCRQeYUQ
OPENROUTER_API_KEY="sk-or-v1-..."

# Admin Email Allowlist
ADMIN_EMAILS=admin@test.com

# Remote Network Endpoints
PAGES_ORIGIN=http://168.107.139.50:8080
WEB_ORIGIN=http://168.107.139.50:5173,http://localhost:5173
VITE_API_URL=http://168.107.139.50:8000
VITE_PAGES_URL=http://168.107.139.50:8080

# Cookie & Session Config
COOKIE_SECURE=false
COOKIE_SAMESITE=lax

# Registration Switch
ALLOW_REGISTRATION=false
```

---

## 4. Postmortem: Student Login Outage (2026-09-09)

### Incident Summary
- **Symptom:** Users and students could not log in from the web UI (`/login`). Clicking "Sign in" resulted in connection failures.
- **Root Cause:** When running `rsync` from the local workspace to the cloud server, `.env` was not excluded. The local `.env` (which only contained API keys and registration toggle) overwrote the server's `.env`. 
  - Without `VITE_API_URL=http://168.107.139.50:8000` in the environment, the Vite frontend defaulted to `http://localhost:8000`.
  - When users loaded the website in their browsers and attempted to log in, their browsers sent login credentials to `http://localhost:8000/auth/login` (their own personal computers) rather than the server API.
  - Additionally, `WEB_ORIGIN` and `PAGES_ORIGIN` were stripped, breaking CORS checks for remote requests.
- **Data Impact:** **Zero data loss.** The PostgreSQL database and `app_user` accounts (`student@test.com`, `somchai@gmail.com`, `redbull@gmail.com`) remained intact.
- **Resolution:** Restored the cloud `.env` configuration with production VM endpoints, recreated the `web` and `api` Docker containers, and verified login functionality.
- **Prevention:**
  1. Created `scripts/sync-cloud.sh` with hardcoded exclusions for `.env`, `exports/`, `.git/`, and dev overrides.
  2. Synced remote scripts (`record_animation.mjs`) back to the local repository.
  3. Documented deployment and sync safeguards in `docs/SYNC-GUIDE.md`.
