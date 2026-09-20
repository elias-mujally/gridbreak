import { CSSProperties, useMemo, useState } from 'react';
import { routeLength } from '../game/pathfinding';
import { legalMoves } from '../game/movement';
import { Action, GameState, Point, Wall, activePlayerStates, currentPlayerId, samePoint, type PlayerId } from '../game/state';
import { isLegalWall, wallKey } from '../game/walls';
import { MAP_CONFIGS, pointInGoal } from '../game/modes';

type PlacementMode = 'move' | 'horizontal' | 'vertical';
type Props = {
  game: GameState;
  onAction: (action: Action) => boolean;
  onRematch: () => void;
  onMainMenu: () => void;
  localPlayerId?: PlayerId;
  pending?: boolean;
  online?: boolean;
  connectionLabel?: string;
  memberStatus?: Record<string, string>;
  rematchLabel?: string;
};

const labelPoint = (point: Point) => `${String.fromCharCode(65 + point.col)}${point.row + 1}`;
function wallRect(wall: Wall) {
  return wall.orientation === 'horizontal' ? { x: wall.col * 100, y: wall.row * 100 + 88, width: 188, height: 12 }
    : { x: wall.col * 100 + 88, y: wall.row * 100, width: 12, height: 188 };
}
function piecePosition(point: Point, boardWidth: number, boardHeight: number): CSSProperties {
  return { left: `${(point.col * 100 + 44) / boardWidth * 100}%`, top: `${(point.row * 100 + 44) / boardHeight * 100}%`, width: `${62 / boardWidth * 100}%` };
}
function playerStyle(color: string) {
  return { '--player-color': color } as CSSProperties;
}

export default function ConvergenceMatch({ game, onAction, onRematch, onMainMenu, localPlayerId, pending = false, online = false, connectionLabel, memberStatus, rematchLabel }: Props) {
  const [mode, setMode] = useState<PlacementMode>('move');
  const [hover, setHover] = useState<Wall | null>(null);
  const [boardZoom, setBoardZoom] = useState(false);
  const players = useMemo(() => activePlayerStates(game), [game]);
  const activeId = currentPlayerId(game);
  const active = players.find(player => player.id === activeId)!;
  const moves = useMemo(() => legalMoves(game, activeId), [game, activeId]);
  const coords = useMemo(() => Array.from({ length: game.width * game.height }, (_, index) => ({ row: Math.floor(index / game.width), col: index % game.width })), [game.width, game.height]);
  const anchors = useMemo(() => Array.from({ length: (game.width - 1) * (game.height - 1) }, (_, index) => ({ row: Math.floor(index / (game.width - 1)), col: index % (game.width - 1) })), [game.width, game.height]);
  const boardWidth = game.width * 100 - 12;
  const boardHeight = game.height * 100 - 12;
  const boardStyle = { aspectRatio: `${boardWidth}/${boardHeight}` } as CSSProperties;
  const gridStyle = { gridTemplateColumns: `repeat(${game.width},minmax(0,1fr))`, gridTemplateRows: `repeat(${game.height},minmax(0,1fr))`, columnGap: `${12 / boardWidth * 100}%`, rowGap: `${12 / boardHeight * 100}%` } as CSSProperties;
  const denseBoard = Math.max(game.width, game.height) >= 15;
  const placementMode = mode !== 'move';
  const canAct = !game.winner && !pending && active.controller === 'HUMAN_LOCAL' && (!localPlayerId || activeId === localPlayerId);
  const hoverLegal = hover ? isLegalWall(game, hover, activeId) : false;
  const map = MAP_CONFIGS[game.mapId];

  function play(action: Action) {
    if (!onAction(action)) return;
    setMode('move');
    setHover(null);
  }

  function rematch() {
    setMode('move');
    setHover(null);
    setBoardZoom(false);
    onRematch();
  }

  return <div className={`app-shell convergence-shell map-${game.mapId} ${game.winner ? 'match-ended' : ''}`}>
    <header className="topbar">
      <div className="brand" aria-label="GridBreak"><span className="brand-mark"><i /><i /><i /><i /></span><span>GRID<span className="brand-light">BREAK</span></span></div>
      <div className="topbar-right"><span className="edition">{online ? `ONLINE / ${connectionLabel ?? 'CONNECTED'} / ` : 'CONVERGENCE / '}{map.name.toUpperCase()} {game.width}×{game.height} / {players.length} PLAYERS</span><button className="restart-top mode-change" onClick={onMainMenu}>Main Menu</button>{!online && <button className="restart-top" onClick={rematch}><span>↺</span> Rematch</button>}</div>
    </header>
    <main className="main-layout convergence-layout">
      <aside className="intro-panel convergence-intro">
        <div className="eyebrow"><span className="signal-dot" /> {online ? 'AUTHORITATIVE ONLINE ROOM' : players.some(player => player.controller === 'AI') ? 'LOCAL MIXED CONTROL' : 'LOCAL SHARED DEVICE'}</div>
        <h1>Meet at<br /><em>the center.</em></h1>
        <p className="lede">Race from the perimeter. Shape every route. First token into the one true center cell wins.</p>
        <div className="how-to"><span>01 / ONE GOAL CELL</span><p>Move or place one wall. Every barrier must leave every player a route to the exact center.</p></div>
        <div className="convergence-roster" aria-label="Players">
          {players.map(player => <div key={player.id} className={`roster-player identity-${player.id} ${player.id === activeId && !game.winner ? 'active' : ''}`} style={playerStyle(player.color)}>
            <b aria-hidden="true">{player.token}</b><span><strong>{player.label}</strong><small>{player.controller === 'AI' ? `AI — ${player.difficulty.toUpperCase()} · ` : player.controller === 'HUMAN_LOCAL' ? 'LOCAL · ' : ''}{player.wallsRemaining} walls · {routeLength(player.position, player.goal, game.walls, game)} steps{memberStatus?.[player.id] ? ` · ${memberStatus[player.id]}` : ''}</small></span>
          </div>)}
        </div>
      </aside>
      <section className="arena convergence-arena" aria-label={`${game.width} by ${game.height} Convergence board`}>
        <div className={`shared-turn identity-${active.id}`} style={playerStyle(active.color)} aria-live="polite"><span>{active.token}</span><div><small>{active.controller === 'AI' ? `AI — ${active.difficulty.toUpperCase()}` : 'ACTIVE PLAYER'}</small><strong>{game.winner ? 'MATCH COMPLETE' : active.controller === 'AI' && pending ? `${active.label.toUpperCase()} THINKING` : `${active.label.toUpperCase()}'S TURN`}</strong></div><b>{active.wallsRemaining} WALLS</b></div>
        <div className="mobile-toolbar convergence-toolbar" role="group" aria-label="Current player action">
          <button className={mode === 'move' ? 'selected' : ''} onClick={() => setMode('move')} disabled={!canAct}>✣ <span>Move</span></button>
          <button className={mode === 'horizontal' ? 'selected' : ''} onClick={() => setMode('horizontal')} disabled={!canAct || active.wallsRemaining === 0}>━ <span>Wall —</span></button>
          <button className={mode === 'vertical' ? 'selected' : ''} onClick={() => setMode('vertical')} disabled={!canAct || active.wallsRemaining === 0}>┃ <span>Wall |</span></button>
        </div>
        {denseBoard ? <button className="board-zoom-toggle" onClick={() => setBoardZoom(value => !value)} aria-pressed={boardZoom}>{boardZoom ? 'Fit board' : 'Zoom board ×2'}</button> : null}
        <div className={`board-viewport ${boardZoom ? 'zoomed' : ''}`}>
          <div className="board-frame convergence-frame">
            <div className={`board ${game.winner ? 'winner-blue' : ''}`} style={boardStyle} data-mode={mode}>
              <div className="cell-grid" style={gridStyle}>
                {coords.map(point => {
                  const legal = mode === 'move' && moves.some(move => samePoint(move, point));
                  const goal = pointInGoal(point, active.goal, game);
                  return <button key={`${point.row}-${point.col}`} className={`cell ${legal && canAct ? 'legal' : ''} ${goal ? 'convergence-goal' : ''}`} type="button" aria-label={`Cell ${labelPoint(point)}${goal ? ', the single winning GoalCell' : ''}${legal && canAct ? ', legal move' : ''}`} disabled={!legal || !canAct} onClick={() => play({ type: 'move', to: point })}>{goal ? <span className="goal-core" aria-hidden="true">◆</span> : null}</button>;
                })}
              </div>
              {players.map(player => <div key={player.id} className={`piece convergence-piece identity-${player.id} ${player.id === activeId ? 'active-piece' : ''}`} style={{ ...piecePosition(player.position, boardWidth, boardHeight), ...playerStyle(player.color) }} aria-label={`${player.label}, token ${player.token}`}><span>{player.token}</span></div>)}
              <svg className={`wall-layer ${placementMode && canAct ? 'active' : ''}`} viewBox={`0 0 ${boardWidth} ${boardHeight}`} aria-label="Wall placement points">
                {game.walls.map(wall => <g key={wallKey(wall)} className={`placed-wall ${wall.orientation} owner-${wall.owner ?? 'neutral'}`}><rect {...wallRect(wall)} rx="6" /></g>)}
                {placementMode && hover ? <rect className={`wall-preview ${hoverLegal ? 'allowed' : 'denied'}`} {...wallRect(hover)} rx="6" /> : null}
                {placementMode && canAct ? anchors.map(anchor => {
                  const wall: Wall = { ...anchor, orientation: mode };
                  const legal = isLegalWall(game, wall, activeId);
                  const x = anchor.col * 100 + 94;
                  const y = anchor.row * 100 + 94;
                  return <g key={`${anchor.row}-${anchor.col}`} className={`anchor ${legal ? 'available' : 'unavailable'}`} role="button" aria-label={`${mode} wall at ${labelPoint(anchor)}${legal ? '' : ', unavailable'}`} tabIndex={legal ? 0 : -1} onPointerEnter={() => setHover(wall)} onPointerLeave={() => setHover(null)} onClick={() => play({ type: 'wall', wall })} onKeyDown={event => { if (legal && (event.key === 'Enter' || event.key === ' ')) play({ type: 'wall', wall }); }}><rect className="anchor-hit" x={x - 35} y={y - 35} width="70" height="70" /><circle cx={x} cy={y} r={legal ? 6 : 3} /></g>;
                }) : null}
              </svg>
              {game.winner ? <div className="match-result convergence-result victory" role="dialog" aria-modal="true" aria-label="Match result">
                <div className="result-particles" aria-hidden="true">{Array.from({ length: 14 }, (_, index) => <i key={index} />)}</div>
                <small>MATCH COMPLETE</small><strong>{players.find(player => player.id === game.winner)?.label.toUpperCase()} WINS</strong><span>Center secured.</span>
                <div className="final-positions" aria-label="Final player positions">{players.map(player => <span key={player.id} style={playerStyle(player.color)}><b>{player.token}</b>{labelPoint(player.position)}</span>)}</div>
                <div className="result-actions"><button onClick={rematch} disabled={pending}>↺ {rematchLabel ?? 'REMATCH'}</button><button className="result-menu" onClick={onMainMenu}>MAIN MENU</button></div>
              </div> : null}
            </div>
          </div>
        </div>
      </section>
      <aside className="control-panel convergence-controls">
        <div className="panel-heading"><span className="panel-index">02 / {online ? 'REMOTE CONTROL' : 'SHARED CONTROL'}</span><span className="live-pip">{online ? 'ONLINE' : 'LOCAL'}</span></div>
        <div className={`turn-card identity-${active.id}`} style={playerStyle(active.color)}><div className="turn-card-top"><span>CURRENT TURN</span><span className="turn-symbol">{active.token}</span></div><strong>{game.winner ? 'Center claimed' : active.label}</strong><p>{game.winner ? 'Choose a rematch or return to setup.' : `Token ${active.token}: move one cell or place one route-safe wall.`}</p></div>
        <div className="control-group actions-group"><div className="control-label"><span>ACTION</span><small>ONE PER TURN</small></div>
          <button className={`action-button ${mode === 'move' ? 'selected' : ''}`} onClick={() => setMode('move')} disabled={!canAct}><span className="action-icon move-icon">✣</span><span><strong>Move</strong><small>Advance toward center</small></span><span className="action-check">{mode === 'move' ? '●' : '○'}</span></button>
          <div className="wall-actions"><button className={`action-button ${mode === 'horizontal' ? 'selected' : ''}`} onClick={() => setMode('horizontal')} disabled={!canAct || active.wallsRemaining === 0}><span className="action-icon wall-icon horizontal-icon" /><span><strong>Wall</strong><small>Horizontal</small></span></button><button className={`action-button ${mode === 'vertical' ? 'selected' : ''}`} onClick={() => setMode('vertical')} disabled={!canAct || active.wallsRemaining === 0}><span className="action-icon wall-icon vertical-icon" /><span><strong>Wall</strong><small>Vertical</small></span></button></div>
        </div>
        <div className="hint-box"><span className="hint-spark">◆</span><p>{placementMode ? 'Glowing junctions preserve a center route for every player.' : 'Glowing cells are legal moves. Occupied cells can be jumped or sidestepped.'}</p></div>
        {!online && <button className="restart-bottom" onClick={rematch}><span>↺</span> Rematch · same setup <span>↗</span></button>}
        <button className="change-mode-bottom" onClick={onMainMenu}>Main Menu</button>
      </aside>
    </main>
    <footer className="footer"><span>GRIDBREAK / {map.name.toUpperCase()} {game.width}×{game.height}</span><span>{players.length} {online ? 'ONLINE PLAYERS' : 'PLAYER SLOTS'} · ONE CENTER GOAL</span></footer>
  </div>;
}
