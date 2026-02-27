FROM node:20-alpine

WORKDIR /app

# Instala Git (necessário para algumas dependências do npm)
RUN apk add --no-cache git

# Cache Layer: Instala dependências antes de copiar o código todo
COPY package.json ./
COPY tsconfig.json ./

# Instala TODAS as dependências (dev e prod) para o build funcionar
RUN npm install

# Copia o restante do código fonte
COPY src ./src

# Copia a pasta pública (Dashboard)
COPY public ./public

# Compila o TypeScript para JavaScript (gera a pasta dist)
RUN npm run build

# Porta configurável via variável de ambiente
# Hugging Face Spaces usa 7860, outros hosts usam 3000
ENV PORT=7860

EXPOSE 7860

# O comando para rodar o app
CMD ["node", "dist/index.js"]
