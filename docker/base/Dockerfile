FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    openssh-server \
    python3 \
    python3-pip \
    git \
    curl \
    wget \
    htop \
    nano \
    vim \
    unzip \
    zip \
    gcc \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

# Create c3user with no password
RUN useradd -m -s /bin/bash c3user && \
    mkdir -p /home/c3user/.ssh && \
    chmod 700 /home/c3user/.ssh && \
    mkdir -p /workspace && \
    chown -R c3user:c3user /home/c3user /workspace

# Configure SSH: keypair auth only, no password, no root
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config && \
    sed -i 's/#PermitRootLogin/PermitRootLogin no\n#PermitRootLogin/' /etc/ssh/sshd_config

RUN mkdir -p /run/sshd

COPY c3-entrypoint.sh /usr/local/bin/c3-entrypoint.sh
RUN chmod +x /usr/local/bin/c3-entrypoint.sh

EXPOSE 22
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/c3-entrypoint.sh"]
