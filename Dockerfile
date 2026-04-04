FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    cp -r node_modules /prod_modules && \
    npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc

# ─── Runtime ───

FROM node:22-slim

WORKDIR /app

COPY --from=builder /prod_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production

EXPOSE 3901

CMD ["node", "dist/index.js", "serve"]
