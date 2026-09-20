import { useState } from 'react';
import type { ControllerSelection, Difficulty, GameMode, NewGameOptions } from '../game/state';
import { MAP_CONFIGS, MAP_IDS, type ConvergencePlayerCount, type MapId, type RaceLayout, compatibleLayouts, mapDimensions, mapSupportsMode, unsupportedMapReason } from '../game/modes';

const levels: Difficulty[] = ['easy', 'normal', 'hard'];
const defaultControllers = (): ControllerSelection[] => [
  { type: 'HUMAN_LOCAL' }, { type: 'AI', difficulty: 'normal' },
  { type: 'AI', difficulty: 'normal' }, { type: 'AI', difficulty: 'normal' },
];

export default function ModePicker({ onStart, onOnline }: { onStart: (options: NewGameOptions, difficulty: Difficulty) => void; onOnline: () => void }) {
  const [mode, setMode] = useState<GameMode>('classic');
  const [mapId, setMapId] = useState<MapId>('sprint');
  const [layout, setLayout] = useState<RaceLayout>('opposite');
  const [playerCount, setPlayerCount] = useState<ConvergencePlayerCount>(4);
  const [controllers, setControllers] = useState<ControllerSelection[]>(defaultControllers);
  const [lockSeed, setLockSeed] = useState(false);
  const [seedText, setSeedText] = useState('');
  const [error, setError] = useState('');
  const map = MAP_CONFIGS[mapId];
  const layouts = mode === 'convergence' ? [] : compatibleLayouts(map);
  const activeControllers = mode === 'convergence' ? controllers.slice(0, playerCount) : controllers.slice(0, 2);

  function updateController(index: number, selection: ControllerSelection) {
    setControllers(current => current.map((controller, slot) => slot === index ? selection : controller));
  }
  function selectMap(id: MapId) {
    if (!mapSupportsMode(id, mode)) return;
    const next = MAP_CONFIGS[id];
    setMapId(id);
    if (mode === 'convergence') {
      setLayout('convergence');
      if (!next.convergence!.supportedPlayerCounts.includes(playerCount)) setPlayerCount(next.convergence!.supportedPlayerCounts[0]);
    } else if (!next.layouts[layout]) setLayout(next.defaultLayout);
  }
  function selectMode(nextMode: GameMode) {
    setMode(nextMode); setError(''); setLockSeed(false);
    const nextMap = mapSupportsMode(mapId, nextMode) ? mapId : nextMode === 'convergence' ? 'grand' : 'sprint';
    setMapId(nextMap);
    if (nextMode === 'convergence') { setLayout('convergence'); setPlayerCount(nextMap === 'arena' ? 2 : 4); }
    else setLayout(MAP_CONFIGS[nextMap].defaultLayout);
    if (nextMode === 'rush') setControllers(current => current.map((item, index) => index === 0 ? { type: 'HUMAN_LOCAL' } : index === 1 ? { type: 'AI', difficulty: item.difficulty ?? 'normal' } : item));
  }
  function start() {
    const parsed = seedText.trim() ? Number(seedText) : NaN;
    if (mode === 'rush' && lockSeed && (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff)) {
      setError('Enter a whole debug seed from 0 to 4,294,967,295.'); return;
    }
    const selectedDifficulty = activeControllers.find(controller => controller.type === 'AI')?.difficulty ?? 'normal';
    onStart({ mode, mapId, layout: mode === 'convergence' ? 'convergence' : layout, controllers: activeControllers,
      ...(mode === 'convergence' ? { playerCount } : {}),
      ...(mode === 'rush' && lockSeed ? { seed: parsed, seedLocked: true } : {}) }, selectedDifficulty);
  }

  return <div className="mode-screen">
    <header className="topbar"><div className="brand" aria-label="GridBreak"><span className="brand-mark"><i /><i /><i /><i /></span><span>GRID<span className="brand-light">BREAK</span></span></div><span className="edition">TACTICAL RACE / 02.3</span></header>
    <main className="mode-content">
      <div className="eyebrow"><span className="signal-dot" /> MODE → MAP → LAYOUT → PLAYERS → CONTROLLERS</div>
      <h1>Choose your<br /><em>front.</em></h1>
      <p>One map catalog, with each legal geometry and controller setup shown before the match begins.</p>
      <div className="mode-cards" role="group" aria-label="Game mode">
        <button className={`mode-card ${mode === 'classic' ? 'chosen' : ''}`} onClick={() => selectMode('classic')} aria-pressed={mode === 'classic'}><span className="mode-number">01 / CLASSIC</span><span className="mode-glyph classic-glyph" aria-hidden="true"><i /><i /><i /><i /></span><strong>Pure strategy.</strong><span>Play the race against AI or a friend on the same device.</span><small>LOCAL 1V1</small></button>
        <button className={`mode-card rush-card ${mode === 'rush' ? 'chosen' : ''}`} onClick={() => selectMode('rush')} aria-pressed={mode === 'rush'}><span className="mode-number">02 / RUSH</span><span className="mode-glyph rush-glyph" aria-hidden="true">↗<i /></span><strong>Controlled pressure.</strong><span>Private Phantom information stays between you and the AI.</span><small>HUMAN VS AI</small></button>
        <button className={`mode-card convergence-card ${mode === 'convergence' ? 'chosen' : ''}`} onClick={() => selectMode('convergence')} aria-pressed={mode === 'convergence'}><span className="mode-number">03 / CONVERGENCE</span><span className="mode-glyph convergence-glyph" aria-hidden="true">◆<i /><i /><i /><i /></span><strong>Race to center.</strong><span>Mix local friends and tactical AI across two to four slots.</span><small>LOCAL MIXED CONTROL</small></button>
      </div>
      <button className="online-launch" onClick={onOnline}><span><small>04 / ONLINE V1</small><strong>PRIVATE CONVERGENCE ROOMS</strong><em>2–4 guests · authoritative server · reconnect</em></span><b>ONLINE ↗</b></button>
      <section className="map-picker" aria-label="Match setup">
        <div className="map-picker-heading"><strong>SELECT MAP</strong><span>Unsupported geometries remain visible and explicit.</span></div>
        <div className="map-options">{MAP_IDS.map(id => { const option = MAP_CONFIGS[id]; const supported = mapSupportsMode(id, mode); const dimensions = mapDimensions(id, mode); return <button key={id} className={`${mapId === id ? 'chosen' : ''} ${!supported ? 'unsupported' : ''}`} onClick={() => selectMap(id)} disabled={!supported} aria-pressed={mapId === id} title={unsupportedMapReason(id, mode) ?? undefined}><strong>{option.name}</strong><span>{supported ? `${dimensions.width}×${dimensions.height}` : unsupportedMapReason(id, mode)}</span></button>; })}</div>
        {layouts.length > 1 && <><div className="map-picker-heading layout-heading"><strong>RACE LAYOUT</strong><span>Spawn and goal geometry.</span></div><div className="layout-options" role="group" aria-label="Race layout">{layouts.map(id => <button key={id} className={layout === id ? 'chosen' : ''} onClick={() => setLayout(id)} aria-pressed={layout === id}><strong>{id === 'opposite' ? 'Opposite' : 'Parallel'}</strong><span>{id === 'opposite' ? 'Race across each other' : mapId === 'wide' ? 'Same right edge → left' : 'Same bottom edge → top'}</span></button>)}</div></>}
        {mode === 'convergence' && <><div className="map-picker-heading layout-heading"><strong>PLAYER COUNT</strong><span>Supported by this center geometry.</span></div><div className="setup-difficulty player-count-picker" role="group" aria-label="Player count">{map.convergence!.supportedPlayerCounts.map(count => <button key={count} className={playerCount === count ? 'chosen' : ''} onClick={() => setPlayerCount(count)} aria-pressed={playerCount === count}>{count} players</button>)}</div></>}
        <div className="map-picker-heading layout-heading"><strong>CONTROLLERS</strong><span>{mode === 'rush' ? 'Shared-screen Rush stays Human vs AI so Phantom Walls remain secret.' : 'Choose who controls each slot.'}</span></div>
        <div className="controller-slots">
          {activeControllers.map((controller, index) => <div className="controller-slot" key={index}><span><b>P{index + 1}</b><small>{index === 0 ? 'YOU' : controller.type === 'AI' ? `AI — ${(controller.difficulty ?? 'normal').toUpperCase()}` : 'LOCAL PLAYER'}</small></span>
            {index === 0 || mode === 'rush' ? <strong>{index === 0 ? 'Human' : 'AI'}</strong> : <div className="controller-choice" role="group" aria-label={`Player ${index + 1} controller`}><button className={controller.type === 'HUMAN_LOCAL' ? 'chosen' : ''} onClick={() => updateController(index, { type: 'HUMAN_LOCAL' })}>Local</button><button className={controller.type === 'AI' ? 'chosen' : ''} onClick={() => updateController(index, { type: 'AI', difficulty: controller.difficulty ?? 'normal' })}>AI</button></div>}
            {controller.type === 'AI' && <div className="slot-difficulty" role="group" aria-label={`Player ${index + 1} AI difficulty`}>{levels.map(level => <button key={level} className={(controller.difficulty ?? 'normal') === level ? 'chosen' : ''} onClick={() => updateController(index, { type: 'AI', difficulty: level })}>{level}</button>)}</div>}
          </div>)}
        </div>
      </section>
      {mode === 'rush' && <><label className="seed-lock"><input type="checkbox" checked={lockSeed} onChange={event => { setLockSeed(event.target.checked); setError(''); }} /><span><strong>Lock debugging seed</strong><small>Leave off for a fresh map every match.</small></span></label>{lockSeed && <label className="seed-input">DEBUG SEED <span>Identical seeds reproduce identical rewards</span><input type="number" min="0" max="4294967295" value={seedText} onChange={event => { setSeedText(event.target.value); setError(''); }} placeholder="Enter seed" /></label>}</>}
      {error && <p className="mode-error" role="alert">{error}</p>}
      <button className="start-button" onClick={start}>Start {map.name} · {mode === 'convergence' ? `${playerCount} Players` : layout === 'parallel' ? 'Parallel' : 'Opposite'} <span>↗</span></button>
    </main>
    <footer className="footer"><span>GRIDBREAK / CAPABILITY BUILD</span><span>ONE CATALOG. MANY FRONTS.</span></footer>
  </div>;
}
