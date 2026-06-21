FROM node:20-alpine

# Instalar FFmpeg
RUN apk add --no-cache ffmpeg wget curl

WORKDIR /app

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
