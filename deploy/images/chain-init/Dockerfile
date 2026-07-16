# syntax=docker/dockerfile:1
# CKB dev chain + ckb-cli + udt-init (built from the vendored fiber source).
# One image drives chain init, contract deploy, node funding, and UDT setup —
# exactly what upstream fiber CI does on the host.
ARG RUST_IMAGE=rust:1.93.0-slim-bookworm
ARG CKB_VERSION=v0.202.0
ARG CKB_CLI_VERSION=v1.15.0

# Escape hatch: if UDT_INIT_BIN points at a local prebuilt binary (see
# deploy/README.md), pass --build-arg UDT_INIT_STAGE=udt-prebuilt so the
# final stage's COPY --from=${UDT_INIT_STAGE} pulls from udt-prebuilt
# instead of udt-builder — BuildKit only builds stages that are actually
# referenced, so the ~7min cargo compile is skipped entirely, not just
# cached. Left at its default (udt-builder), nothing here changes behavior.
ARG UDT_INIT_BIN=""
ARG UDT_INIT_STAGE=udt-builder

FROM ${RUST_IMAGE} AS udt-builder
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev clang cmake make g++ && rm -rf /var/lib/apt/lists/*
COPY vendor/fiber-0.9.0-rc7/tests/deploy/udt-init /build/udt-init
WORKDIR /build/udt-init
# Cache mounts persist across builds (keyed by target path, not by image
# layer) so only changed source recompiles — first build still pays the
# full cargo cost, every build after is a cache hit.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/udt-init/target \
    cargo build --release --locked && cp target/release/udt-init /udt-init

FROM scratch AS udt-prebuilt
ARG UDT_INIT_BIN
COPY ${UDT_INIT_BIN} /udt-init

# COPY --from doesn't support variable expansion directly (BuildKit
# limitation) — this indirection stage is the documented workaround: FROM
# can take a variable stage name, so this picks udt-builder or udt-prebuilt
# based on UDT_INIT_STAGE, and everything downstream copies from this fixed
# name instead.
FROM ${UDT_INIT_STAGE} AS udt-init-final

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
COPY --from=udt-init-final /udt-init /usr/local/bin/udt-init
# The vendored deploy.sh runs `cargo run --` inside tests/deploy/udt-init.
# Shim cargo to exec the prebuilt binary so vendored scripts stay unpatched.
RUN printf '#!/bin/sh\n# cargo shim: deploy.sh calls `cargo run -- [args]` for udt-init\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$1" = "--" ] && shift\nexec /usr/local/bin/udt-init "$@"\n' > /usr/local/bin/cargo && chmod +x /usr/local/bin/cargo
COPY scripts/chain-entrypoint.sh /usr/local/bin/chain-entrypoint.sh
RUN chmod +x /usr/local/bin/chain-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/chain-entrypoint.sh"]
