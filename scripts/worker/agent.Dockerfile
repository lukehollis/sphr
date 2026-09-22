# Sandbox for the processing agent. The agent reads untrusted uploads, so it runs here without
# the runner's credentials: only the job folder is writable, the repository's scripts and skills
# are mounted read-only at /opt/sphr, and the model API key is the only secret passed in.
#
#   docker build -f scripts/worker/agent.Dockerfile -t sphr-agent .
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip python3-dev ffmpeg colmap blender unzip ca-certificates \
      build-essential cmake ninja-build libxerces-c-dev \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/matterport/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt "laspy[lazrs]" \
    && rm /tmp/requirements.txt
WORKDIR /opt/sphr
# Linux builds of the Node packages the tools use; the scripts themselves are mounted at run time.
RUN echo '{"name":"sphr-agent-tools","private":true,"type":"module"}' > package.json \
    && npm install --no-audit --no-fund sharp@0.34.5 \
    && npm install -g --no-audit --no-fund @anthropic-ai/claude-code
ENV SPHR_MATTERPORT_PYTHON=/opt/venv/bin/python PATH=/opt/venv/bin:$PATH BLENDER=/usr/bin/blender
USER node
