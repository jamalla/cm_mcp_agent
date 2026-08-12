# The deployed agent: one service serving both the API and the compiled UI.
#
# Two stages because the two halves need different toolchains -- Node to compile
# the SPA, Python to run the BFF -- and only the compiled output is worth keeping.
# Node never reaches the final image.
#
# One service rather than two also settles the browser story: the UI is served
# from the same origin as /api, so the SSE stream that carries stage events needs
# no CORS negotiation and no absolute API base baked in at build time.

# --- stage 1: compile the SPA ---------------------------------------------
FROM node:22-slim AS ui

WORKDIR /ui

# npm ci installs devDependencies too, which the build needs: `npm run build` is
# `tsc -b && vite build`, and the type check fails without them.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# --- stage 2: the service --------------------------------------------------
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .
RUN uv sync --frozen --no-dev

# The compiled SPA lands where app.py looks for it. Copied after the source so a
# stale local frontend/dist in the build context cannot win over what stage 1 built.
COPY --from=ui /ui/dist ./frontend/dist

ENV BFF_HOST=0.0.0.0

CMD ["sh", "-c", "BFF_PORT=${PORT:-8000} .venv/bin/python -m cm_agent.bff.app"]
