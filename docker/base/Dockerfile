FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    git curl wget htop \
    nano vim unzip zip \
    gcc g++ make \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash c3user && \
    mkdir -p /workspace && \
    chown -R c3user:c3user /workspace

WORKDIR /workspace

# Keep container alive — docker exec creates shells on demand
CMD ["tail", "-f", "/dev/null"]
