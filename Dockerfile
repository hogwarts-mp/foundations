# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY resources/hmp-activities/package.json resources/hmp-activities/package.json
COPY resources/hmp-admin/package.json resources/hmp-admin/package.json
COPY resources/hmp-audio/package.json resources/hmp-audio/package.json
COPY resources/hmp-banking/package.json resources/hmp-banking/package.json
COPY resources/hmp-blips/package.json resources/hmp-blips/package.json
COPY resources/hmp-business/package.json resources/hmp-business/package.json
COPY resources/hmp-characters/package.json resources/hmp-characters/package.json
COPY resources/hmp-core/package.json resources/hmp-core/package.json
COPY resources/hmp-doors/package.json resources/hmp-doors/package.json
COPY resources/hmp-duels/package.json resources/hmp-duels/package.json
COPY resources/hmp-emotes/package.json resources/hmp-emotes/package.json
COPY resources/hmp-houses/package.json resources/hmp-houses/package.json
COPY resources/hmp-interact/package.json resources/hmp-interact/package.json
COPY resources/hmp-inventory/package.json resources/hmp-inventory/package.json
COPY resources/hmp-jobs/package.json resources/hmp-jobs/package.json
COPY resources/hmp-lib/package.json resources/hmp-lib/package.json
COPY resources/hmp-mysql/package.json resources/hmp-mysql/package.json
COPY resources/hmp-npcs/package.json resources/hmp-npcs/package.json
COPY resources/hmp-progression/package.json resources/hmp-progression/package.json
COPY resources/hmp-pvp/package.json resources/hmp-pvp/package.json
COPY resources/hmp-shops/package.json resources/hmp-shops/package.json
COPY resources/hmp-spawn/package.json resources/hmp-spawn/package.json
COPY resources/hmp-spells/package.json resources/hmp-spells/package.json
COPY resources/hmp-ui/package.json resources/hmp-ui/package.json
COPY resources/hmp-webhooks/package.json resources/hmp-webhooks/package.json
COPY resources/hmp-world/package.json resources/hmp-world/package.json
RUN npm ci

COPY . .
RUN npm run verify

FROM scratch AS pack

LABEL org.opencontainers.image.title="HMP Foundations" \
      org.opencontainers.image.description="Versioned HogwartsMP server resource pack" \
      org.opencontainers.image.licenses="LicenseRef-MafiaHub-OSS"

COPY --from=build /workspace/build/hmp-foundations/ /
