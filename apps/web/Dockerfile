# Dev-mode container: docker-compose expects Vite's own dev server reachable
# on 5173 (HMR included), not a built-and-served bundle. If this ever needs a
# production image, add a second `nginx`-serving stage rather than changing
# this one out from under compose.
#
# Build context is the repo root (see docker-compose.yml `build.context: .`),
# not this directory, so paths below are rooted at `apps/web/`.
FROM node:20-alpine

WORKDIR /app

COPY apps/web/package.json apps/web/package-lock.json* ./
RUN npm install

COPY apps/web/ .

EXPOSE 5173

CMD ["npm", "run", "dev"]
