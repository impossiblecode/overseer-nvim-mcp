# Glama's release scan image (smoke.sh runs the same check locally), not an
# install method.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim
# OVERSEER_REF matches ci.yml
ARG NVIM_VERSION=v0.12.4
ARG OVERSEER_REF=v2.1.0
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
    amd64) NVIM_ARCH=x86_64 ;; \
    arm64) NVIM_ARCH=arm64 ;; \
    *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/nvim-linux-${NVIM_ARCH}.tar.gz" \
    | tar -xz -C /opt \
  && ln -s "/opt/nvim-linux-${NVIM_ARCH}/bin/nvim" /usr/local/bin/nvim \
  && nvim --version

RUN curl -fsSL "https://github.com/stevearc/overseer.nvim/archive/refs/tags/${OVERSEER_REF}.tar.gz" \
    | tar -xz -C /opt \
  && mv /opt/overseer.nvim-* /opt/overseer.nvim

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY ci/minimal_init.lua ./ci/minimal_init.lua
COPY ci/glama/entrypoint.sh /usr/local/bin/overseer-mcp-entrypoint
RUN chmod +x /usr/local/bin/overseer-mcp-entrypoint

ENV OVERSEER_PATH=/opt/overseer.nvim
ENTRYPOINT ["overseer-mcp-entrypoint"]
CMD ["node", "/app/dist/overseer-nvim-mcp.mjs"]
