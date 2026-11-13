FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && chown node:node /data

WORKDIR /app
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=3000 TZ=America/Edmonton
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
