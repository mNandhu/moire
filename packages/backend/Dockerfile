# syntax=docker/dockerfile:1

# Builder stage: compile dependencies with uv
FROM python:3.12-slim-bookworm AS builder

# Copy uv from official uv image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Optimize uv for Docker
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

# Install dependencies using build cache mounts for better layer caching
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

# Copy application code and install the project into the venv
COPY . /app

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable


# Runtime stage: minimal image with only what's needed
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MOIRE_HOME=/data \
    SQLITE_PATH=/data/moire.db \
    THUMB_ROOT=/data/thumbs \
    MODEL_CACHE_DIR=/data/models \
    LOG_DIR=/data/logs \
    PATH="/app/.venv/bin:$PATH"

# Install curl for health checks and libgomp1 for onnxruntime
RUN apt-get update && apt-get install -y --no-install-recommends curl libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Run as a non-root user for security
RUN groupadd --system --gid 999 nonroot \
 && useradd --system --uid 999 --gid 999 --create-home nonroot

WORKDIR /app

# Copy the fully-built app + venv from the builder
COPY --from=builder --chown=nonroot:nonroot /app /app

# All state (SQLite DB, thumbnails, model cache) lives under /data. Creating it
# owned by the runtime user means a fresh named volume mounted here inherits
# that ownership, so the non-root process can write to it.
RUN mkdir -p /data && chown nonroot:nonroot /data
VOLUME ["/data"]

USER nonroot

EXPOSE 8000

# Health check for the API
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Start the FastAPI app
CMD ["uvicorn", "moire.main:app", "--host", "0.0.0.0", "--port", "8000"]