# One image shared by every service in the workspace. Which service a container
# runs is decided at start time by the SERVICE env var, so all six containers
# come from a single build.
FROM node:22-alpine

WORKDIR /app

# Dependencies are installed once at the workspace root, where npm hoists them.
# That is why docker-compose bind-mounts only ./services and leaves
# /app/node_modules untouched — the host's node_modules is built for Windows and
# would break tsx's native esbuild binary if it leaked into the container.
COPY package.json package-lock.json ./
COPY services ./services
RUN npm ci

# Must not be loopback: Kong connects from another container.
ENV HOST=0.0.0.0
ENV SERVICE=event

# Not `npm run dev` (tsx watch): tsx watches via Node's fs.watch, and filesystem
# events do not cross a Docker Desktop bind mount on Windows or macOS, so edits
# on the host would never trigger a reload. nodemon's --legacy-watch polls the
# mounted directory instead, which does see host edits. It only supervises the
# process; tsx still does the TypeScript execution.
CMD ["sh", "-c", "./node_modules/.bin/nodemon --legacy-watch --quiet --watch services/$SERVICE/src --ext ts,json --exec \"./node_modules/.bin/tsx services/$SERVICE/src/index.ts\""]
