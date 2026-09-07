# Runs scripts/seed-samples.mjs once, from inside the compose network, so that
# `docker compose --profile backend up` on a clean machine produces a system
# with content in it. Before this, a first run left the library empty, which
# is indistinguishable from a broken install if you have never seen the app.
#
# Self-contained (COPY, not a mount) because the point of it is to work from a
# freshly unzipped copy of this repo on someone else's laptop.
FROM node:20-alpine

# The seeder writes Problem and Page rows with SQL — there is no HTTP endpoint
# that creates a page without queueing a real model run. See the script's
# "THE THREE HARD PARTS" comment.
RUN apk add --no-cache postgresql-client

WORKDIR /repo
COPY scripts/seed-samples.mjs ./scripts/seed-samples.mjs
COPY apps/pages/static/checks.json ./apps/pages/static/checks.json
COPY apps/pages/static/pages ./apps/pages/static/pages
COPY packages/kit/VERSION ./packages/kit/VERSION

CMD ["node", "scripts/seed-samples.mjs"]
