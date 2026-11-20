# A thread's sandbox: git, gh, node, pnpm, and ripgrep, baked into the image.
FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq python3 procps \
  && rm -rf /var/lib/apt/lists/*
# Pinned: asking GitHub for "latest" is rate-limited from shared hosts.
RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_amd64.tar.gz | tar xz -C /tmp \
  && install /tmp/gh_2.102.0_linux_amd64/bin/gh /usr/local/bin/gh && rm -rf /tmp/gh_*
RUN npm install -g pnpm@11 >/dev/null 2>&1 && mkdir -p /workspace
WORKDIR /workspace
# The agent runs its commands with exec; the container only has to stay up.
CMD ["sleep", "infinity"]
