FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ARG NODES_URL=https://github.com/DurtyFree/gta-v-data-dumps/raw/master/nodes.zip
RUN node --input-type=module -e "import{writeFileSync}from'node:fs';const r=await fetch(process.argv[1]);if(!r.ok)throw new Error('fetch failed: '+r.status);writeFileSync('nodes.zip',Buffer.from(await r.arrayBuffer()));" "$NODES_URL" \
  && mkdir -p data \
  && npm run build:graph -- nodes.zip data/graph.bin \
  && npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV GRAPH_PATH=/app/data/graph.bin

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data/graph.bin ./data/graph.bin

EXPOSE 3000

CMD ["node", "dist/index.js"]
