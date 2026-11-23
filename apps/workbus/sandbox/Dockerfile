# A seat's sandbox (design/workbus.md §5.4): a Linux container per session, started by the Session
# Durable Object (src/harness/sandbox.ts). Node, npm, git, and curl; the shim @cloudflare/sandbox's Files
# runs, from the donor image, whose tag stays equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# HTTPS leaves only through the egress (interceptOutboundHttps), re-signed with the Containers CA.
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
