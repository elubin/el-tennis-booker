# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY src ./src
COPY booking.config.example.json ./

# Generated at build time so Windows CRLF on a checked-out docker-entrypoint.sh cannot break the image.
COPY <<'EOF' /docker-entrypoint.sh
#!/bin/sh
set -eu
export DISPLAY=:99
export HEADLESS=false

Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
sleep 0.5
x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 127.0.0.1:6080 localhost:5900 >/tmp/websockify.log 2>&1 &

exec "$@"
EOF
RUN chmod +x /docker-entrypoint.sh

ENV HEADLESS=false
ENV DISPLAY=:99
ENTRYPOINT ["/bin/sh", "/docker-entrypoint.sh"]
CMD ["sh", "-c", "node src/settings.js & exec node src/index.js watch"]
