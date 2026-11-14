# SkyShift: builds the viewer (TypeScript + Rust/WebAssembly) and serves it with
# the archive search, catalogue, identification and quality routes on port 8080.
#   podman build -t skyshift . && podman run -p 8080:8080 skyshift
FROM docker.io/library/node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown \
 && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM docker.io/library/node:22-bookworm-slim
# Astropy is only needed by the optional FLAGS inspector (/api/quality).
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-astropy \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY config ./config
COPY package.json ./
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "scripts/serve.mjs"]
