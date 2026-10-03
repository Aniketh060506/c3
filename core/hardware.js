'use strict';

/**
 * core/hardware.js
 * High-performance 1-Second Dynamic Telemetry Engine for C3.
 * Zero-overhead native CPU delta ticks, native memory, and real network telemetry.
 * ZERO MOCK DATA - 100% Real Physical Hardware & Real Physical Network.
 */

const si = require('systeminformation');
const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const net = require('net');

const execAsync = promisify(exec);

let _specsCache = null;
let _specsPromise = null;

// ── Physical Network Adapter Helper ─────────────────────────────────────────
function isVirtualInterface(name = '', ip = '') {
  const n = name.toLowerCase();
  if (
    n.includes('vethernet') ||
    n.includes('vmware') ||
    n.includes('virtualbox') ||
    n.includes('hyper-v') ||
    n.includes('loopback') ||
    n.includes('tailscale') ||
    n.includes('bluetooth') ||
    n.includes('host-only') ||
    n.includes('wsl') ||
    n.includes('tap') ||
    n.includes('tun') ||
    n.includes('bridge')
  ) {
    return true;
  }
  if (
    ip.startsWith('127.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('100.') || // Tailscale Carrier-Grade NAT
    ip.startsWith('192.168.56.') || // VirtualBox default host-only
    ip.startsWith('192.168.133.') || // VMware default host-only
    ip.startsWith('192.168.255.') || // VMware default NAT
    (ip.startsWith('172.') && !n.includes('wi-fi') && !n.includes('ethernet')) // WSL/Docker default bridge
  ) {
    return true;
  }
  return false;
}

function getPhysicalAdapter() {
  const ifaces = os.networkInterfaces();
  let physical = null;
  let tailscaleIp = null;

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        if (addr.address.startsWith('100.') || name.toLowerCase().includes('tailscale')) {
          tailscaleIp = addr.address;
        } else if (!isVirtualInterface(name, addr.address)) {
          // Prefer physical Wi-Fi or Ethernet
          if (!physical || name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('ethernet')) {
            physical = {
              name,
              ip: addr.address,
              mac: addr.mac,
              type: name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wireless') ? 'wireless' : 'wired',
            };
          }
        }
      }
    }
  }

  return { physical, tailscaleIp };
}

// ── Background Network Latency & Internet Probe ──────────────────────────────
let _cachedLatencyMs = null;
let _isOnline = false;
let _probeInProgress = false;

function probeInternetLatency(timeout = 700) {
  if (_probeInProgress) return;
  _probeInProgress = true;

  const start = Date.now();
  const socket = new net.Socket();
  let completed = false;

  socket.setTimeout(timeout);

  const finish = (online, latency) => {
    if (completed) return;
    completed = true;
    socket.destroy();
    _isOnline = online;
    _cachedLatencyMs = online ? latency : null;
    _probeInProgress = false;
  };

  socket.on('connect', () => {
    const lat = Date.now() - start;
    finish(true, lat);
  });

  const tryBackup = () => {
    // Retry once with 8.8.8.8
    const backup = new net.Socket();
    backup.setTimeout(500);
    backup.on('connect', () => {
      const lat = Date.now() - start;
      backup.destroy();
      finish(true, lat);
    });
    backup.on('error', () => {
      backup.destroy();
      finish(false, null);
    });
    backup.on('timeout', () => {
      backup.destroy();
      finish(false, null);
    });
    backup.connect(53, '8.8.8.8');
  };

  socket.on('error', () => {
    tryBackup();
  });

  socket.on('timeout', () => {
    finish(false, null);
  });

  socket.connect(53, '1.1.1.1');
}

// ── Background Link Speed & Disk Space Worker ───────────────────────────────
let _cachedSpeedMbps = 0;
let _cachedDiskStats = null;

async function refreshNetworkSpeed() {
  try {
    const ifaces = await si.networkInterfaces();
    if (Array.isArray(ifaces)) {
      const activePhysical = ifaces.find(i => 
        !isVirtualInterface(i.iface, i.ip4 || '') && 
        i.operstate === 'up' && 
        (i.type === 'wireless' || i.type === 'wired')
      );
      if (activePhysical && activePhysical.speed) {
        _cachedSpeedMbps = Math.round(activePhysical.speed);
      } else if (!activePhysical) {
        _cachedSpeedMbps = 0;
      }
    }
  } catch (_) {}
}

async function refreshDiskStats() {
  try {
    const disks = await si.fsSize();
    if (Array.isArray(disks) && disks.length > 0) {
      const mainDrive = disks.find(d => (d.mount || '').toUpperCase().startsWith('C:')) || disks[0];
      const sizeGb = parseFloat((mainDrive.size / (1024 * 1024 * 1024)).toFixed(1));
      const usedGb = parseFloat((mainDrive.used / (1024 * 1024 * 1024)).toFixed(1));
      const freeGb = parseFloat(((mainDrive.size - mainDrive.used) / (1024 * 1024 * 1024)).toFixed(1));
      _cachedDiskStats = {
        mount: mainDrive.mount || 'C:',
        sizeGb,
        usedGb,
        freeGb,
        usePercent: Math.round(mainDrive.use || 0),
      };
    }
  } catch (_) {}
}

// ── Background GPU Telemetry Worker ─────────────────────────────────────────
let _cachedGpuStats = null;
let _gpuPending = false;

function refreshGpuInBackground() {
  if (_gpuPending) return;
  _gpuPending = true;

  execAsync('nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits', { timeout: 1200 })
    .then(({ stdout }) => {
      const p = stdout.trim().split(',').map(s => s.trim());
      if (p.length >= 5) {
        const parseMetric = value => {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const usedMb = parseMetric(p[2]);
        const totalMb = parseMetric(p[3]);
        const gpuPercent = parseMetric(p[1]);
        _cachedGpuStats = {
          name: p[0],
          gpuPercent,
          memUsedMb: usedMb,
          memTotalMb: totalMb,
          memUsedGb: usedMb == null ? null : parseFloat((usedMb / 1024).toFixed(2)),
          memTotalGb: totalMb == null ? null : parseFloat((totalMb / 1024).toFixed(1)),
          memPercent: totalMb > 0 && usedMb != null ? Math.round((usedMb / totalMb) * 100) : null,
          temp: parseMetric(p[4]),
          powerDraw: p[5] ? parseMetric(p[5]) : null,
        };
      }
    })
    .catch(() => { _cachedGpuStats = null; })
    .finally(() => { _gpuPending = false; });
}

// Start Background Pollers
probeInternetLatency();
refreshNetworkSpeed();
refreshDiskStats();
refreshGpuInBackground();

setInterval(probeInternetLatency, 1500); // Check real internet socket latency every 1.5s
setInterval(refreshGpuInBackground, 2000); // Check GPU registers every 2s
setInterval(refreshNetworkSpeed, 3500); // Check physical link speed every 3.5s
setInterval(refreshDiskStats, 6000); // Check SSD storage every 6s

// ── 1. Static Hardware Specifications (Queried on startup & live refresh) ──
async function getHardwareSpecs(forceRefresh = false) {
  if (!forceRefresh && _specsCache) return _specsCache;
  if (!forceRefresh && _specsPromise) return _specsPromise;

  _specsPromise = (async () => {
    try {
      const [cpu, mem, memLayout, graphics, osInfo] = await Promise.all([
        si.cpu(),
        si.mem(),
        si.memLayout().catch(() => []),
        si.graphics().catch(() => ({ controllers: [] })),
        si.osInfo().catch(() => ({ distro: os.type(), release: os.release() })),
      ]);

      const ramGb = Math.round(mem.total / (1024 * 1024 * 1024));
      const ramUsableGb = parseFloat((mem.total / (1024 * 1024 * 1024)).toFixed(1));
      const firstStick = Array.isArray(memLayout) && memLayout.length > 0 ? memLayout[0] : null;
      const ramType = firstStick?.type || 'Unknown';
      const ramSpeed = firstStick?.clockSpeed ? `${firstStick.clockSpeed} MHz` : null;
      const ramManufacturer = firstStick?.manufacturer || 'Unknown';
      const ramFormFactor = firstStick?.formFactor || 'Unknown';

      let gpuModel = 'None';
      let gpuVendor = 'None';
      let gpuVramGb = 0;
      let gpuDriver = '';

      const controllers = graphics?.controllers || [];
      const discreteGpu = controllers.find(c => {
        const v = (c.vendor || '').toLowerCase();
        const m = (c.model || '').toLowerCase();
        return v.includes('nvidia') || m.includes('rtx') || m.includes('gtx') || m.includes('geforce') ||
          /\b(radeon rx|rx [0-9])/i.test(m);
      });

      if (discreteGpu) {
        gpuModel = discreteGpu.model || discreteGpu.name || 'Dedicated GPU';
        gpuVendor = discreteGpu.vendor || 'GPU';
        gpuVramGb = discreteGpu.vram ? Math.round(discreteGpu.vram / 1024) : 0;
        gpuDriver = discreteGpu.driverVersion || '';
      }

      if (gpuModel.toLowerCase().includes('nvidia') || gpuVendor.toLowerCase().includes('nvidia')) {
        try {
          const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits', { timeout: 1200 });
          const parts = stdout.trim().split(',').map(s => s.trim());
          if (parts.length >= 2) {
            gpuModel = parts[0] || gpuModel;
            gpuVendor = 'NVIDIA';
            const totalMb = parseInt(parts[1], 10);
            if (totalMb > 0) gpuVramGb = Math.round(totalMb / 1024);
            if (parts[2]) gpuDriver = parts[2];
          }
        } catch (_) {}
      }

      // Read Physical Network Adapter
      const { physical, tailscaleIp } = getPhysicalAdapter();
      await refreshNetworkSpeed();
      await refreshDiskStats();

      const specs = {
        hostname: os.hostname(),
        cpuModel: `${cpu.manufacturer || ''} ${cpu.brand || ''}`.trim() || 'Processor',
        cpuCores: Number.isFinite(cpu.cores) ? cpu.cores : os.cpus().length || null,
        cpuPhysicalCores: Number.isFinite(cpu.physicalCores) ? cpu.physicalCores : null,
        cpuSpeedGhz: Number.isFinite(cpu.speed) ? cpu.speed : null,
        ramGb,
        ramUsableGb,
        ramType,
        ramSpeed,
        ramManufacturer,
        ramFormFactor,
        gpu: gpuModel !== 'None' ? `${gpuModel}${gpuVramGb ? ` (${gpuVramGb}GB)` : ''}` : 'None',
        gpuModel,
        gpuVendor,
        gpuVramGb,
        gpuDriver,
        disk: _cachedDiskStats,
        os: `${osInfo.distro || os.type()} ${osInfo.release || ''}`.trim(),
        arch: os.arch(),
        primaryNetwork: physical ? {
          name: physical.name,
          ip: physical.ip,
          type: physical.type,
          speedMbps: _isOnline ? _cachedSpeedMbps : 0,
          isOnline: _isOnline,
        } : {
          name: 'Disconnected',
          ip: 'No Physical Network',
          type: 'none',
          speedMbps: 0,
          isOnline: false,
        },
        tailscaleIp,
      };

      _specsCache = specs;
      return specs;
    } catch (err) {
      console.error('[hardware] Failed to detect specs:', err.message);
      const cpus = os.cpus() || [];
      const totalMem = os.totalmem();
      const memGb = Math.round(totalMem / (1024 * 1024 * 1024));
      const ramUsableGb = parseFloat((totalMem / (1024 * 1024 * 1024)).toFixed(1));
      return _specsCache || {
        hostname: os.hostname(),
        cpuModel: cpus[0]?.model || 'Generic Processor',
        cpuCores: cpus.length || null,
        cpuPhysicalCores: null,
        cpuSpeedGhz: cpus[0]?.speed ? parseFloat((cpus[0].speed / 1000).toFixed(1)) : 0,
        ramGb: memGb,
        ramUsableGb,
        ramType: 'Unknown',
        ramSpeed: '',
        ramManufacturer: 'Unknown',
        gpu: 'None',
        gpuModel: 'None',
        gpuVendor: 'None',
        gpuVramGb: 0,
        gpuDriver: '',
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        primaryNetwork: { name: 'Offline', ip: 'Disconnected', type: 'none', speedMbps: 0, isOnline: false },
        tailscaleIp: null,
      };
    } finally {
      _specsPromise = null;
    }
  })();

  return _specsPromise;
}

// ── 2. Native High-Speed 1-Second CPU Delta Ticks ──
let _prevCpus = os.cpus();

function getInstantCpuPercent() {
  const currentCpus = os.cpus();
  let idleDelta = 0;
  let totalDelta = 0;

  for (let i = 0; i < currentCpus.length; i++) {
    const prev = _prevCpus[i]?.times || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const curr = currentCpus[i].times;

    const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
    const currTotal = curr.user + curr.nice + curr.sys + curr.idle + curr.irq;

    idleDelta += (curr.idle - prev.idle);
    totalDelta += (currTotal - prevTotal);
  }

  _prevCpus = currentCpus;
  if (totalDelta <= 0) return 0;
  const load = Math.round(100 * (1 - (idleDelta / totalDelta)));
  return Math.min(100, Math.max(0, load));
}

// ── 3. Instant 1-Second getLiveStats() (Zero Blocking, Executes in <5ms) ──
async function getLiveStats() {
  const cpuPercent = getInstantCpuPercent();

  // Instant Native Memory
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const memTotalGb = parseFloat((total / (1024 * 1024 * 1024)).toFixed(1));
  const memUsedGb = parseFloat((used / (1024 * 1024 * 1024)).toFixed(1));
  const memFreeGb = parseFloat((free / (1024 * 1024 * 1024)).toFixed(1));
  const memPercent = total > 0 ? Math.round((used / total) * 100) : 0;

  // Instant Physical Network Check
  const { physical, tailscaleIp } = getPhysicalAdapter();
  const hasPhysical = !!physical;
  const effectivelyOnline = hasPhysical && _isOnline;

  const uptimeSec = os.uptime();
  const uptimeHours = parseFloat((uptimeSec / 3600).toFixed(1));

  return {
    cpuPercent,
    memPercent,
    memUsedGb,
    memTotalGb,
    memFreeGb,
    network: {
      isOnline: effectivelyOnline,
      adapterName: hasPhysical ? physical.name : 'No Connection',
      ip: hasPhysical ? physical.ip : 'Disconnected',
      type: hasPhysical ? physical.type : 'none',
      speedMbps: effectivelyOnline ? _cachedSpeedMbps : 0,
      latencyMs: effectivelyOnline ? _cachedLatencyMs : null,
      tailscaleIp,
    },
    disk: _cachedDiskStats,
    uptimeHours,
    gpu: _cachedGpuStats,
    timestamp: Date.now(),
  };
}

module.exports = {
  getHardwareSpecs,
  getLiveStats,
};
