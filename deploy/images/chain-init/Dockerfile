# CKB dev chain + ckb-cli + udt-init (built from the vendored fiber source).
# One image drives chain init, contract deploy, node funding, and UDT setup —
# exactly what upstream fiber CI does on the host.
ARG RUST_IMAGE=rust:1.93.0-slim-bookworm
ARG CKB_VERSION=v0.202.0
ARG CKB_CLI_VERSION=v1.15.0

FROM ${RUST_IMAGE} AS udt-builder
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev clang cmake make g++ && rm -rf /var/lib/apt/lists/*
COPY vendor/fiber-0.9.0-rc7/tests/deploy/udt-init /build/udt-init
WORKDIR /build/udt-init
RUN cargo build --release --locked && cp target/release/udt-init /udt-init

FROM ubuntu:24.04
ARG CKB_VERSION
ARG CKB_CLI_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates jq netcat-openbsd procps xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/nervosnetwork/ckb/releases/download/${CKB_VERSION}/ckb_${CKB_VERSION}_x86_64-unknown-linux-gnu-portable.tar.gz" \
      | tar xz -C /usr/local/bin --strip-components=1 --wildcards '*/ckb' \
 && curl -fsSL "https://github.com/nervosnetwork/ckb-cli/releases/download/${CKB_CLI_VERSION}/ckb-cli_${CKB_CLI_VERSION}_x86_64-unknown-linux-gnu.tar.gz" \
      | tar xz -C /usr/local/bin --strip-components=1 --wildcards '*/ckb-cli' \
 && ckb --version && ckb-cli --version
COPY --from=udt-builder /udt-init /usr/local/bin/udt-init
# The vendored deploy.sh runs `cargo run --` inside tests/deploy/udt-init.
# Shim cargo to exec the prebuilt binary so vendored scripts stay unpatched.
RUN printf '#!/bin/sh\n# cargo shim: deploy.sh calls `cargo run -- [args]` for udt-init\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$1" = "--" ] && shift\nexec /usr/local/bin/udt-init "$@"\n' > /usr/local/bin/cargo && chmod +x /usr/local/bin/cargo
COPY scripts/chain-entrypoint.sh /usr/local/bin/chain-entrypoint.sh
RUN chmod +x /usr/local/bin/chain-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/chain-entrypoint.sh"]
