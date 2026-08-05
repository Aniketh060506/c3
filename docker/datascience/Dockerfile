FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    openssh-server \
    python3 \
    python3-pip \
    r-base \
    git curl wget htop nano vim unzip zip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir \
    jupyterlab \
    numpy pandas scikit-learn matplotlib seaborn \
    statsmodels scipy plotly ipywidgets

RUN useradd -m -s /bin/bash c3user && \
    mkdir -p /home/c3user/.ssh && \
    chmod 700 /home/c3user/.ssh && \
    mkdir -p /workspace && \
    chown -R c3user:c3user /home/c3user /workspace

RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config

RUN mkdir -p /run/sshd

COPY c3-entrypoint.sh /usr/local/bin/c3-entrypoint.sh
RUN chmod +x /usr/local/bin/c3-entrypoint.sh

EXPOSE 22
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/c3-entrypoint.sh"]
