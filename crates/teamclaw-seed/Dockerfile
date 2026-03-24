# ── Build stage ──────────────────────────────────────────────────────────────
FROM rust:1.82-slim AS builder

WORKDIR /app
COPY . .

RUN cargo build --release -p teamclaw-seed

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/teamclaw-seed /usr/local/bin/teamclaw-seed

VOLUME ["/data"]
EXPOSE 9090

ENV SEED_API_KEY=""

ENTRYPOINT ["teamclaw-seed"]
CMD ["--data-dir", "/data", "--port", "9090"]
