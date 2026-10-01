# VANTA — Express site + admin. SQLite and uploads live on a volume at /app/data.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY site ./site
COPY scripts ./scripts

RUN addgroup -g 1001 -S vanta && adduser -S -u 1001 -G vanta vanta
USER vanta

EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
