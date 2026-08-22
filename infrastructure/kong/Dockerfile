# Bakes kong.yml into the image — ECS can't bind-mount from a host path the
# way local docker-compose does.
FROM kong:3.9

COPY kong.yml /kong/declarative/kong.yml

ENV KONG_DATABASE=off
ENV KONG_DECLARATIVE_CONFIG=/kong/declarative/kong.yml
ENV KONG_PROXY_LISTEN=0.0.0.0:8000
ENV KONG_STATUS_LISTEN=0.0.0.0:8100
# "auto" (the default) sizes worker_processes off the host's full CPU count,
# not the container's actual cgroup CPU quota (256 CPU units = 0.25 vCPU on
# Fargate) — measured spawning dozens of workers and pushing `kong health`
# past 11s under CPU starvation, well beyond ECS's 5s healthcheck timeout,
# which was enough to fail the check and get the task cycled continuously.
ENV KONG_NGINX_WORKER_PROCESSES=1
