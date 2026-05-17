FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache dumb-init
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist dist/
COPY src/db/migrations dist/db/migrations/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000
USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["./entrypoint.sh"]
