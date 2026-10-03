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
# Debian's Blender (3.4) has no USD importer, so USDZ scans from iPhone apps lost their textures. The official
# LTS build imports USD/USDZ with materials; mesh_to_glb.py uses it through BLENDER. download.blender.org refuses
# some networks, so official mirrors are tried in turn; the checksum pins the file either way.
ARG BLENDER_VERSION=4.2.23
ARG BLENDER_SHA256=bea0eb3146be13eae6225409a117b215184f41b7f79e799f97cb3abb8f6dc404
RUN apt-get update && apt-get install -y --no-install-recommends libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 \
      libgl1 libegl1 libxkbcommon0 libsm6 libice6 \
    && rm -rf /var/lib/apt/lists/* \
    && for mirror in https://download.blender.org https://mirrors.ocf.berkeley.edu/blender https://mirror.clarkson.edu/blender https://ftp.nluug.nl/pub/graphics/blender; do \
         curl -fsSL "$mirror/release/Blender4.2/blender-${BLENDER_VERSION}-linux-x64.tar.xz" -o /tmp/blender.tar.xz && break; done \
    && echo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/blender.tar.xz -C /opt && mv "/opt/blender-${BLENDER_VERSION}-linux-x64" /opt/blender && rm /tmp/blender.tar.xz
ENV SPHR_GPU=nvidia BLENDER=/opt/blender/blender
USER node
