'use strict';
const si = require('systeminformation');

async function getHardwareSpecs() {
  const [cpu, mem, graphics, os] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.graphics(),
    si.osInfo(),
  ]);

  // Pick the most powerful GPU (prefer NVIDIA/AMD discrete over integrated)
  const controllers = graphics.controllers || [];
  const discrete = controllers.find(c =>
    /nvidia|amd|radeon/i.test(c.vendor) &&
    !/integrated|internal/i.test(c.model)
  );
  const bestGpu = discrete || controllers[0];
  const gpuName = bestGpu
    ? `${bestGpu.vendor} ${bestGpu.model}`.replace(/\s+/g, ' ').trim()
    : 'None';

  return {
    cpuModel:   `${cpu.manufacturer} ${cpu.brand} (${cpu.cores} Cores)`,
    cpuCores:   cpu.cores,
    totalRamGB: Math.round(mem.total / (1024 ** 3)),
    gpuName,
    gpuVram:    bestGpu ? Math.round((bestGpu.vram || 0) / 1024) + ' GB' : '—',
    hasCuda:    /nvidia/i.test(gpuName),
    os:         `${os.distro || os.platform} ${os.release || ''}`.trim(),
    arch:       os.arch,
    controllers,
  };
}

async function getLiveStats() {
  const [load, mem] = await Promise.all([
    si.currentLoad(),
    si.mem(),
  ]);
  return {
    cpuLoad:     Math.round(load.currentLoad),
    ramUsedGB:   +(mem.active / (1024 ** 3)).toFixed(1),
    ramTotalGB:  +(mem.total  / (1024 ** 3)).toFixed(1),
    ramPct:      Math.round((mem.active / mem.total) * 100),
  };
}

async function runBenchmark() {
  // Non-blocking: yield to event loop between iterations
  return new Promise(resolve => {
    let ops = 0;
    const end = Date.now() + 2000;
    function tick() {
      const slice = Date.now() + 50; // 50ms slice
      while (Date.now() < slice && Date.now() < end) {
        let a = Math.random(), b = Math.random();
        for (let i = 0; i < 1000; i++) a = a * b + b;
        ops++;
      }
      if (Date.now() < end) setImmediate(tick);
      else resolve(Math.min(Math.floor(ops * 8), 10000));
    }
    tick();
  });
}

module.exports = { getHardwareSpecs, getLiveStats, runBenchmark };
