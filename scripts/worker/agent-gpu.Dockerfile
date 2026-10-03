# GPU variant of the processing agent's sandbox, for workers with an NVIDIA GPU (the RTX 3090 Ti on
# siracusa). It adds Brush, a Gaussian splat trainer that runs on the GPU through Vulkan, to the CPU image.
#
#   docker build -f scripts/worker/agent.Dockerfile -t sphr-agent .
#   docker build -f scripts/worker/agent-gpu.Dockerfile -t sphr-agent-gpu .
#
# Run it with `--gpus all -e NVIDIA_DRIVER_CAPABILITIES=all` so the NVIDIA runtime mounts the driver's
# Vulkan support into the container.
FROM sphr-agent
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan1 xz-utils curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG BRUSH_VERSION=v0.3.0
ARG BRUSH_SHA256=4f0f9a8785d1951c
RUN curl -fsSL "https://github.com/ArthurBrussee/brush/releases/download/${BRUSH_VERSION}/brush-app-x86_64-unknown-linux-gnu.tar.xz" -o /tmp/brush.tar.xz \
    && curl -fsSL "https://github.com/ArthurBrussee/brush/releases/download/${BRUSH_VERSION}/brush-app-x86_64-unknown-linux-gnu.tar.xz.sha256" -o /tmp/brush.sha256 \
    && test "$(cut -d' ' -f1 /tmp/brush.sha256)" = "$(sha256sum /tmp/brush.tar.xz | cut -d' ' -f1)" \
    && test "$(sha256sum /tmp/brush.tar.xz | cut -c1-16)" = "$BRUSH_SHA256" \
    && tar -xJf /tmp/brush.tar.xz -C /opt \
    && ln -s /opt/brush-app-x86_64-unknown-linux-gnu/brush_app /usr/local/bin/brush_app \
    && rm /tmp/brush.tar.xz /tmp/brush.sha256
ENV SPHR_GPU=nvidia
USER node
