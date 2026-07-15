# syntax=docker/dockerfile:1
# Multi-stage build of the TeamClaw daemon (amuxd) for the self-host stack.
# Build context MUST be the repo root (needs the Cargo workspace: crates/ +
# apps/daemon + Cargo.lock).
FROM rust:1-bookworm AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev cmake clang protobuf-compiler && rm -rf /var/lib/apt/lists/*
COPY . .
ENV CARGO_TARGET_DIR=/out
RUN cargo build --release -p amuxd --bin amuxd

FROM debian:bookworm-slim AS runtime
# ca-certificates: TLS to cloud API / LLM provider. curl: fetch opencode.
# git: team-shared-git sync.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git && rm -rf /var/lib/apt/lists/*

# opencode — the ACP agent the daemon spawns to actually run sessions.
# Standalone release binary (no node needed), fetched straight from the GitHub
# release tarball (glibc build). Override version with --build-arg OPENCODE_VERSION=.
ARG OPENCODE_VERSION=1.17.9
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) oc=x64 ;; arm64) oc=arm64 ;; *) echo "unsupported arch: $arch" >&2; exit 1 ;; esac; \
    curl -fsSL "https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${oc}.tar.gz" -o /tmp/oc.tgz; \
    tar -xzf /tmp/oc.tgz -C /usr/local/bin; \
    rm /tmp/oc.tgz; \
    chmod +x /usr/local/bin/opencode; \
    /usr/local/bin/opencode --version

COPY --from=build /out/release/amuxd /usr/local/bin/amuxd
# Daemon state (backend.toml / daemon.toml) lives under $HOME/.amuxd.
# /state is a named volume so identity persists across restarts.
ENV HOME=/state
WORKDIR /state
# entrypoint.sh is mounted by docker-compose (the repo-root .dockerignore
# excludes deploy/, so it cannot be COPY'd into the build context). The compose
# service overrides entrypoint to: ["/bin/sh", "/entrypoint.sh"].
CMD ["amuxd", "start"]
