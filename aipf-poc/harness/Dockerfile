# Harness image of the AIPF POC: the agent CLIs, the session runner, the MCP proxy for AWS and
# git with the CodeCommit helper. Each repository's environment snapshot is built on top of it.
# Build context: aipf-poc/.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq postgresql-client python3 ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

# MCP proxy for AWS (signs gateway calls with the task role) and git-remote-codecommit (git over IAM)
COPY --from=ghcr.io/astral-sh/uv:0.10.4 /uv /uvx /usr/local/bin/
ENV UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_PYTHON_PREFERENCE=only-system
RUN uv tool install mcp-proxy-for-aws==1.7.0 && uv tool install git-remote-codecommit==1.17

# The agent CLIs, unmodified, at fixed versions
RUN npm install -g @anthropic-ai/claude-code@2.1.296 opencode-ai@1.19.3 && npm cache clean --force

WORKDIR /opt/aipf
COPY harness/package.json harness/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY harness/runner ./runner
COPY registry ./registry

RUN useradd --create-home --uid 1001 agent && mkdir /workspace && chown agent /workspace
USER agent
ENV DISABLE_AUTOUPDATER=1
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/aipf/runner/session.mjs"]
CMD ["run"]
