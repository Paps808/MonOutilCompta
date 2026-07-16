# MonOutilCompta (MOC) — Node (serveur) + Python (conversion PDF->Word haute fidélité)
FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages pdf2docx

WORKDIR /app
COPY . .

ENV PORT=3001
EXPOSE 3001
CMD ["node", "server.js"]
