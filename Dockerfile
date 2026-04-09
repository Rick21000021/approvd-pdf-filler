FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js ./
COPY templates/ ./templates/
EXPOSE 3200
ENV PORT=3200
CMD ["node", "server.js"]
