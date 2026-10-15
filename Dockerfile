FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL=http://localhost:4100
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm install --frozen-lockfile && pnpm --filter @agents/web build
EXPOSE 3100 4100
CMD ["sh", "-c", "PORT=4100 pnpm --filter @agents/runtime start & pnpm --filter @agents/web start"]
