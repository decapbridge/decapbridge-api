FROM node:20

WORKDIR /app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci

# Build extensions
COPY . .
RUN ./run build

ARG GIT_REV

ENV \
  NODE_ENV="production" \
  PORT=80 \
  TZ="America/New_York" \
  GIT_REV=${GIT_REV}

# Start app
EXPOSE 80
CMD ["./run", "start"]
