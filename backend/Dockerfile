# Contender backend (FastAPI). No Chromium here — rendering lives in the frontend service.
# Base + tool images are pinned immutably (version tag AND digest) — a bare version tag still
# floats. Dependabot's docker ecosystem owns the bumps (.github/dependabot.yml).
FROM python:3.14-slim@sha256:cea0e6040540fb2b965b6e7fb5ffa00871e632eef63719f0ea54bca189ce14a6 AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install uv for fast, reproducible dependency resolution (pinned: version tag + digest).
COPY --from=ghcr.io/astral-sh/uv:0.11.31@sha256:ecd4de2f060c64bea0ff8ecb182ddf46ba3fcccdc8a60cfdbaf20d1a047d7437 /uv /uvx /bin/

COPY pyproject.toml uv.lock ./
# Install the EXACT locked runtime deps (no dev) — reproducible and identical to CI. `--frozen`
# fails loudly if the lock is stale rather than silently resolving a different version.
RUN uv sync --frozen --no-dev --no-install-project
# `uv sync` installs into /app/.venv but does not activate it; put its bin on PATH so the `uvicorn`
# in CMD resolves (otherwise the container exits with "executable `uvicorn` could not be found").
ENV PATH="/app/.venv/bin:$PATH"

COPY app ./app
# Structured-JSON logging config applied by uvicorn at boot (so even its earliest lifecycle lines
# are JSON, not red-on-stderr). See app/logging_config.py + docs/architecture/deployment.md.
COPY log_config.json ./

EXPOSE 8000
# Bind IPv6 (::) — Railway's PRIVATE network is IPv6-only, so backend.railway.internal is only
# reachable if uvicorn listens on ::. Dual-stack Linux serves IPv4 too, so local/public still work.
CMD ["uvicorn", "app.main:app", "--host", "::", "--port", "8000", "--log-config", "log_config.json"]
