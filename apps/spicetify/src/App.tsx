import { BridgeClient } from './bridge';
import type { TrackInfo } from '@vaporzr/shared';

const { useState, useEffect, useRef } = Spicetify.React;

function fmtMs(ms: number): string {
  if (!ms || ms < 0) return '0:00';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function NowPlaying({ bridge }: { bridge: BridgeClient }) {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    bridge.onState = update;
    bridge.onQueue = update;
    return () => {
      bridge.onState = () => {};
      bridge.onQueue = () => {};
    };
  }, [bridge]);

  const p = bridge.playback;
  const track = p?.track;
  const dur = p?.durationMs ?? 0;
  const pos = p?.positionMs ?? 0;
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;

  return (
    <div className="vz-now">
      <div className="vz-art">
        {track?.image ? (
          <img src={track.image} alt="" />
        ) : (
          <div className="vz-art-placeholder">◈</div>
        )}
      </div>
      <div className="vz-now-info">
        <div className="vz-now-track">{track?.name ?? 'Nothing playing'}</div>
        <div className="vz-now-artist">{track?.artists.join(', ') ?? 'Queue something in Discord with /play'}</div>
        <div className="vz-now-meta">
          {track?.album ? <span>{track.album}</span> : null}
          <span className={p?.playing ? 'vz-badge vz-playing' : 'vz-badge'}>{p?.playing ? 'PLAYING' : 'PAUSED'}</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={pct}
          className="vz-slider vz-seek"
          onChange={(e) => bridge.seekTo(Number(e.target.value))}
        />
        <div className="vz-times">
          <span>{fmtMs(pos)}</span>
          <span>{fmtMs(dur)}</span>
        </div>
      </div>
    </div>
  );
}

function Transport({ bridge }: { bridge: BridgeClient }) {
  return (
    <div className="vz-transport">
      <button
        className="vz-btn vz-btn-ghost"
        onClick={() => bridge.cmd({ type: 'cmd', command: 'previous' })}
        title="Previous"
      >
        ⏮
      </button>
      <button
        className="vz-btn vz-btn-primary"
        onClick={() => bridge.cmd({ type: 'cmd', command: bridge.playback?.playing ? 'pause' : 'resume' })}
        title={bridge.playback?.playing ? 'Pause' : 'Play'}
      >
        {bridge.playback?.playing ? '⏸' : '▶'}
      </button>
      <button
        className="vz-btn vz-btn-ghost"
        onClick={() => bridge.cmd({ type: 'cmd', command: 'next' })}
        title="Next"
      >
        ⏭
      </button>
    </div>
  );
}

function Volume({ bridge }: { bridge: BridgeClient }) {
  const vol = bridge.playback?.volume ?? 100;
  return (
    <div className="vz-volume">
      <span>🔈</span>
      <input
        type="range"
        min={0}
        max={100}
        value={vol}
        className="vz-slider"
        onChange={(e) => bridge.cmd({ type: 'cmd', command: 'volume', volume: Number(e.target.value) })}
      />
      <span>{vol}%</span>
    </div>
  );
}

function Queue({ bridge }: { bridge: BridgeClient }) {
  const [, force] = useState(0);
  useEffect(() => {
    bridge.onQueue = () => force((n) => n + 1);
    return () => {
      bridge.onQueue = () => {};
    };
  }, [bridge]);

  const queue = bridge.queue;
  if (queue.length === 0) return <div className="vz-empty">Queue is empty — use /play in Discord.</div>;

  return (
    <div className="vz-queue">
      {queue.map((t: TrackInfo, i: number) => (
        <div className={`vz-queue-item${i === bridge.currentIndex ? ' vz-current' : ''}`} key={`${t.uri}-${i}`}>
          <button className="vz-queue-play" onClick={() => bridge.cmd({ type: 'cmd', command: 'playAt', index: i })}>
            {i === bridge.currentIndex ? '▶' : '•'}
          </button>
          <div className="vz-queue-info">
            <div className="vz-queue-name">{t.name}</div>
            <div className="vz-queue-sub">
              {t.artists.join(', ')} · {fmtMs(t.durationMs)} · by {t.addedBy}
            </div>
          </div>
          <button
            className="vz-btn vz-btn-remove"
            onClick={() => bridge.cmd({ type: 'cmd', command: 'remove', index: i })}
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function Visuals({ bridge }: { bridge: BridgeClient }) {
  const [enabled, setEnabled] = useState(true);
  const [frame, setFrame] = useState<string | null>(null);
  const [preview, setPreview] = useState(true);

  useEffect(() => {
    bridge.onVisuals = (f) => {
      if (enabled) setFrame(f);
    };
    return () => {
      bridge.onVisuals = () => {};
    };
  }, [bridge, enabled]);

  return (
    <div className="vz-visuals">
      <div className="vz-visuals-head">
        <span className="vz-visuals-title">◈ projectM VISUALS</span>
        <div className="vz-visuals-actions">
          <button className={`vz-btn vz-btn-small${preview ? ' vz-active' : ''}`} onClick={() => setPreview((v) => !v)}>
            {preview ? 'Hide' : 'Preview'}
          </button>
          <button className={`vz-btn vz-btn-small${enabled ? ' vz-active' : ''}`} onClick={() => setEnabled((v) => !v)}>
            {enabled ? 'On' : 'Off'}
          </button>
        </div>
      </div>
      <div className="vz-visuals-frame">
        {enabled && preview && frame ? (
          <img src={frame} alt="visuals" className="vz-visuals-img" />
        ) : (
          <div className="vz-visuals-placeholder">
            <div className="vz-eq">
              <span /><span /><span /><span /><span /><span />
            </div>
            <div className="vz-visuals-hint">
              {enabled ? 'Waiting for the visualizer stream…' : 'Visuals disabled'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const bridgeRef = useRef<BridgeClient | null>(null);
  if (!bridgeRef.current) bridgeRef.current = new BridgeClient();
  const bridge = bridgeRef.current;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    bridge.onConnection = setConnected;
    return () => {
      bridge.onConnection = () => {};
    };
  }, [bridge]);

  return (
    <div className={`vz-root${connected ? '' : ' vz-offline'}`}>
      <div className="vz-grid" />
      <div className="vz-artwork" />
      <div className="vz-content">
        <header className="vz-header">
          <div className="vz-logo">
            <img className="vz-logo-img" src="./logo.png" alt="Vaporzr" />
            <div>
              <div className="vz-logo-text">VAPORZR</div>
              <div className="vz-logo-sub">SHARED PLAYBACK CONTROL</div>
            </div>
          </div>
          <div className={`vz-status${connected ? ' vz-status-on' : ''}`}>
            <span className="vz-dot" />
            {connected ? 'LINKED' : 'DISCONNECTED'}
          </div>
        </header>

        <main className="vz-main">
          <section className="vz-card vz-now-card">
            <NowPlaying bridge={bridge} />
            <Transport bridge={bridge} />
            <Volume bridge={bridge} />
          </section>

          <section className="vz-card">
            <h2 className="vz-section-title">QUEUE</h2>
            <Queue bridge={bridge} />
          </section>

          <section className="vz-card">
            <Visuals bridge={bridge} />
          </section>
        </main>

        <footer className="vz-footer">
          VAPORZR v0.1 · bridge at 127.0.0.1:{localStorage.getItem('vaporzr:port') ?? '4876'}
        </footer>
      </div>
    </div>
  );
}
