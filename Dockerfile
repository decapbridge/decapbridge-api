FROM node:22

WORKDIR /app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci

# Build extensions
COPY . .
RUN ./run build

ENV \
  NODE_ENV="production" \
  PORT=80 \
  TZ="America/New_York"

# Start app
EXPOSE 80
CMD ["./run", "start"]
