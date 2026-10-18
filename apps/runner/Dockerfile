# The sandbox image: Node, git, the two engines (Claude Code and the GitHub Copilot CLI), and the bundled runner. Built by `pnpm --filter @sdlc/runner image`.
# It holds no secrets. Credentials arrive as environment variables when a run starts.
# Public ECR has no pull limit from AWS. CI builds from Docker Hub instead, since ECR throttles GitHub's shared addresses.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
FROM ${NODE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.212 @github/copilot@1.0.100-1 \
 && npm cache clean --force

# /work holds the checkout and the engine's session store. A named volume mounted here keeps it between a park and a resume.
RUN mkdir -p /work /app && chown node:node /work
COPY dist/runner.mjs dist/egress.mjs /app/

USER node
WORKDIR /work
ENV HOME=/work/home NODE_ENV=production DISABLE_AUTOUPDATER=1
CMD ["node", "/app/runner.mjs"]
