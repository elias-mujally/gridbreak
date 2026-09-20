import { useState } from 'react';
import type { Difficulty, GameMode, NewGameOptions } from '../game/state';
import { MAP_CONFIGS, MAP_IDS, MapId, RaceLayout, compatibleLayouts } from '../game/modes';

export default function ModePicker({ onStart }: { onStart: (options: NewGameOptions, difficulty: Difficulty) => void }) {
  const [mode, setMode] = useState<GameMode>('classic');
  const [mapId, setMapId] = useState<MapId>('sprint');
  const [layout, setLayout] = useState<RaceLayout>('opposite');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [lockSeed, setLockSeed] = useState(false);
  const [seedText, setSeedText] = useState('');
  const [error, setError] = useState('');
  const map = MAP_CONFIGS[mapId];
  const layouts = compatibleLayouts(map);

  function selectMap(id: MapId) {
    setMapId(id);
    if (!MAP_CONFIGS[id].layouts[layout]) setLayout(MAP_CONFIGS[id].defaultLayout);
  }

  function start() {
    const parsed = seedText.trim() ? Number(seedText) : NaN;
    if (mode === 'rush' && lockSeed && (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff)) {
      setError('Enter a whole debug seed from 0 to 4,294,967,295.'); return;
    }
    onStart({ mode, mapId, layout, ...(mode === 'rush' && lockSeed ? { seed: parsed, seedLocked: true } : {}) }, difficulty);
  }

  return <div className="mode-screen">
    <header className="topbar"><div className="brand" aria-label="GridBreak"><span className="brand-mark"><i /><i /><i /><i /></span><span>GRID<span className="brand-light">BREAK</span></span></div><span className="edition">TACTICAL RACE / 02.2</span></header>
    <main className="mode-content">
      <div className="eyebrow"><span className="signal-dot" /> MODE → MAP → DIFFICULTY → START</div>
      <h1>Choose your<br /><em>front.</em></h1>
      <p>Every map supports the same engine. Classic keeps the pure race; Rush adds scarce tactical resources.</p>
      <div className="mode-cards" role="group" aria-label="Game mode">
        <button className={`mode-card ${mode === 'classic' ? 'chosen' : ''}`} onClick={() => setMode('classic')} aria-pressed={mode === 'classic'}>
          <span className="mode-number">01 / CLASSIC</span><span className="mode-glyph classic-glyph" aria-hidden="true"><i /><i /><i /><i /></span>
          <strong>Pure strategy.</strong><span>Movement, collision jumps, and walls on any compatible map.</span><small>NO RUSH RESOURCES</small>
        </button>
        <button className={`mode-card rush-card ${mode === 'rush' ? 'chosen' : ''}`} onClick={() => setMode('rush')} aria-pressed={mode === 'rush'}>
          <span className="mode-number">02 / RUSH</span><span className="mode-glyph rush-glyph" aria-hidden="true">↗<i /></span>
          <strong>Controlled pressure.</strong><span>Assists, rewards, Break, Phantom, Momentum, and a closing clock.</span><small>TACTICAL RULES ENABLED</small>
        </button>
      </div>
      <section className="map-picker" aria-label="Map selection">
        <div className="map-picker-heading"><strong>SELECT MAP</strong><span>Shared by Classic and Rush.</span></div>
        <div className="map-options">{MAP_IDS.map(id => { const option = MAP_CONFIGS[id]; return <button key={id} className={mapId === id ? 'chosen' : ''} onClick={() => selectMap(id)} aria-pressed={mapId === id}><strong>{option.name}</strong><span>{option.width}×{option.height}</span></button>; })}</div>
        {layouts.length > 1 && <><div className="map-picker-heading layout-heading"><strong>RACE LAYOUT</strong><span>Spawn and goal geometry.</span></div><div className="layout-options" role="group" aria-label="Race layout">{layouts.map(id => <button key={id} className={layout === id ? 'chosen' : ''} onClick={() => setLayout(id)} aria-pressed={layout === id}><strong>{id === 'opposite' ? 'Opposite' : 'Parallel'}</strong><span>{id === 'opposite' ? 'Race across each other' : mapId === 'wide' ? 'Same right edge → left' : 'Same bottom edge → top'}</span></button>)}</div></>}
        <div className="map-picker-heading layout-heading"><strong>DIFFICULTY</strong><span>Local AI behavior.</span></div>
        <div className="setup-difficulty" role="group" aria-label="Difficulty">{(['easy', 'normal', 'hard'] as const).map(level => <button key={level} className={difficulty === level ? 'chosen' : ''} onClick={() => setDifficulty(level)} aria-pressed={difficulty === level}>{level}</button>)}</div>
      </section>
      {mode === 'rush' && <>
        <label className="seed-lock"><input type="checkbox" checked={lockSeed} onChange={event => { setLockSeed(event.target.checked); setError(''); }} /><span><strong>Lock debugging seed</strong><small>Leave off for a fresh map every match.</small></span></label>
        {lockSeed && <label className="seed-input">DEBUG SEED <span>Identical seeds reproduce identical rewards</span><input type="number" min="0" max="4294967295" value={seedText} onChange={event => { setSeedText(event.target.value); setError(''); }} placeholder="Enter seed" /></label>}
      </>}
      {error && <p className="mode-error" role="alert">{error}</p>}
      <button className="start-button" onClick={start}>Start {map.name} · {layout === 'parallel' ? 'Parallel' : 'Opposite'} <span>↗</span></button>
    </main>
    <footer className="footer"><span>GRIDBREAK / PLAYTEST CORRECTIONS</span><span>ONE GRID. MANY FRONTS.</span></footer>
  </div>;
}

