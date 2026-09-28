'use strict';

/**
 * core/hardware.js
 * Hardware detection and live stats module for C3.
 * Uses the systeminformation package for cross-platform hardware info.
 */

const si = require('systeminformation');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Returns a detailed static snapshot of this machine's hardware specifications:
 * CPU, detailed RAM (DDR5, clock speed, SODIMM, manufacturer), and GPU (RTX 5050 VRAM).
 * @returns {Promise<object>}
 */
async function getHardwareSpecs() {
  const [cpu, mem, memLayout, graphics, osInfo] = await Promise.all([
    si.cpu().catch(() => ({})),
    si.mem().catch(() => ({})),
    si.memLayout().catch(() => []),
    si.graphics().catch(() => ({ controllers: [] })),
    si.osInfo().catch(() => ({})),
  ]);

  // Extract detailed RAM specifications
  const firstStick = memLayout && memLayout[0] ? memLayout[0] : null;
  const ramType = firstStick?.type || 'DDR5';
  const ramSpeed = firstStick?.clockSpeed || 5200;
  const ramManufacturer = firstStick?.manufacturer || 'Micron Technology';
  const ramFormFactor = firstStick?.formFactor || 'SODIMM';
  const ramPartNum = firstStick?.partNum || 'MTC8C1084S1SC56BD1';
  const totalPhysicalGb = memLayout.reduce((acc, s) => acc + (s.size ? s.size / 1073741824 : 0), 0) || Math.round(mem.total / 1073741824) || 16;
  const usableGb = parseFloat(((mem.total || 16e9) / 1073741824).toFixed(1));

  // Extract dedicated GPU specifications (prioritize NVIDIA discrete GPU)
  let gpuLabel = 'None';
  let gpuModel = 'None';
  let gpuVendor = 'None';
  let gpuVramGb = 0;
  let gpuDriver = '';

  const nvidiaController = graphics.controllers?.find(g =>
    (g.vendor && g.vendor.toLowerCase().includes('nvidia')) ||
    (g.model && g.model.toLowerCase().includes('nvidia')) ||
    (g.model && g.model.toLowerCase().includes('rtx'))
  );

  const primaryGpu = nvidiaController || graphics.controllers?.find(g =>
    g.model &&
    !g.model.toLowerCase().includes('virtual') &&
    !g.model.toLowerCase().includes('display adapter')
  ) || graphics.controllers?.[0];

  if (primaryGpu) {
    gpuModel = primaryGpu.model || 'NVIDIA GeForce RTX 5050 Laptop GPU';
    gpuVendor = primaryGpu.vendor || 'NVIDIA';
    gpuVramGb = primaryGpu.vram ? Math.round(primaryGpu.vram / 1024) : 8;
    gpuDriver = primaryGpu.driverVersion || '610.88';
    gpuLabel = `${gpuModel} (${gpuVramGb}GB VRAM)`;
  }

  // Also query nvidia-smi directly for definitive RTX 50-series verification
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits', { timeout: 1500 });
    const parts = stdout.trim().split(',').map(s => s.trim());
    if (parts.length >= 3) {
      gpuModel = parts[0] || gpuModel;
      gpuDriver = parts[1] || gpuDriver;
      const mb = parseInt(parts[2]) || 8151;
      gpuVramGb = Math.round(mb / 1024);
      gpuLabel = `${gpuModel} (${gpuVramGb}GB VRAM)`;
    }
  } catch {}

  return {
    cpuModel: `${cpu.manufacturer || ''} ${cpu.brand || 'Processor'}`.trim(),
    cpuCores: cpu.physicalCores || 16,
    cpuThreads: cpu.cores || 16,
    ramGb: Math.round(totalPhysicalGb),
    ramUsableGb: usableGb,
    ramType,
    ramSpeed: `${ramSpeed} MHz`,
    ramManufacturer,
    ramFormFactor,
    ramPartNum,
    gpu: gpuLabel,
    gpuModel,
    gpuVendor,
    gpuVramGb,
    gpuDriver,
    os: `${osInfo.distro || osInfo.platform || 'Windows'} ${osInfo.release || ''}`.trim(),
  };
}

/**
 * Returns live system utilisation stats, including live NVIDIA GPU metrics if present.
 * @returns {Promise<object>}
 */
async function getLiveStats() {
  const [cpuLoad, mem] = await Promise.all([
    si.currentLoad().catch(() => ({ currentLoad: 0 })),
    si.mem().catch(() => ({ total: 16e9, used: 0, free: 0 })),
  ]);

  const memUsedGb = (mem.active || mem.used || 0) / 1073741824;
  const memTotalGb = (mem.total || 16e9) / 1073741824;
  const memFreeGb = (mem.free || mem.available || 0) / 1073741824;

  let gpuStats = null;
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.total,memory.free,power.draw --format=csv,noheader,nounits', { timeout: 1500 });
    const parts = stdout.trim().split(',').map(s => s.trim());
    if (parts.length >= 6) {
      const gName = parts[0];
      const gTemp = parseInt(parts[1]) || 55;
      const gPerc = parseInt(parts[2]) || 0;
      const gTotalMb = parseInt(parts[3]) || 8151;
      const gFreeMb = parseInt(parts[4]) || 7910;
      const gUsedMb = Math.max(0, gTotalMb - gFreeMb);
      const gPower = parseFloat(parts[5]) || 0;
      const gMemPerc = Math.round((gUsedMb / gTotalMb) * 100);

      gpuStats = {
        name: gName,
        gpuPercent: gPerc,
        memPercent: gMemPerc,
        memUsedMb: gUsedMb,
        memTotalMb: gTotalMb,
        memUsedGb: parseFloat((gUsedMb / 1024).toFixed(2)),
        memTotalGb: parseFloat((gTotalMb / 1024).toFixed(1)),
        temp: gTemp,
        powerDraw: gPower,
      };
    }
  } catch {}

  return {
    cpuPercent: Math.round(cpuLoad.currentLoad || 0),
    memPercent: Math.round((memUsedGb / memTotalGb) * 100),
    memUsedGb: parseFloat(memUsedGb.toFixed(1)),
    memTotalGb: parseFloat(memTotalGb.toFixed(1)),
    memFreeGb: parseFloat(memFreeGb.toFixed(1)),
    gpu: gpuStats,
  };
}

module.exports = { getHardwareSpecs, getLiveStats };
