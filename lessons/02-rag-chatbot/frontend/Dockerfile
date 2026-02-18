# Build stage
FROM node:20-alpine AS build
WORKDIR /app

# Copy only package manifests first for better caching
COPY package*.json ./

# Use npm install (works even without package-lock.json)
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# Run stage
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
