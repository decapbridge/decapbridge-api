FROM node:22

WORKDIR /app

ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

# Install deps
COPY package.json package-lock.json ./
RUN npm ci

# Build extensions
COPY . .
RUN ./run build

ENV \
  NODE_ENV="production" \
  PORT=80 \
  TZ="America/Montreal"

# Start app
EXPOSE 80
CMD ["./run", "start"]
