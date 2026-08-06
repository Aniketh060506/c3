#!/bin/bash
set -e

echo "[C3] Container starting..."

# ── Write the user's RSA public key into authorized_keys ──────────────────────
# C3_PUBKEY is injected by the Electron app via docker --env
if [ -n "$C3_PUBKEY" ]; then
    # Root SSH
    mkdir -p /root/.ssh
    chmod 700 /root/.ssh
    echo "$C3_PUBKEY" > /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys

    # c3user SSH
    mkdir -p /home/c3user/.ssh
    chmod 700 /home/c3user/.ssh
    echo "$C3_PUBKEY" > /home/c3user/.ssh/authorized_keys
    chmod 600 /home/c3user/.ssh/authorized_keys
    chown -R c3user:c3user /home/c3user/.ssh

    echo "[C3] Public key written to authorized_keys for root and c3user"
else
    echo "[C3] WARNING: C3_PUBKEY not set — SSH login will fail (no authorized key)"
fi

# ── Generate SSH host keys (if not present) ───────────────────────────────────
ssh-keygen -A
echo "[C3] SSH host keys ready"

# ── Start sshd ────────────────────────────────────────────────────────────────
# sshd runs on port 22 inside the container.
# The Electron app (provider side) will then run:
#   ssh -R 0:localhost:22 serveo.net
# from INSIDE this container to create a public Serveo tunnel.
# Serveo routes external SSH connections back to this sshd.

echo "[C3] Starting sshd on port 22..."

# Loop so container stays alive if sshd exits (e.g., on connection close)
while true; do
    /usr/sbin/sshd -D -e 2>&1
    echo "[C3] sshd exited — restarting in 1s..."
    sleep 1
done
