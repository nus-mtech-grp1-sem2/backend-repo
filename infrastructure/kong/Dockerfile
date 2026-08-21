# Bakes kong.yml into the image — ECS can't bind-mount from a host path the
# way local docker-compose does.
FROM kong:3.9

COPY kong.yml /kong/declarative/kong.yml

ENV KONG_DATABASE=off
ENV KONG_DECLARATIVE_CONFIG=/kong/declarative/kong.yml
ENV KONG_PROXY_LISTEN=0.0.0.0:8000
ENV KONG_STATUS_LISTEN=0.0.0.0:8100
