import { useEffect, useRef, useState } from 'react';
import type { SpeedResult } from '../lib/types.ts';
import { hasDownload, isMeasure, parseManualSpeed, runSpeedTest, type ManualSpeedInput, type SpeedField, type SpeedProgress } from '../lib/speedtest.ts';
import { fmtDateTime } from '../lib/util.ts';

export function SpeedTest({ value, onChange, minDown }: { value: SpeedResult | null; onChange: (v: SpeedResult) => void; minDown: number }) {
  const [live, setLive] = useState<SpeedProgress | null>(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);
  const [m, setM] = useState<ManualSpeedInput>({ down: '', up: '', ping: '' });
  const [fieldErr, setFieldErr] = useState<Partial<Record<SpeedField, string>>>({});
  const abort = useRef<AbortController | null>(null);

  // Leaving the section (or the page) stops a running test, so it can't write into a closed section later.
  useEffect(() => () => abort.current?.abort(), []);

  const run = async () => {
    setError('');
    const ctl = new AbortController();
    abort.current = ctl;
    setLive({ phase: 'ping' });
    try {
      const r = await runSpeedTest((p) => !ctl.signal.aborted && setLive({ ...p }), ctl.signal);
      if (ctl.signal.aborted) return;
      onChange({ down: r.down!, up: isMeasure(r.up) ? r.up : null, ping: isMeasure(r.ping) ? r.ping : null, server: r.server, method: 'auto', at: new Date().toISOString() });
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && !ctl.signal.aborted)
        setError(`The test didn’t finish (${(e as Error).message || 'no connection'}). Nothing was saved — check the connection and run it again, or enter the numbers from fast.com by hand.`);
    } finally {
      if (abort.current === ctl) abort.current = null;
      setLive(null);
    }
  };

  const saveManual = () => {
    const r = parseManualSpeed(m);
    if (!r.ok) return setFieldErr(r.errors);
    setFieldErr({});
    onChange({ ...r.value, method: 'manual', at: new Date().toISOString() });
    setManual(false);
  };

  const shown = live ?? value;
  const num = (v: number | null | undefined) => (!isMeasure(v) ? '—' : v >= 100 ? Math.round(v) : v);
  const low = hasDownload(value) && value.down < minDown;

  return (
    <div className="speed">
      <div className="speed-nums">
        <div>
          <span className="label">Download</span>
          <strong className={live?.phase === 'download' ? 'pulse' : low && !live ? 'warn' : ''}>{num(shown?.down)}</strong>
          <span className="unit">Mbps</span>
        </div>
        <div>
          <span className="label">Upload</span>
          <strong className={live?.phase === 'upload' ? 'pulse' : ''}>{num(shown?.up)}</strong>
          <span className="unit">Mbps</span>
        </div>
        <div>
          <span className="label">Ping</span>
          <strong className={live?.phase === 'ping' ? 'pulse' : ''}>{num(shown?.ping)}</strong>
          <span className="unit">ms</span>
        </div>
      </div>
      <div className="speed-foot">
        {live ? (
          <>
            <span className="label">Testing {live.phase}…</span>
            <button className="btn ghost" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          </>
        ) : (
          <>
            <span className="label">
              {value
                ? hasDownload(value)
                  ? `${value.method === 'auto' ? 'Measured' : 'Entered'} ${fmtDateTime(value.at)}${value.server ? ' · server ' + value.server : ''}`
                  : 'No download figure saved — run the test or enter it again'
                : 'Connect this phone to the venue network first'}
            </span>
            <div className="row">
              <button className="btn ghost" onClick={() => setManual((v) => !v)}>
                Enter manually
              </button>
              <button className="btn" onClick={run}>
                {value ? 'Run again' : 'Run speed test'}
              </button>
            </div>
          </>
        )}
      </div>
      {error && <p className="hint warn">{error}</p>}
      {manual && !live && (
        <p className="hint speed-hint">
          Can’t run it here? Open{' '}
          <a href="https://fast.com" target="_blank" rel="noreferrer">
            fast.com
          </a>{' '}
          on the venue network, type what it shows, and add a screenshot below.
        </p>
      )}
      {manual && !live && (
        <div className="speed-manual">
          {(['down', 'up', 'ping'] as const).map((k) => (
            <label key={k} className="field">
              <span className="label">{k === 'ping' ? 'Ping ms (optional)' : k === 'down' ? 'Down Mbps' : 'Up Mbps (optional)'}</span>
              <input
                inputMode="decimal"
                value={m[k]}
                aria-invalid={!!fieldErr[k]}
                onChange={(e) => {
                  setM({ ...m, [k]: e.target.value });
                  if (fieldErr[k]) setFieldErr({ ...fieldErr, [k]: undefined });
                }}
              />
              {fieldErr[k] && <span className="field-error">{fieldErr[k]}</span>}
            </label>
          ))}
          <button className="btn" onClick={saveManual}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}
