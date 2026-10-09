# Official browser/system dependency image; package version matches this image.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node22
FROM postgrest/postgrest:v14.5@sha256:b574528fe109c8343c1247155734d03df8c34b462f342dca0ccc20244fc36ef9 AS rest
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
COPY --from=node22 /usr/local/bin/ /usr/local/bin/
COPY --from=node22 /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=rest /bin/postgrest /usr/local/bin/postgrest
ENV PATH="/usr/local/bin:/usr/lib/postgresql/16/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-16 postgresql-client-16 python3 git curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.19.0
WORKDIR /opt/ara-ci
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# No source, credential, environment file, or customer data is baked into the image.
