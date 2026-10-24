# Field Desk — two stages, explicit copies only (nothing from the build context is copied wholesale,
# so local files such as .env.local can't end up in a layer even if .dockerignore missed them).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN npm run build

FROM node:24-alpine
WORKDIR /app
# The server has no runtime dependencies beyond Node itself: the built app, the server, and the
# shared src/lib modules it imports (transitively — tests/server-docker.test.ts keeps this list honest).
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/lib/ops.ts /app/src/lib/phone.ts /app/src/lib/schema.ts /app/src/lib/recce.ts /app/src/lib/commands.ts /app/src/lib/command-types.ts /app/src/lib/tournament.ts /app/src/lib/bracket.ts /app/src/lib/submission.ts /app/src/lib/teams.ts /app/src/lib/toornament.ts /app/src/lib/toornament-auto.ts /app/src/lib/onspot.ts /app/src/lib/util.ts /app/src/lib/winnerInput.ts /app/src/lib/steam.ts /app/src/lib/weekends.ts ./src/lib/
# Mount a persistent volume at /data — it holds the database and every proof photo.
# One container per volume: the server takes a lock on /data/.lock.
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data DIST_DIR=/app/dist
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.ts"]
