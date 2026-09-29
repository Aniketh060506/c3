'use strict';

/**
 * core/hardware.js
 * Hardware detection and live stats module for C3.
 * Pure dynamic detection using systeminformation and nvidia-smi with zero hardcoded metrics.
 */

const si = require('systeminformation');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ── Module-level cache for static hardware specs (never changes at runtime) ──
let _specsCache = null;
let _nvidiaAvailable = null; // null=unknown, true=yes, false=no

/**
 * Returns a detailed static snapshot of this machine's hardware specifications:
 * CPU, detailed RAM, and GPU detected dynamically from the system.
 * Cached after first call — specs never change while app is running.
 * @returns {Promise<object>}
 */
async function getHardwareSpecs() {
  if (_specsCache) return _specsCache;
  const [cpu, mem, memLayout, graphics, osInfo] = await Promise.all([
    si.cpu().catch(() => ({})),
    si.mem().catch(() => ({})),
    si.memLayout().catch(() => []),
    si.graphics().catch(() => ({ controllers: [] })),
    si.osInfo().catch(() => ({})),
  ]);

  // Extract detailed RAM specifications purely from live query
  const firstStick = memLayout && memLayout.length > 0 ? memLayout[0] : null;
  const ramType = firstStick?.type || '';
  const ramSpeed = firstStick?.clockSpeed ? `${firstStick.clockSpeed} MHz` : '';
  const ramManufacturer = firstStick?.manufacturer || '';
  const ramFormFactor = firstStick?.formFactor || '';
  const ramPartNum = firstStick?.partNum || '';
  const totalPhysicalBytes = memLayout && memLayout.length > 0
    ? memLayout.reduce((acc, s) => acc + (s.size || 0), 0)
    : (mem.total || 0);
  const totalPhysicalGb = totalPhysicalBytes ? Math.round(totalPhysicalBytes / 1073741824) : 0;
  const usableGb = mem.total ? parseFloat((mem.total / 1073741824).toFixed(1)) : 0;

  // Extract GPU specifications purely from live detection
  let gpuModel = 'None';
  let gpuVendor = 'None';
  let gpuVramGb = 0;
  let gpuDriver = '';
  let gpuLabel = 'None';

  // 1. Try nvidia-smi first for accurate discrete NVIDIA GPU telemetry
  let nvidiaDetected = false;
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits', { timeout: 2000 });
    const parts = stdout.trim().split(',').map(s => s.trim());
    if (parts.length >= 3 && parts[0]) {
      gpuModel = parts[0];
      gpuVendor = 'NVIDIA';
      gpuDriver = parts[1] || '';
      const mb = parseInt(parts[2], 10) || 0;
      gpuVramGb = mb > 0 ? parseFloat((mb / 1024).toFixed(1)) : 0;
      gpuLabel = `${gpuModel} (${gpuVramGb}GB VRAM)`;
      nvidiaDetected = true;
    }
  } catch {}

  // 2. If nvidia-smi didn't detect or another GPU exists, inspect graphics.controllers
  if (!nvidiaDetected && graphics.controllers && graphics.controllers.length > 0) {
    const discrete = graphics.controllers.find(g =>
      g.model &&
      !g.model.toLowerCase().includes('virtual') &&
      !g.model.toLowerCase().includes('remote') &&
      !g.model.toLowerCase().includes('basic render')
    ) || graphics.controllers[0];

    if (discrete && discrete.model) {
      gpuModel = discrete.model;
      gpuVendor = discrete.vendor || '';
      gpuDriver = discrete.driverVersion || '';
      if (discrete.vram) {
        gpuVramGb = Math.round(discrete.vram / 1024);
        gpuLabel = `${gpuModel} (${gpuVramGb}GB VRAM)`;
      } else {
        gpuLabel = gpuModel;
      }
    }
  }

  return {
    cpuModel: `${cpu.manufacturer || ''} ${cpu.brand || ''}`.trim() || 'Processor',
    cpuCores: cpu.physicalCores || cpu.cores || 0,
    cpuThreads: cpu.cores || 0,
    ramGb: totalPhysicalGb || Math.round(usableGb) || 0,
    ramUsableGb: usableGb,
    ramType,
    ramSpeed,
    ramManufacturer,
    ramFormFactor,
    ramPartNum,
    gpu: gpuLabel,
    gpuModel,
    gpuVendor,
    gpuVramGb,
    gpuDriver,
    os: `${osInfo.distro || osInfo.platform || 'OS'} ${osInfo.release || ''}`.trim(),
  };

  _specsCache = result;
  return result;
}


let _liveStatsCache = null;
let _liveStatsCacheTime = 0;
let _liveStatsPending = null;

/**
 * Returns live system utilisation stats, including live discrete GPU metrics if present.
 * Cached for 4s to prevent hammering si.currentLoad() + nvidia-smi from multiple pollers.
 * @returns {Promise<object>}
 */
async function getLiveStats() {
  const now = Date.now();
  if (_liveStatsCache && now - _liveStatsCacheTime < 4000) return _liveStatsCache;
  if (_liveStatsPending) return _liveStatsPending;

  _liveStatsPending = (async () => {
    try {
      const [cpuLoad, mem] = await Promise.all([
        si.currentLoad().catch(() => ({ currentLoad: 0 })),
        si.mem().catch(() => ({ total: 0, used: 0, free: 0 })),
      ]);

  const memUsedBytes = mem.active || mem.used || 0;
  const memTotalBytes = mem.total || 1;
  const memFreeBytes = mem.free || mem.available || 0;

  const memUsedGb = memUsedBytes / 1073741824;
  const memTotalGb = memTotalBytes / 1073741824;
  const memFreeGb = memFreeBytes / 1073741824;

  let gpuStats = null;
  if (_nvidiaAvailable !== false) {
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.total,memory.free,power.draw --format=csv,noheader,nounits', { timeout: 1500 });
      const parts = stdout.trim().split(',').map(s => s.trim());
      if (parts.length >= 6 && parts[0]) {
        _nvidiaAvailable = true;
        const gName = parts[0];
        const gTemp = parseInt(parts[1], 10);
        const gPerc = parseInt(parts[2], 10);
        const gTotalMb = parseInt(parts[3], 10) || 0;
        const gFreeMb = parseInt(parts[4], 10) || 0;
        const gUsedMb = Math.max(0, gTotalMb - gFreeMb);
        const gPower = parseFloat(parts[5]);
        const gMemPerc = gTotalMb > 0 ? Math.round((gUsedMb / gTotalMb) * 100) : 0;

        gpuStats = {
          name: gName,
          gpuPercent: isNaN(gPerc) ? 0 : gPerc,
          memPercent: isNaN(gMemPerc) ? 0 : gMemPerc,
          memUsedMb: gUsedMb,
          memTotalMb: gTotalMb,
          memUsedGb: parseFloat((gUsedMb / 1024).toFixed(2)),
          memTotalGb: parseFloat((gTotalMb / 1024).toFixed(1)),
          temp: isNaN(gTemp) ? null : gTemp,
          powerDraw: isNaN(gPower) ? null : gPower,
        };
      }
    } catch {
      _nvidiaAvailable = false; // Don't retry on this session
    }
  }


  // If no nvidia-smi, check if systeminformation graphics has temperature/memory
  if (!gpuStats) {
    try {
      const graphics = await si.graphics().catch(() => ({ controllers: [] }));
      const controller = graphics.controllers?.find(c => c.temperatureGpu || c.memoryTotal);
      if (controller) {
        const gTotal = controller.memoryTotal || controller.vram || 0;
        const gFree = controller.memoryFree || 0;
        const gUsed = gTotal && gFree ? Math.max(0, gTotal - gFree) : 0;
        gpuStats = {
          name: controller.name || controller.model || 'GPU',
          gpuPercent: controller.utilizationGpu || 0,
          memPercent: gTotal ? Math.round((gUsed / gTotal) * 100) : 0,
          memUsedGb: gUsed ? parseFloat((gUsed / 1024).toFixed(2)) : 0,
          memTotalGb: gTotal ? parseFloat((gTotal / 1024).toFixed(1)) : 0,
          temp: controller.temperatureGpu || null,
          powerDraw: controller.powerDraw || null,
        };
      }
    } catch {}
  }

  const result = {
    cpuPercent: Math.round(cpuLoad.currentLoad || 0),
    memPercent: memTotalBytes > 1 ? Math.round((memUsedBytes / memTotalBytes) * 100) : 0,
    memUsedGb: parseFloat(memUsedGb.toFixed(1)),
    memTotalGb: parseFloat(memTotalGb.toFixed(1)),
    memFreeGb: parseFloat(memFreeGb.toFixed(1)),
    gpu: gpuStats,
  };
      _liveStatsCache = result;
      _liveStatsCacheTime = Date.now();
      return result;
    } catch (err) {
      return _liveStatsCache || { cpuPercent: 0, memPercent: 0, memUsedGb: 0, memTotalGb: 0, memFreeGb: 0, gpu: null };
    } finally {
      _liveStatsPending = null;
    }
  })();

  return _liveStatsPending;
}

module.exports = { getHardwareSpecs, getLiveStats };
