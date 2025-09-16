FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Railway will override CMD per service, so we don't hardcode which bot runs
CMD ["npm", "start:oracle"]
