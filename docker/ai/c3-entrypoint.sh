#!/bin/bash
set -e

# Write user's public key into authorized_keys
if [ -n "$C3_USER_PUBKEY" ]; then
    echo "$C3_USER_PUBKEY" > /home/c3user/.ssh/authorized_keys
    chmod 600 /home/c3user/.ssh/authorized_keys
    chown c3user:c3user /home/c3user/.ssh/authorized_keys
fi

# Generate host SSH keys if missing
ssh-keygen -A

echo "[C3] Container ready. SSH server starting on port 22..."
exec /usr/sbin/sshd -D
