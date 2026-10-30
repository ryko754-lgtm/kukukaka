FROM node:24-alpine
RUN apk add --no-cache tar unzip ca-certificates
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
