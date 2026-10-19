# Still renderer for a GPU host (for example a GCP g2-standard-8 with an NVIDIA L4).
# Build from the repository root: docker build -f render/Dockerfile -t fury-stills .
# Run with the NVIDIA container toolkit and every driver capability, so Chromium gets Vulkan:
#   docker run --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all \
#     -e R2_ACCOUNT_ID -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY -e R2_BUCKET \
#     fury-stills npm run batch -- --r2 --pages 3 --shard 0/4
FROM mcr.microsoft.com/playwright:v1.56.1-noble

# The Vulkan loader and NVIDIA's ICD manifest location; the driver itself comes from the host.
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan1 vulkan-tools \
  && rm -rf /var/lib/apt/lists/*
ENV NVIDIA_DRIVER_CAPABILITIES=all

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The worker renders the exact build of this commit.
RUN npm run build
WORKDIR /app/render
RUN npm ci
CMD ["npm", "run", "batch", "--", "--r2"]
