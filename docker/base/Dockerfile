FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ── Base packages ──────────────────────────────────────────────────────────────
# openssh-server : sshd — accepts incoming SSH connections (from Serveo relay)
# openssh-client : ssh  — creates OUTBOUND reverse tunnel to serveo.net
#                         THIS IS THE KEY: tunnel runs from inside Linux container,
#                         not from Windows host → bypasses all Windows Firewall issues
RUN apt-get update && apt-get install -y \
    openssh-server \
    openssh-client \
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

# ── Create c3user ──────────────────────────────────────────────────────────────
RUN useradd -m -s /bin/bash c3user && \
    mkdir -p /home/c3user/.ssh && \
    chmod 700 /home/c3user/.ssh && \
    mkdir -p /workspace && \
    chown -R c3user:c3user /home/c3user /workspace

# ── SSH server config ──────────────────────────────────────────────────────────
# Allow root login (for simplicity in compute sessions)
# Keypair auth only — no passwords
RUN echo "PermitRootLogin yes"               >> /etc/ssh/sshd_config && \
    echo "PubkeyAuthentication yes"          >> /etc/ssh/sshd_config && \
    echo "PasswordAuthentication no"         >> /etc/ssh/sshd_config && \
    echo "AuthorizedKeysFile .ssh/authorized_keys" >> /etc/ssh/sshd_config && \
    echo "StrictModes no"                    >> /etc/ssh/sshd_config && \
    echo "X11Forwarding no"                  >> /etc/ssh/sshd_config

RUN mkdir -p /run/sshd /var/run/sshd

COPY c3-entrypoint.sh /usr/local/bin/c3-entrypoint.sh
RUN chmod +x /usr/local/bin/c3-entrypoint.sh

# Port 22 is exposed so Serveo can route to it via the reverse tunnel
EXPOSE 22

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/c3-entrypoint.sh"]
