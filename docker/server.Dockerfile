FROM node:20-alpine

WORKDIR /app

COPY server/package*.json ./
RUN npm ci --only=production

COPY server/ ./
COPY database/ /database/

EXPOSE 5000

CMD ["npm", "start"]
