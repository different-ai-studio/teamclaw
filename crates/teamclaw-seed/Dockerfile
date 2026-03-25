# ── Build stage ──────────────────────────────────────────────────────────────
FROM rust:1.89-slim AS builder

WORKDIR /app

COPY . .

# 配置国内 Cargo 镜像（rsproxy.cn）
RUN cp .cargo/config.toml /usr/local/cargo/config.toml

RUN cargo build --release -j 1

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/teamclaw-seed /usr/local/bin/teamclaw-seed

VOLUME ["/data"]
EXPOSE 9090

ENV SEED_API_KEY=""

ENTRYPOINT ["teamclaw-seed"]
CMD ["--data-dir", "/data", "--port", "9090"]
