# VM Setup Guide

This guide covers setting up the Linux VM for vm-bash execution in YAAIA.

## Overview

vm-bash blocks run bash scripts inside a Linux VM. The VM must have:

1. **Shared folder** (`/mnt/shared`) mounted from the host
2. **yaaia-vm-agent** running at boot, after the shared folder is mounted

## Setup Mode

Enable **Setup mode** in Configuration to:

- Expose `vm_serial` APIs (connect, read, write, write_from_file, disconnect)
- Get a setup checklist when `vmControl.power_on` succeeds

When Setup mode is off, `vm_serial` is not available.

## Setup Checklist

### 1. Check if /mnt/shared is mounted

In the VM, run:

```bash
mount | grep /mnt/shared
```

If nothing is shown, the shared folder is not mounted. Configure virtiofs in the VM (YaaiaVM uses `Shared` tag; in guest: `mount -t virtiofs Shared /mnt/shared`).

### 2. Mount on boot

If `/mnt/shared` is mounted manually, ensure it mounts automatically on boot. Options:

- **/etc/fstab**: Add a line for the virtiofs mount
- **systemd mount unit**: Create a `.mount` unit that runs after the virtiofs device is available

### 3. Launch yaaia-vm-agent at boot

The agent must start **after** `/mnt/shared` is mounted. Options:

- **systemd service**: Create a service that `Requires`/`After` the mount unit, and runs `/mnt/shared/yaaia-vm-agent`
- **rc.local** or similar: Ensure the mount is available before starting the agent

Example systemd service (`/etc/systemd/system/yaaia-vm-agent.service`):

```ini
[Unit]
Description=YAAIA VM Agent
After=network.target mnt-shared.mount
Requires=mnt-shared.mount

[Service]
ExecStart=/mnt/shared/yaaia-vm-agent
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable: `systemctl enable yaaia-vm-agent`

## Verification

1. Power on the VM with `vmControl.power_on` (or use vm_serial in setup mode to verify manually).
2. Use vm-bash blocks in the agent.
