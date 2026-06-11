# No headless browser → a plain slim Node image is enough (small, fast cold starts).
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
# Same image serves both Cloud Run services; the start command selects the role:
#   API:    node dist/api/main.js
#   Worker: node dist/worker/main.js
CMD ["node", "dist/api/main.js"]
