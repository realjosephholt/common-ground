# syntax=docker/dockerfile:1

FROM node:20-alpine

WORKDIR /app

# Dependencies first, so a source change does not re-resolve the tree.
COPY package.json package-lock.json ./
# `npm ci` rather than `npm install`: an Instance should build the tree that was tested,
# not whatever the registry resolved to today. Dev dependencies are included because M0
# runs TypeScript directly through vite-node — there is no server to compile yet, and a
# build step will land with the milestone that adds one.
RUN npm ci

COPY tsconfig.json vitest.config.ts drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY data ./data

ENV NODE_ENV=production

# Applies migrations, seeds Regions from the vendored extract, then keeps the archival
# sweep running.
CMD ["npm", "run", "instance:start"]
