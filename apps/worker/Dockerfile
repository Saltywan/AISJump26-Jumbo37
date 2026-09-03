# The worker runs both halves of the kit: generate.py (Python) writes the page,
# check.mjs (Node + Playwright, driving a real browser) measures it. So the image
# needs both, and a browser.
#
# Base is the Playwright image because the browser and its system libraries are
# the awkward part; Python is the easy thing to add.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    KIT_DIR=/opt/kit \
    STORAGE_DIR=/storage

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# generate.py declares its dependencies inline (PEP 723) for `uv run`. Inside a
# container there is no reason to resolve them at run time, so install them once
# here and invoke it with plain python3.
RUN pip3 install --no-cache-dir \
      google-genai requests \
      fastapi "uvicorn[standard]" sqlalchemy psycopg[binary]

# check.mjs does `import { chromium } from 'playwright'`. The vendored kit has
# no node_modules on purpose (kit/sync-to-app.sh excludes it), and /kit is
# mounted read-only, so the package is installed here and the kit is copied to a
# writable place at start-up with a node_modules beside it — ESM resolution
# walks up from checks/check.mjs and finds it.
RUN npm install --no-save playwright@1.49.0

COPY apps/api/app /app/app
COPY apps/worker/worker.py /app/worker.py
COPY apps/worker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
