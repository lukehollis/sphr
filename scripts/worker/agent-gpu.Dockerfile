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
# Nerfstudio's splatfacto, for handheld captures whose auto exposure and white balance Brush would turn into
# floaters: its bilateral grid absorbs per-frame exposure, and its camera optimizer absorbs COLMAP pose error.
# gsplat ships prebuilt CUDA kernels only for Python 3.10, so nerfstudio gets its own Python under
# /opt/nerfstudio. The sandbox has no network, so the LPIPS backbone splatfacto loads at startup is fetched here.
ARG UV_VERSION=0.5.11
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python TORCH_HOME=/opt/torch-hub
RUN /opt/venv/bin/pip install --no-cache-dir "uv==${UV_VERSION}" \
    && /opt/venv/bin/uv venv --python 3.10 /opt/nerfstudio \
    && /opt/venv/bin/uv pip install --no-cache --python /opt/nerfstudio/bin/python torch==2.4.1 torchvision==0.19.1 \
         --index-url https://download.pytorch.org/whl/cu124 \
    && /opt/venv/bin/uv pip install --no-cache --python /opt/nerfstudio/bin/python "gsplat==1.4.0+pt24cu124" \
         --index-url https://docs.gsplat.studio/whl/pt24cu124 \
    && /opt/venv/bin/uv pip install --no-cache --python /opt/nerfstudio/bin/python nerfstudio==1.1.5 \
    && /opt/nerfstudio/bin/python -c "from torchmetrics.image.lpip import LearnedPerceptualImagePatchSimilarity as L; L(normalize=True)" \
    && for tool in ns-train ns-export ns-render ns-eval; do ln -s /opt/nerfstudio/bin/$tool /usr/local/bin/$tool; done \
    && chmod -R a+rX /opt/uv-python /opt/nerfstudio /opt/torch-hub
USER node
