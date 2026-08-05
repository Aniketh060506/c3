import React, { useState } from 'react';

const ENVS = [
  { id: 'ubuntu', label: '🐧 Ubuntu Base' },
  { id: 'pytorch', label: '🤖 AI/ML PyTorch' },
  { id: 'data', label: '📊 Data Science' },
  { id: 'cpp', label: '⚙️ Systems C++' }
];

export default function SessionRequestModal({ provider, onCancel, onConfirm }) {
  const [environment, setEnvironment] = useState('ubuntu');
  const [cpuCores, setCpuCores] = useState(1);
  const [ramGb, setRamGb] = useState(1);
  const [durationHours, setDurationHours] = useState(1);
  const [cudaRequested, setCudaRequested] = useState(false);

  const maxCpu = provider.cpuCores || 4;
  const maxRam = provider.totalRamGB || 8;
  const hasGpu = provider.gpuName && (provider.gpuName.includes('NVIDIA') || provider.gpuName.includes('AMD'));
  
  const cost = durationHours * 10;

  return (
    <div className="overlay">
      <div className="modal">
        <h2 style={{ marginBottom: '6px' }}>Request Session</h2>
        <p className="text-color-secondary font-sm" style={{ marginBottom: '24px' }}>
          Configuring node: <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{provider.displayName}</span>
        </p>

        <div className="fcol g4">
          <div>
            <label className="input-label">Environment</label>
            <div className="grid4" style={{ gap: '10px' }}>
              {ENVS.map(env => (
                <div 
                  key={env.id} 
                  className={`env-pick ${environment === env.id ? 'sel' : ''}`}
                  onClick={() => setEnvironment(env.id)}
                >
                  <div style={{ fontSize: '11px', fontWeight: 600 }}>{env.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="slider-row">
              <label className="input-label" style={{ margin: 0 }}>CPU Cores</label>
              <div className="slider-val">{cpuCores} / {maxCpu}</div>
            </div>
            <input 
              type="range" 
              min="1" 
              max={maxCpu} 
              value={cpuCores} 
              onChange={e => setCpuCores(parseInt(e.target.value))} 
            />
          </div>

          <div>
            <div className="slider-row">
              <label className="input-label" style={{ margin: 0 }}>RAM Allocation</label>
              <div className="slider-val">{ramGb} GB / {maxRam} GB</div>
            </div>
            <input 
              type="range" 
              min="1" 
              max={maxRam} 
              value={ramGb} 
              onChange={e => setRamGb(parseInt(e.target.value))} 
            />
          </div>

          <div>
            <label className="input-label">Duration</label>
            <div className="flex g2">
              {[1, 2, 4, 8].map(h => (
                <button 
                  key={h}
                  className={`btn f1 ${durationHours === h ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setDurationHours(h)}
                >
                  {h}h
                </button>
              ))}
            </div>
          </div>

          {hasGpu && (
            <div className="flex ac jsb" style={{ padding: '12px', background: 'var(--card2)', borderRadius: 'var(--rsm)', border: '1px solid var(--br)' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>Request CUDA / GPU Access</div>
                <div style={{ fontSize: '11px', color: 'var(--t3)' }}>Hardware: {provider.gpuName}</div>
              </div>
              <div 
                className={`tgl-track ${cudaRequested ? 'on' : ''}`}
                onClick={() => setCudaRequested(!cudaRequested)}
              >
                <div className="tgl-thumb"></div>
              </div>
            </div>
          )}

          <div className="divider"></div>

          <div className="flex ac jsb">
            <div>
              <div className="metric-lbl">ESTIMATED COST</div>
              <div className="metric-num" style={{ fontSize: '20px' }}>{cost} <span style={{ fontSize: '12px', color: 'var(--t3)' }}>C3 Credits</span></div>
            </div>
            <div className="flex g2">
              <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
              <button 
                className="btn btn-primary" 
                onClick={() => onConfirm({ environment, cpuCores, ramGb, durationHours, cudaRequested })}
              >
                Send Request
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
