# Stage 1: compile TypeScript with dev dependencies
FROM public.ecr.aws/lambda/nodejs:22 AS build
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY eval ./eval
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build

# Stage 2: runtime image with production dependencies only
FROM public.ecr.aws/lambda/nodejs:22
WORKDIR ${LAMBDA_TASK_ROOT}
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /build/dist ./dist
COPY public ./public
CMD ["dist/src/server/lambda.handler"]
