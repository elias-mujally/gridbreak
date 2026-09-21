import { type CSSProperties, useMemo, useState } from 'react';
import { legalAssistPaths, legalMoves } from '../game/movement';
import { routeLength } from '../game/pathfinding';
import type { Action, Player, PlayerId, Point, Wall } from '../game/state';
import { samePoint } from '../game/state';
import { MAP_CONFIGS, goalLabel, pointInGoal } from '../game/modes';
import { canPlaceViewedWall, perceivedMovementBoard, probeTargets, type GameView } from '../game/view';
import { wallKey } from '../game/walls';

type Mode = 'move' | 'horizontal' | 'vertical' | 'phantom-horizontal' | 'phantom-vertical' | 'assist' | 'break';
const isWallMode = (mode: Mode) => ['horizontal', 'vertical', 'phantom-horizontal', 'phantom-vertical'].includes(mode);
const isPhantomMode = (mode: Mode) => mode.startsWith('phantom');
const wallOrientation = (mode: Mode): Wall['orientation'] => mode.endsWith('vertical') ? 'vertical' : 'horizontal';
const labelPoint = (point: Point) => `${String.fromCharCode(65 + point.col)}${point.row + 1}`;
function wallRect(wall: Wall) { return wall.orientation === 'horizontal' ? { x: wall.col * 100, y: wall.row * 100 + 88, width: 188, height: 12 } : { x: wall.col * 100 + 88, y: wall.row * 100, width: 12, height: 188 }; }
function piecePosition(point: Point, boardWidth: number, boardHeight: number): CSSProperties { return { left: `${(point.col * 100 + 44) / boardWidth * 100}%`, top: `${(point.row * 100 + 44) / boardHeight * 100}%`, width: `${62 / boardWidth * 100}%` }; }

export default function OnlineRaceMatch({ view, localPlayerId, pending, connectionLabel, memberStatus, onAction, onRematch, rematchLabel, onMainMenu }: {
  view: GameView; localPlayerId: PlayerId; pending: boolean; connectionLabel: string; memberStatus: Partial<Record<PlayerId, string>>;
  onAction: (action: Action) => boolean; onRematch: () => void; rematchLabel: string; onMainMenu: () => void;
}) {
  const [mode, setMode] = useState<Mode>('move');
  const [hover, setHover] = useState<Wall | null>(null);
  const [boardZoom, setBoardZoom] = useState(false);
  const map = MAP_CONFIGS[view.mapId];
  const rush = view.mode === 'rush';
  const local = localPlayerId === 'red' ? 'red' : 'blue';
  const opponent: Player = local === 'blue' ? 'red' : 'blue';
  const actor = view.players.find(player => player.id === view.turn)!;
  const self = view.players.find(player => player.id === localPlayerId)!;
  const board = useMemo(() => perceivedMovementBoard(view), [view]);
  const canAct = !view.winner && !pending && view.turn === localPlayerId;
  const moves = useMemo(() => canAct ? legalMoves(board, localPlayerId) : [], [board, canAct, localPlayerId]);
  const assists = useMemo(() => canAct && rush ? legalAssistPaths(board, localPlayerId) : [], [board, canAct, rush, localPlayerId]);
  const probes = useMemo(() => canAct && rush ? probeTargets(view, local) : [], [view, canAct, rush, local]);
  const coords = useMemo(() => Array.from({ length: view.width * view.height }, (_, index) => ({ row: Math.floor(index / view.width), col: index % view.width })), [view.width, view.height]);
  const anchors = useMemo(() => Array.from({ length: (view.width - 1) * (view.height - 1) }, (_, index) => ({ row: Math.floor(index / (view.width - 1)), col: index % (view.width - 1) })), [view.width, view.height]);
  const placement = isWallMode(mode);
  const ownEnergy = view.rush?.energy[local] ?? 0;
  const ownAssists = view.rush?.assists[local] ?? 0;
  const breakable = view.walls.filter(wall => wall.owner === opponent);
  const boardWidth = view.width * 100 - 12; const boardHeight = view.height * 100 - 12;
  const boardStyle = { aspectRatio: `${boardWidth}/${boardHeight}` } as CSSProperties;
  const gridStyle = { gridTemplateColumns: `repeat(${view.width},minmax(0,1fr))`, gridTemplateRows: `repeat(${view.height},minmax(0,1fr))`, columnGap: `${12 / boardWidth * 100}%`, rowGap: `${12 / boardHeight * 100}%` } as CSSProperties;
  const dense = Math.max(view.width, view.height) >= 15;
  function send(action: Action) { if (!canAct) return; if (onAction(action) && !['move', 'probe'].includes(action.type)) { setMode('move'); setHover(null); } }
  function wallMode(orientation: Wall['orientation']) { setMode(isPhantomMode(mode) ? `phantom-${orientation}` : orientation); setHover(null); }
  function phantomMode() { setMode(isPhantomMode(mode) ? wallOrientation(mode) : `phantom-${wallOrientation(mode)}`); setHover(null); }

  return <div className={`app-shell online-race-match ${rush ? 'rush-shell' : ''} map-${view.mapId} layout-${view.layout} ${view.winner ? 'match-ended' : ''}`}>
    <header className="topbar"><div className="brand"><span className="brand-mark"><i /><i /><i /><i /></span><span>GRID<span className="brand-light">BREAK</span></span></div><div className="topbar-right"><span className="edition">ONLINE / {connectionLabel} / {view.mode.toUpperCase()} / {map.name.toUpperCase()} {view.layout.toUpperCase()}</span><button className="restart-top mode-change" onClick={onMainMenu}>Main Menu</button></div></header>
    <main className="main-layout">
      <aside className="intro-panel"><div className="eyebrow"><span className="signal-dot connected" /> ONLINE {view.mode.toUpperCase()} · PRIVATE ROOM</div><h1>Make<br /><em>your move.</em></h1><p className="lede">{rush ? 'Private Phantom knowledge stays on its owner’s authenticated view.' : 'The server validates every move, wall, route, and win.'}</p>
        <div className="how-to"><span>01 / PLAYERS</span>{view.players.map(player => <p key={player.id}><strong>{player.label}</strong> · {player.id.toUpperCase()} · {memberStatus[player.id] ?? 'online'}</p>)}</div>
        <div className="rule-note"><span className="rule-icon">↗</span><span>You are <strong>{self.label}</strong>. Reach the {goalLabel(self.goal).toLowerCase()}.</span></div>
      </aside>
      <section className="arena" aria-label={`${view.width} by ${view.height} online GridBreak board`}>
        <div className="arena-top"><div className="player-tag red"><span className="player-orb" /><span className="player-copy"><small>{local === 'red' ? 'YOU' : 'OPPONENT'}</small><strong>RED</strong>{rush && <small>EN {view.rush!.energy.red}/5 · ASSIST ×{view.rush!.assists.red}</small>}</span></div><div className="objective"><span>BLUE → {goalLabel(view.goals.blue)}</span></div><div className="wall-chip red"><strong>{view.remaining.red.toString().padStart(2, '0')}</strong><span>WALLS</span></div></div>
        <div className="mobile-toolbar" role="group" aria-label="Current player action"><button className={mode === 'move' ? 'selected' : ''} onClick={() => setMode('move')} disabled={!canAct}>✣ <span>Move</span></button><button className={mode.endsWith('horizontal') ? 'selected' : ''} onClick={() => wallMode('horizontal')} disabled={!canAct || self.wallsRemaining === 0}>━ <span>Wall —</span></button><button className={mode.endsWith('vertical') ? 'selected' : ''} onClick={() => wallMode('vertical')} disabled={!canAct || self.wallsRemaining === 0}>┃ <span>Wall |</span></button></div>
        {rush && <div className="mobile-abilities" role="group" aria-label="Rush abilities"><button className={mode === 'assist' ? 'selected' : ''} onClick={() => setMode('assist')} disabled={!canAct || ownAssists === 0}>↗ Assist <small>×{ownAssists}</small></button><button className={mode === 'break' ? 'selected' : ''} onClick={() => setMode('break')} disabled={!canAct || ownEnergy < 4 || !breakable.length}>✳ Break <small>{ownEnergy < 4 ? 'NEED 4' : '4 EN'}</small></button><button className={isPhantomMode(mode) ? 'selected phantom-selected' : ''} onClick={phantomMode} disabled={!canAct || !view.rush?.ownPhantomAvailable || self.wallsRemaining === 0}>◇ Phantom <small>{view.rush?.ownPhantomAvailable ? 'READY' : 'USED'}</small></button></div>}
        {dense && <button className="board-zoom-toggle" onClick={() => setBoardZoom(value => !value)}>{boardZoom ? 'Fit board' : 'Zoom board ×2'}</button>}
        <div className={`board-viewport ${boardZoom ? 'zoomed' : ''}`}><div className="board-frame"><div className={`board ${view.winner ? `winner-${view.winner}` : ''}`} style={boardStyle} data-mode={mode}>
          <div className="cell-grid" style={gridStyle}>{coords.map(point => { const legal = canAct && mode === 'move' && moves.some(item => samePoint(item, point)); const probe = canAct && mode === 'move' && probes.some(item => samePoint(item, point)); const assisted = canAct && mode === 'assist' ? assists.find(path => samePoint(path.to, point)) : undefined; const tile = view.rush?.tiles.find(item => !item.consumed && samePoint(item.point, point)); const available = legal || probe || !!assisted; return <button key={`${point.row}-${point.col}`} className={`cell ${legal ? 'legal' : ''} ${probe ? 'probe-target' : ''} ${assisted ? 'assist-target' : ''} ${pointInGoal(point, view.goals.blue, view) ? 'blue-goal' : ''} ${pointInGoal(point, view.goals.red, view) ? 'red-goal' : ''}`} aria-label={`Cell ${labelPoint(point)}${available ? ', legal action' : ''}`} disabled={!available} onClick={() => assisted ? send({ type: 'assist', via: assisted.via, to: assisted.to }) : probe ? send({ type: 'probe', to: point }) : send({ type: 'move', to: point })}>{tile && <span className={`power-tile ${tile.kind}`}>{tile.kind === 'energy' ? '⚡' : '↗'}</span>}{available && <span className="move-indicator" />}</button>; })}</div>
          <div className="piece blue-piece" style={piecePosition(view.pawns.blue, boardWidth, boardHeight)} aria-label="Blue piece"><span /></div><div className="piece red-piece" style={piecePosition(view.pawns.red, boardWidth, boardHeight)} aria-label="Red piece"><span /></div>
          <svg className={`wall-layer ${(placement || mode === 'break') && canAct ? 'active' : ''}`} viewBox={`0 0 ${boardWidth} ${boardHeight}`} aria-label="Wall placement points">
            {view.walls.map(wall => { const target = mode === 'break' && canAct && wall.owner === opponent; return <g key={wallKey(wall)} className={`placed-wall ${wall.orientation} ${wall.knownPhantom ? 'own-phantom' : ''} ${target ? 'breakable' : ''}`} role={target ? 'button' : undefined} onClick={target ? () => send({ type: 'break', wall }) : undefined}><rect {...wallRect(wall)} rx="6" /></g>; })}
            {placement && canAct && hover && <rect className={`wall-preview ${canPlaceViewedWall(view, hover, isPhantomMode(mode)) ? 'allowed' : 'denied'} ${isPhantomMode(mode) ? 'phantom-preview' : ''}`} {...wallRect(hover)} rx="6" />}
            {placement && canAct && anchors.map(anchor => { const wall: Wall = { ...anchor, orientation: wallOrientation(mode) }; const legal = canPlaceViewedWall(view, wall, isPhantomMode(mode)); const x = anchor.col * 100 + 94; const y = anchor.row * 100 + 94; return <g key={`${anchor.row}-${anchor.col}`} className={`anchor ${legal ? 'available' : 'unavailable'}`} role="button" tabIndex={legal ? 0 : -1} onPointerEnter={() => setHover(wall)} onPointerLeave={() => setHover(null)} onClick={() => legal && send(isPhantomMode(mode) ? { type: 'phantom', wall } : { type: 'wall', wall })}><rect className="anchor-hit" x={x - 35} y={y - 35} width="70" height="70" /><circle cx={x} cy={y} r={legal ? 6 : 3} /></g>; })}
          </svg>
          {view.winner && <div className={`match-result ${view.winner === localPlayerId ? 'victory' : view.winner === 'draw' ? 'draw' : 'defeat'}`} role="dialog"><small>MATCH COMPLETE</small><strong>{view.winner === 'draw' ? 'DRAW' : `${view.players.find(player => player.id === view.winner)?.label.toUpperCase()} WINS`}</strong><span>{view.rush?.winnerReason === 'deadline' ? 'Deadline resolved by the server.' : 'Route secured.'}</span><div className="result-actions"><button onClick={onRematch}>{rematchLabel}</button><button className="result-menu" onClick={onMainMenu}>MAIN MENU</button></div></div>}
        </div></div></div>
        <div className="arena-bottom"><div className="player-tag blue"><span className="player-orb" /><span className="player-copy"><small>{local === 'blue' ? 'YOU' : 'OPPONENT'}</small><strong>BLUE</strong>{rush && <small>EN {view.rush!.energy.blue}/5 · ASSIST ×{view.rush!.assists.blue}</small>}</span></div><div className="objective"><span>RED → {goalLabel(view.goals.red)}</span></div><div className="wall-chip blue"><strong>{view.remaining.blue.toString().padStart(2, '0')}</strong><span>WALLS</span></div></div>
      </section>
      <aside className="control-panel"><div className="panel-heading"><span className="panel-index">02 / ONLINE CONTROL</span><span className="live-pip">{connectionLabel}</span></div><div className="turn-card"><div className="turn-card-top"><span>CURRENT TURN</span><span className="turn-symbol">{actor.token}</span></div><strong>{view.winner ? 'Match complete' : pending ? 'Waiting for server' : `${actor.label}'s move`}</strong><p>{view.rush?.event?.text ?? (canAct ? 'Choose one validated action.' : 'Your opponent is deciding.')}</p></div>
        <div className="control-group actions-group"><div className="control-label"><span>CURRENT ACTION</span><small>ONE PER TURN</small></div><button className={`action-button ${mode === 'move' ? 'selected' : ''}`} onClick={() => setMode('move')} disabled={!canAct}><span className="action-icon move-icon">✣</span><span><strong>Move</strong><small>Advance one cell</small></span></button><div className="wall-actions"><button className="action-button" onClick={() => wallMode('horizontal')} disabled={!canAct || self.wallsRemaining === 0}><span><strong>Wall</strong><small>Horizontal</small></span></button><button className="action-button" onClick={() => wallMode('vertical')} disabled={!canAct || self.wallsRemaining === 0}><span><strong>Wall</strong><small>Vertical</small></span></button></div>{rush && <div className="rush-actions"><button className={mode === 'assist' ? 'rush-action selected' : 'rush-action'} onClick={() => setMode('assist')} disabled={!canAct || ownAssists === 0}><span>↗</span><strong>Assist</strong><small>×{ownAssists}</small></button><button className={mode === 'break' ? 'rush-action selected' : 'rush-action'} onClick={() => setMode('break')} disabled={!canAct || ownEnergy < 4 || !breakable.length}><span>✳</span><strong>Break</strong><small>4 EN</small></button><button className={isPhantomMode(mode) ? 'rush-action selected phantom-selected' : 'rush-action'} onClick={phantomMode} disabled={!canAct || !view.rush?.ownPhantomAvailable}><span>◇</span><strong>Phantom</strong><small>{view.rush?.ownPhantomAvailable ? 'READY' : 'USED'}</small></button></div>}</div>
        <div className="route-readout"><div><small>BLUE ROUTE</small><strong>{routeLength(view.pawns.blue, view.goals.blue, view.pathWalls, view)}<span>steps</span></strong></div><div><small>RED ROUTE</small><strong>{routeLength(view.pawns.red, view.goals.red, view.pathWalls, view)}<span>steps</span></strong></div></div>
        <button className="restart-bottom" onClick={onRematch} disabled={!view.winner}>{rematchLabel}</button><button className="change-mode-bottom" onClick={onMainMenu}>Main Menu</button>
      </aside>
    </main><footer className="footer"><span>GRIDBREAK / ONLINE {view.mode.toUpperCase()}</span><span>SERVER AUTHORITY · PRIVATE VIEW</span></footer>
  </div>;
}
