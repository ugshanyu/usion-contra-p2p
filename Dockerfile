FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3012

EXPOSE 3012

CMD ["npm", "start"]
