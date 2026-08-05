import React, { useState, useEffect, useRef } from 'react';

export default function SSHWorkspace({ sessionId, provider, onEnd }) {
  const [files, setFiles] = useState([]);
  const [currentPath, setCurrentPath] = useState('/workspace');
  const [telemetry, setTelemetry] = useState({ cpu: 0, ram: 0 });
  const [elapsed, setElapsed] = useState('00:00:00');
  const termRef = useRef(null);
  const startTime = useRef(Date.now());
  const xtermObj = useRef(null);
  const fitAddonObj = useRef(null);

  useEffect(() => {
    // Dynamic import for xterm to avoid SSR issues if any, but since this is Vite/Electron it should be fine.
    // For this context we assume standard import works, but if not installed it'll throw. 
    // We will use standard dynamic import just in case.
    let term, fit;
    const initTerm = async () => {
      try {
        const { Terminal } = await import('xterm');
        const { FitAddon } = await import('@xterm/addon-fit');
        // import 'xterm/css/xterm.css'; // Usually needed but we style container
        
        term = new Terminal({
          theme: { background:'#000000', foreground:'#e4e4e7', cursor:'#fafafa', cursorAccent:'#000' },
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
          lineHeight: 1.4,
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(termRef.current);
        fit.fit();
        
        xtermObj.current = term;
        fitAddonObj.current = fit;

        term.onData(d => {
          if (window.c3?.sendTerminalInput) window.c3.sendTerminalInput(d);
        });

        const resizeObserver = new ResizeObserver(() => {
          fit.fit();
          if (window.c3?.resizeTerminal) {
            window.c3.resizeTerminal(term.cols, term.rows);
          }
        });
        resizeObserver.observe(termRef.current);
        
        if (window.c3) {
          if (window.c3.connectSSH) window.c3.connectSSH(sessionId);
          window.c3.onTerminalData?.(data => term.write(data));
          window.c3.onTelemetryUpdate?.(m => setTelemetry(m));
          window.c3.onTerminalClosed?.(() => onEnd());
          
          if (window.c3.listFiles) {
            window.c3.listFiles(currentPath).then(res => setFiles(res || []));
          }
        } else {
          term.write('C3 Desktop environment required. Connection simulating...\r\n$ ');
        }
      } catch (e) {
        console.error("Failed to load xterm", e);
      }
    };
    
    initTerm();

    const timer = setInterval(() => {
      const diff = Math.floor((Date.now() - startTime.current) / 1000);
      const h = String(Math.floor(diff / 3600)).padStart(2, '0');
      const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
      const s = String(diff % 60).padStart(2, '0');
      setElapsed(`${h}:${m}:${s}`);
    }, 1000);

    return () => {
      clearInterval(timer);
      if (term) term.dispose();
    };
  }, [sessionId, currentPath, onEnd]);

  useEffect(() => {
    if (window.c3?.listFiles) {
      window.c3.listFiles(currentPath).then(res => setFiles(res || []));
    }
  }, [currentPath]);

  const handleDownload = (fileName) => {
    if (window.c3?.downloadFile) {
      window.c3.downloadFile(`${currentPath}/${fileName}`, fileName);
    }
  };

  return (
    <div className="full fcol">
      <div className="flex ac jsb" style={{ height: '58px', padding: '0 20px', borderBottom: '1px solid var(--br)', background: 'var(--card)' }}>
        <div className="flex ac g3">
          <div className="dot dot-g"></div>
          <div style={{ fontWeight: 600 }}>Connected to {provider?.displayName || 'Node'}</div>
          <div className="badge badge-w">⏱ {elapsed}</div>
        </div>
        
        <div className="flex ac g4" style={{ flex: 1, maxWidth: '400px' }}>
          <div className="f1 flex ac g2">
            <span className="font-sm text-color-tertiary">CPU</span>
            <div className="ptrack f1"><div className="pfill green" style={{ width: `${telemetry.cpu}%` }}></div></div>
            <span className="font-sm font-weight-bold">{telemetry.cpu}%</span>
          </div>
          <div className="f1 flex ac g2">
            <span className="font-sm text-color-tertiary">RAM</span>
            <div className="ptrack f1"><div className="pfill amber" style={{ width: `${(telemetry.ram / (provider?.totalRamGB || 16))*100}%` }}></div></div>
            <span className="font-sm font-weight-bold">{telemetry.ram}GB</span>
          </div>
        </div>
        
        <div className="flex g2">
          <button className="btn btn-ghost btn-sm">Upload</button>
          <button className="btn btn-danger btn-sm" onClick={onEnd}>End Session</button>
        </div>
      </div>

      <div className="f1 flex frow" style={{ overflow: 'hidden' }}>
        <div className="f1" style={{ flexBasis: '60%', padding: '16px', display: 'flex' }}>
          <div className="term-shell f1">
            <div className="term-bar">
              <div className="flex ac g2">
                <div className="mac-dot r"></div>
                <div className="mac-dot y"></div>
                <div className="mac-dot g"></div>
              </div>
              <div className="font-sm text-color-tertiary" style={{ fontFamily: 'monospace' }}>ubuntu@node:~</div>
            </div>
            <div ref={termRef} className="f1" style={{ padding: '10px' }}></div>
          </div>
        </div>
        
        <div style={{ flexBasis: '40%', borderLeft: '1px solid var(--br)', display: 'flex', flexDirection: 'column', background: 'var(--card2)' }}>
          <div className="flex ac g2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--br)' }}>
            <div className="font-sm text-color-tertiary">Path:</div>
            <div className="font-sm font-weight-medium" style={{ fontFamily: 'monospace' }}>{currentPath}</div>
          </div>
          
          <div className="f1 scroll" style={{ padding: '12px' }}>
            {!window.c3 && (
              <div className="text-center font-sm text-color-tertiary" style={{ margin: '20px' }}>
                File manager unavailable in browser mock mode.
              </div>
            )}
            
            {currentPath !== '/' && currentPath !== '/workspace' && window.c3 && (
              <div className="file-row" onClick={() => {
                const parts = currentPath.split('/');
                parts.pop();
                setCurrentPath(parts.join('/') || '/');
              }}>
                📁 <span style={{ marginLeft: '6px' }}>..</span>
              </div>
            )}
            
            {files.map((f, i) => (
              <div key={i} className="file-row jsb" onClick={() => f.isDirectory && setCurrentPath(`${currentPath}/${f.name}`.replace('//', '/'))}>
                <div className="flex ac">
                  {f.isDirectory ? '📁' : '📄'} 
                  <span style={{ marginLeft: '10px' }}>{f.name}</span>
                </div>
                {!f.isDirectory && (
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); handleDownload(f.name); }}>↓</button>
                )}
              </div>
            ))}

            <div className="drop-zone" style={{ marginTop: '20px' }}>
              Drag & Drop files here to upload to {currentPath}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
