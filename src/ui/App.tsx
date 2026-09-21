import { CSSProperties, useEffect, useMemo, useState } from 'react';
import { chooseAIActionWithDebug } from '../game/ai';
import { applyAction } from '../game/engine';
import { legalAssistPaths, legalMoves } from '../game/movement';
import { routeLength } from '../game/pathfinding';
import { Action, Difficulty, GameState, NewGameOptions, Player, Point, Wall, activePlayerStates, currentPlayerId, newGame, rematchGame, samePoint } from '../game/state';
import { isLegalWall, wallKey } from '../game/walls';
import { canPlaceViewedWall, perceivedMovementBoard, probeTargets, viewForPlayer } from '../game/view';
import { MAP_CONFIGS, RULE_SETS, ConvergencePlayerCount, RaceLayout, goalLabel, pointInGoal, type MatchConfiguration } from '../game/modes';
import ModePicker from './ModePicker';
import ConvergenceMatch from './ConvergenceMatch';
import OnlineApp from './OnlineApp';

type Mode = 'move' | 'horizontal' | 'vertical' | 'phantom-horizontal' | 'phantom-vertical' | 'assist' | 'break';
type Flash = { id: number; kind: 'break' | 'reveal' | 'tile'; text: string; wall?: Wall };
const isWallMode = (mode: Mode) => ['horizontal', 'vertical', 'phantom-horizontal', 'phantom-vertical'].includes(mode);
const isPhantomMode = (mode: Mode) => mode.startsWith('phantom');
const wallOrientation = (mode: Mode): Wall['orientation'] => mode.endsWith('vertical') ? 'vertical' : 'horizontal';
const labelPoint = (point: Point) => `${String.fromCharCode(65 + point.col)}${point.row + 1}`;

function launchState(): { started: boolean; game: GameState; difficulty: Difficulty } {
  const params = new URLSearchParams(window.location.search);
  const mapId = params.get('map');
  const difficulty = (['easy', 'normal', 'hard'] as const).includes(params.get('difficulty') as Difficulty) ? params.get('difficulty') as Difficulty : 'normal';
  if (!mapId || !(mapId in MAP_CONFIGS)) return { started: false, game: newGame(), difficulty };
  const mode = params.get('mode') === 'classic' ? 'classic' : params.get('mode') === 'convergence' ? 'convergence' : 'rush';
  const requestedLayout = params.get('layout') as RaceLayout | null;
  const layout = mode === 'convergence' ? 'convergence' : requestedLayout && MAP_CONFIGS[mapId as keyof typeof MAP_CONFIGS].layouts[requestedLayout] ? requestedLayout : MAP_CONFIGS[mapId as keyof typeof MAP_CONFIGS].defaultLayout;
  const requestedPlayers = Number(params.get('players')) as ConvergencePlayerCount;
  const playerCount = ([2, 3, 4] as const).includes(requestedPlayers) ? requestedPlayers : 4;
  const seedText = params.get('seed');
  const seed = seedText !== null && Number.isInteger(Number(seedText)) ? Number(seedText) >>> 0 : undefined;
  const controllerParam = params.get('controllers')?.split(',').slice(0, mode === 'convergence' ? playerCount : 2);
  const controllers = controllerParam?.map(value => ({ type: value.startsWith('ai') ? 'AI' as const : 'HUMAN_LOCAL' as const, difficulty: value.includes('hard') ? 'hard' as const : value.includes('easy') ? 'easy' as const : 'normal' as const }));
  const game = newGame({ mode, mapId: mapId as keyof typeof MAP_CONFIGS, layout, ...(controllers?.length === (mode === 'convergence' ? playerCount : 2) ? { controllers } : {}), ...(mode === 'convergence' ? { playerCount } : {}), ...(mode === 'rush' && seed !== undefined ? { seed, seedLocked: true } : {}) });
  if (import.meta.env.DEV && params.get('result') === 'victory' && mode === 'rush') {
    const edge = game.goals.blue.edge;
    game.pawns.blue = edge === 'top' ? { row: 0, col: Math.floor(game.width / 2) }
      : edge === 'bottom' ? { row: game.height - 1, col: Math.floor(game.width / 2) }
      : edge === 'left' ? { row: Math.floor(game.height / 2), col: 0 }
      : { row: Math.floor(game.height / 2), col: game.width - 1 };
    game.winner = 'blue'; game.ply = 7; game.rush!.winnerReason = 'goal';
  }
  if (import.meta.env.DEV && params.get('scenario') === 'ai-defense' && mode === 'rush') {
    const edge = game.goals.blue.edge;
    game.pawns.blue = edge === 'top' ? { row: 1, col: Math.floor(game.width / 2) }
      : edge === 'bottom' ? { row: game.height - 2, col: Math.floor(game.width / 2) }
      : edge === 'left' ? { row: Math.floor(game.height * .66), col: 1 }
      : { row: Math.floor(game.height * .66), col: game.width - 2 };
    game.turn = 'red'; game.ply = 10; game.rush!.assists.red = 0; game.rush!.tiles = [];
  }
  if (import.meta.env.DEV && params.get('scenario') === 'ai-reward' && mode === 'rush' && game.mapId === 'sprint') {
    game.pawns = { blue: { row: 5, col: 0 }, red: { row: 2, col: 3 } };
    game.turn = 'red'; game.ply = 8; game.remaining = { blue: 0, red: 0 };
    game.rush!.assists.red = 0; game.rush!.tiles = [{ kind: 'boost', point: { row: 2, col: 4 }, consumed: false }];
  }
  if (import.meta.env.DEV && params.get('scenario') === 'ai-break' && mode === 'rush' && game.mapId === 'sprint') {
    game.pawns = { blue: { row: 5, col: 0 }, red: { row: 2, col: 3 } };
    game.turn = 'red'; game.ply = 8; game.remaining = { blue: 0, red: 0 };
    game.walls = [{ row: 2, col: 2, orientation: 'horizontal', owner: 'blue' }];
    game.rush!.energy.red = 5; game.rush!.tiles = [];
  }
  return { started: true, game, difficulty };
}

function wallRect(wall: Wall) {
  return wall.orientation === 'horizontal' ? { x: wall.col * 100, y: wall.row * 100 + 88, width: 188, height: 12 }
    : { x: wall.col * 100 + 88, y: wall.row * 100, width: 12, height: 188 };
}
function piecePosition(point: Point, boardWidth: number, boardHeight: number): CSSProperties {
  return { left: `${(point.col * 100 + 44) / boardWidth * 100}%`, top: `${(point.row * 100 + 44) / boardHeight * 100}%`, width: `${62 / boardWidth * 100}%` };
}
function describeAction(action: Action): string {
  if (action.type === 'wall') return `${action.wall.orientation} wall placed`;
  if (action.type === 'phantom') return 'armed a Phantom Wall';
  if (action.type === 'break') return 'shattered a wall';
  if (action.type === 'assist') return `used Assist to ${labelPoint(action.to)}`;
  if (action.type === 'probe') return 'tested a barrier';
  return `moved to ${labelPoint(action.to)}`;
}
function EnergyMeter({ player, energy, assists }: { player: Player; energy: number; assists: number }) {
  return <div className={`energy-meter ${player}`} aria-label={`${player} Energy ${energy} of 5, Assist ${assists}`}>
    <span>EN {energy}/5</span><div className="energy-pips">{Array.from({ length: RULE_SETS.rush.energyMax }, (_, index) => <i key={index} className={index < energy ? 'filled' : ''} />)}</div>
    <b>ASSIST ×{assists}</b>
  </div>;
}

export default function App() {
  const initial = useMemo(launchState, []);
  const [started, setStarted] = useState(initial.started);
  const [game, setGame] = useState<GameState>(initial.game);
  const [difficulty, setDifficulty] = useState<Difficulty>(initial.difficulty);
  const [mode, setMode] = useState<Mode>('move');
  const [hover, setHover] = useState<Wall | null>(null);
  const [notice, setNotice] = useState('Your move. Reach the far edge.');
  const [thinking, setThinking] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [boardZoom, setBoardZoom] = useState(false);
  const [aiExplanation, setAIExplanation] = useState('');
  const [online, setOnline] = useState<MatchConfiguration | 'join' | null>(null);
  const debugAI = useMemo(() => new URLSearchParams(window.location.search).get('aiDebug') === '1', []);
  const view = useMemo(() => viewForPlayer(game, 'blue'), [game]);
  const board = useMemo(() => perceivedMovementBoard(view), [view]);
  const dimensions = useMemo(() => ({ width: game.width, height: game.height }), [game.width, game.height]);
  const coords = useMemo(() => Array.from({ length: game.width * game.height }, (_, index) => ({ row: Math.floor(index / game.width), col: index % game.width })), [game.width, game.height]);
  const anchors = useMemo(() => Array.from({ length: (game.width - 1) * (game.height - 1) }, (_, index) => ({ row: Math.floor(index / (game.width - 1)), col: index % (game.width - 1) })), [game.width, game.height]);
  const activeId = currentPlayerId(game);
  const players = activePlayerStates(game);
  const activePlayer = players.find(player => player.id === activeId)!;
  const sharedClassic = game.mode === 'classic' && players.every(player => player.controller === 'HUMAN_LOCAL');
  const moves = useMemo(() => activePlayer?.controller === 'HUMAN_LOCAL' ? legalMoves(board, activeId) : [], [activePlayer?.controller, activeId, board]);
  const probes = useMemo(() => game.turn === 'blue' ? probeTargets(view, 'blue') : [], [game.turn, view]);
  const assists = useMemo(() => game.turn === 'blue' ? legalAssistPaths(board) : [], [game.turn, board]);
  const blueRoute = useMemo(() => routeLength(view.pawns.blue, view.goals.blue, view.pathWalls, dimensions), [view, dimensions]);
  const redRoute = useMemo(() => routeLength(view.pawns.red, view.goals.red, view.pathWalls, dimensions), [view, dimensions]);
  const canAct = activePlayer?.controller === 'HUMAN_LOCAL' && !game.winner && !thinking;
  const rushMode = game.mode === 'rush';
  const map = MAP_CONFIGS[game.mapId];
  const placementMode = isWallMode(mode);
  const legalHover = hover ? rushMode ? canPlaceViewedWall(view, hover, isPhantomMode(mode)) : isLegalWall(game, hover, activeId) : false;
  const breakable = view.walls.filter(wall => wall.owner === 'red');
  const energy = view.rush?.energy.blue ?? 0;
  const assistCount = view.rush?.assists.blue ?? 0;
  const activeWalls = activePlayer?.wallsRemaining ?? 0;
  const boardWidth = game.width * 100 - 12;
  const boardHeight = game.height * 100 - 12;
  const arenaMax = game.height > game.width ? Math.max(320, Math.round(700 * game.width / game.height)) : 700;
  const denseBoard = Math.max(game.width, game.height) >= 15;
  const boardStyle = { aspectRatio: `${boardWidth}/${boardHeight}` } as CSSProperties;
  const gridStyle = { gridTemplateColumns: `repeat(${game.width},minmax(0,1fr))`, gridTemplateRows: `repeat(${game.height},minmax(0,1fr))`, columnGap: `${12 / boardWidth * 100}%`, rowGap: `${12 / boardHeight * 100}%` } as CSSProperties;

  function captureEvent(next: GameState) {
    const event = viewForPlayer(next, 'blue').rush?.event;
    if (event && ['break', 'reveal', 'tile'].includes(event.kind)) setFlash({ id: next.ply, kind: event.kind as Flash['kind'], text: event.text, wall: event.wall });
    return event;
  }

  useEffect(() => {
    const actorId = currentPlayerId(game);
    const actor = activePlayerStates(game).find(player => player.id === actorId);
    if (!started || !actor || actor.controller !== 'AI' || game.winner) return;
    setThinking(true);
    const timer = window.setTimeout(() => {
      const decision = chooseAIActionWithDebug(game, game.mode === 'convergence' ? actor.difficulty : difficulty, actorId);
      const action = decision.action;
      if (debugAI) setAIExplanation(decision.explanation);
      const next = action ? applyAction(game, action) : null;
      if (action && next) {
        setGame(next); const event = next.mode === 'rush' ? captureEvent(next) : null;
        setNotice(next.winner ? next.winner === 'draw' ? 'The match ends in a draw.' : `${activePlayerStates(next).find(player => player.id === next.winner)?.label ?? 'AI'} wins.` : event?.text ?? `${actor.label} ${describeAction(action)}.`);
      }
      setThinking(false);
    }, 420);
    return () => window.clearTimeout(timer);
  }, [game, difficulty, started, debugAI]);

  useEffect(() => { if (!flash) return; const timer = window.setTimeout(() => setFlash(null), 1800); return () => window.clearTimeout(timer); }, [flash]);

  function play(action: Action) {
    if (!canAct) return;
    const next = applyAction(game, action);
    if (!next) {
      setNotice(action.type === 'wall' || action.type === 'phantom' ? 'That barrier intersects another or would seal a route.' : action.type === 'assist' ? 'Assist needs one charge and two open orthogonal steps.' : action.type === 'break' ? 'Choose an enemy wall with at least 4 Energy.' : action.type === 'probe' ? 'Probe a neighboring barrier.' : 'That move is not available.');
      return;
    }
    setGame(next); setHover(null); if (!['move', 'probe'].includes(action.type)) setMode('move');
    const event = next.mode === 'rush' ? captureEvent(next) : null;
    const actor = activePlayer;
    setNotice(next.winner ? next.winner === 'draw' ? 'The match ends in a draw.' : `${actor.label} wins.` : event?.text ?? `${actor.label} ${describeAction(action)}.`);
  }

  function rematch() {
    const next = rematchGame(game); setGame(next); setMode('move'); setHover(null); setThinking(false); setFlash(null); setBoardZoom(false);
    setAIExplanation('');
    setNotice(next.mode === 'rush' ? `Fresh ${MAP_CONFIGS[next.mapId].name} board. New rewards, new route.` : `Fresh ${MAP_CONFIGS[next.mapId].name} board. Your move.`);
  }
  function startMatch(options: NewGameOptions, selectedDifficulty: Difficulty) {
    const next = newGame(options); setGame(next); setDifficulty(selectedDifficulty); setStarted(true); setMode('move'); setHover(null); setFlash(null); setBoardZoom(false); setAIExplanation('');
    setNotice(next.mode === 'rush' ? `Rush begins on ${MAP_CONFIGS[next.mapId].name}. One Assist is ready.` : `Classic begins on ${MAP_CONFIGS[next.mapId].name}.`);
  }
  function selectWall(orientation: Wall['orientation']) { setMode(isPhantomMode(mode) ? `phantom-${orientation}` : orientation); setHover(null); }
  function selectPhantom() { setMode(isPhantomMode(mode) ? wallOrientation(mode) : `phantom-${wallOrientation(mode)}`); setHover(null); }
  if (online) return <OnlineApp onExit={() => setOnline(null)} initialConfiguration={online === 'join' ? undefined : online} />;
  if (!started) return <ModePicker onStart={startMatch} onOnline={configuration => setOnline(configuration ?? 'join')} />;
  if (game.mode === 'convergence') return <ConvergenceMatch game={game} pending={thinking} onAction={action => { const actor = activePlayerStates(game).find(player => player.id === currentPlayerId(game)); if (actor?.controller !== 'HUMAN_LOCAL') return false; const next = applyAction(game, action); if (!next) return false; setGame(next); return true; }} onRematch={rematch} onMainMenu={() => setStarted(false)} />;

  const goalMarks = Array.from({ length: Math.min(game.width, 12) });
  return <div className={`app-shell ${rushMode ? 'rush-shell' : ''} map-${game.mapId} layout-${game.layout} ${game.winner ? 'match-ended' : ''}`}>
    <header className="topbar"><div className="brand" aria-label="GridBreak"><span className="brand-mark"><i /><i /><i /><i /></span><span>GRID<span className="brand-light">BREAK</span></span></div>
      <div className="topbar-right"><span className="edition">{`${map.name.toUpperCase()} / ${game.layout.toUpperCase()} / ${game.width}×${game.height}`}</span><button className="restart-top mode-change" onClick={() => setStarted(false)}>Modes</button><button className="restart-top" onClick={rematch}><span>↺</span> Rematch</button></div></header>
    <main className="main-layout">
      <aside className="intro-panel"><div className="eyebrow"><span className="signal-dot" /> {rushMode ? 'RUSH MODE · LOCAL AI' : sharedClassic ? 'CLASSIC · SHARED DEVICE' : 'CLASSIC · LOCAL AI'}</div><h1>Make<br /><em>your way.</em></h1>
        <p className="lede">{rushMode ? 'One Assist. Hidden rewards. Break the route open before the clock closes.' : 'Race across the grid. Shift the route. Every turn is progress or pressure.'}</p>
        <div className="rule-note"><span className="rule-icon">↗</span><span>Reach the <strong>{goalLabel(game.goals.blue).toLowerCase()}</strong> before the rival reaches {goalLabel(game.goals.red).toLowerCase()}.</span></div>
        <div className="how-to"><span>01 / THE RULES</span><p>{rushMode ? 'Assist crosses two legal edges and is consumed. Boost rewards add one Assist up to two. Pawn collision jumps remain part of normal movement.' : 'Move one space or place one two-edge barrier. Barriers can never close every route.'}</p></div></aside>
      <section className="arena" style={{ maxWidth: arenaMax }} aria-label={`${game.width} by ${game.height} GridBreak board`}>
        <div className="arena-top"><div className="player-tag red"><span className="player-orb" /><span className="player-copy"><small>{sharedClassic ? 'PLAYER 2' : 'OPPONENT'}</small><strong>{sharedClassic ? 'RED' : 'RIVAL'}</strong>{rushMode && <EnergyMeter player="red" energy={view.rush!.energy.red} assists={view.rush!.assists.red} />}</span></div>
          <div className="objective blue-objective"><span>BLUE → {goalLabel(game.goals.blue)}</span><div className="objective-line">{goalMarks.map((_, i) => <i key={i} />)}</div></div><div className="wall-chip red"><strong>{game.remaining.red.toString().padStart(2, '0')}</strong><span>WALLS</span></div></div>
        <div className="mobile-toolbar" role="group" aria-label="Current player action"><button className={mode === 'move' ? 'selected' : ''} onClick={() => { setMode('move'); setHover(null); }} disabled={!canAct}>✣ <span>Move</span></button><button className={mode.endsWith('horizontal') ? 'selected' : ''} onClick={() => selectWall('horizontal')} disabled={!canAct || activeWalls === 0}>━ <span>Wall —</span></button><button className={mode.endsWith('vertical') ? 'selected' : ''} onClick={() => selectWall('vertical')} disabled={!canAct || activeWalls === 0}>┃ <span>Wall |</span></button></div>
        {rushMode && <div className="mobile-abilities" role="group" aria-label="Rush abilities"><button className={mode === 'assist' ? 'selected' : ''} onClick={() => setMode('assist')} disabled={!canAct || assistCount === 0}>↗ Assist <small>×{assistCount}</small></button><button className={mode === 'break' ? 'selected' : ''} onClick={() => setMode('break')} disabled={!canAct || energy < 4 || !breakable.length}>✳ Break <small>{energy < 4 ? 'NEED 4' : !breakable.length ? 'NO WALL' : '4 EN'}</small></button><button className={isPhantomMode(mode) ? 'selected phantom-selected' : ''} onClick={selectPhantom} disabled={!canAct || !view.rush?.ownPhantomAvailable || game.remaining.blue === 0}>◇ Phantom <small>{view.rush?.ownPhantomAvailable ? 'READY' : 'USED'}</small></button></div>}
        {denseBoard && <button className="board-zoom-toggle" onClick={() => setBoardZoom(value => !value)} aria-pressed={boardZoom}>{boardZoom ? 'Fit board' : 'Zoom board ×2'}</button>}
        <div className={`board-viewport ${boardZoom ? 'zoomed' : ''}`}><div className="board-frame"><div className={`board rush-effect-${game.rush?.event?.kind ?? 'none'} ${game.winner ? `winner-${game.winner}` : ''}`} style={boardStyle} data-mode={mode}>
          <div className="cell-grid" style={gridStyle}>{coords.map(point => {
            const legal = canAct && mode === 'move' && moves.some(move => samePoint(move, point));
            const probe = canAct && mode === 'move' && probes.some(target => samePoint(target, point));
            const assisted = canAct && mode === 'assist' ? assists.find(path => samePoint(path.to, point)) : undefined;
            const tile = view.rush?.tiles.find(item => !item.consumed && samePoint(item.point, point));
            const available = legal || probe || !!assisted;
            return <button key={`${point.row}-${point.col}`} className={`cell ${legal ? 'legal' : ''} ${probe ? 'probe-target' : ''} ${assisted ? 'assist-target' : ''} ${pointInGoal(point, game.goals.blue, game) ? 'blue-goal' : ''} ${pointInGoal(point, game.goals.red, game) ? 'red-goal' : ''}`} type="button" aria-label={`Cell ${labelPoint(point)}${tile ? `, ${tile.kind === 'boost' ? 'Assist' : 'Energy'} reward` : ''}${probe ? ', probe wall' : assisted ? ', Assist destination' : legal ? ', legal move' : ''}`} disabled={!available}
              onClick={() => assisted ? play({ type: 'assist', via: assisted.via, to: assisted.to }) : probe ? play({ type: 'probe', to: point }) : play({ type: 'move', to: point })}>
              {tile && <span className={`power-tile ${tile.kind}`} aria-hidden="true">{tile.kind === 'energy' ? '⚡' : '↗'}</span>}{available && <span className={`move-indicator ${probe ? 'probe-indicator' : assisted ? 'assist-indicator' : ''}`} />}</button>;
          })}</div>
          <div className="piece blue-piece" style={piecePosition(game.pawns.blue, boardWidth, boardHeight)} aria-label="Your blue piece"><span /></div><div className="piece red-piece" style={piecePosition(game.pawns.red, boardWidth, boardHeight)} aria-label="Rival red piece"><span /></div>
          <svg className={`wall-layer ${(placementMode || mode === 'break') && canAct ? 'active' : ''}`} viewBox={`0 0 ${boardWidth} ${boardHeight}`} aria-label="Wall placement points">
            {view.walls.map(wall => { const target = mode === 'break' && canAct && wall.owner === 'red'; return <g key={wallKey(wall)} className={`placed-wall ${wall.orientation} ${wall.knownPhantom ? 'own-phantom' : ''} ${target ? 'breakable' : ''}`} role={target ? 'button' : undefined} tabIndex={target ? 0 : undefined} onClick={target ? () => play({ type: 'break', wall }) : undefined} onKeyDown={target ? event => { if (event.key === 'Enter' || event.key === ' ') play({ type: 'break', wall }); } : undefined}><rect {...wallRect(wall)} rx="6" /></g>; })}
            {flash?.wall && <rect className="shatter-ghost" {...wallRect(flash.wall)} rx="6" />}{placementMode && canAct && hover && <rect className={`wall-preview ${legalHover ? 'allowed' : 'denied'} ${isPhantomMode(mode) ? 'phantom-preview' : ''}`} {...wallRect(hover)} rx="6" />}
            {placementMode && canAct && anchors.map(anchor => { const wall: Wall = { ...anchor, orientation: wallOrientation(mode) }; const legal = rushMode ? canPlaceViewedWall(view, wall, isPhantomMode(mode)) : isLegalWall(game, wall, activeId); const x = anchor.col * 100 + 94; const y = anchor.row * 100 + 94; return <g key={`${anchor.row}-${anchor.col}`} className={`anchor ${legal ? 'available' : 'unavailable'}`} role="button" tabIndex={legal ? 0 : -1} onPointerEnter={() => setHover(wall)} onPointerLeave={() => setHover(null)} onClick={() => legal && play(isPhantomMode(mode) ? { type: 'phantom', wall } : { type: 'wall', wall })} onKeyDown={event => { if (legal && (event.key === 'Enter' || event.key === ' ')) play(isPhantomMode(mode) ? { type: 'phantom', wall } : { type: 'wall', wall }); }}><rect className="anchor-hit" x={x - 35} y={y - 35} width="70" height="70" /><circle cx={x} cy={y} r={legal ? 6 : 3} /></g>; })}
          </svg>
          {flash && <div key={flash.id} className={`signature-toast ${flash.kind}`} role="status"><strong>{flash.kind === 'break' ? 'WALL SHATTERED' : flash.kind === 'reveal' ? 'PHANTOM EXPOSED' : 'REWARD COLLECTED'}</strong><span>{flash.text}</span></div>}
          {game.winner && <div className={`match-result ${game.winner === 'blue' || sharedClassic ? 'victory' : game.winner === 'red' ? 'defeat' : 'draw'}`} role="dialog" aria-modal="true" aria-label="Match result"><div className="result-particles" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} />)}</div><small>MATCH COMPLETE</small><strong>{game.winner === 'draw' ? 'DRAW' : sharedClassic ? `${players.find(player => player.id === game.winner)?.label.toUpperCase()} WINS` : game.winner === 'blue' ? 'VICTORY' : 'DEFEAT'}</strong><span>{game.winner === 'draw' ? 'Routes held in balance.' : 'Route secured.'}</span><div className="result-actions"><button onClick={rematch}>↺ REMATCH</button><button className="result-menu" onClick={() => setStarted(false)}>MAIN MENU</button></div></div>}
        </div></div></div>
        <div className="arena-bottom"><div className="player-tag blue"><span className="player-orb" /><span className="player-copy"><small>{sharedClassic ? 'PLAYER 1' : 'YOU'} · REACH {goalLabel(game.goals.blue)}</small><strong>BLUE</strong>{rushMode && <EnergyMeter player="blue" energy={energy} assists={assistCount} />}</span></div><div className="objective"><span>RED → {goalLabel(game.goals.red)}</span><div className="objective-line">{goalMarks.map((_, i) => <i key={i} />)}</div></div><div className="wall-chip blue"><strong>{game.remaining.blue.toString().padStart(2, '0')}</strong><span>WALLS</span></div></div>
      </section>
      <aside className="control-panel"><div className="panel-heading"><span className="panel-index">02 / CONTROL ROOM</span><span className="live-pip">LIVE MATCH</span></div><div className="turn-card"><div className="turn-card-top"><span>{rushMode ? `${map?.name.toUpperCase()} / CURRENT TURN` : 'CURRENT TURN'}</span><span className="turn-symbol">{game.winner ? '◆' : activePlayer.token}</span></div><strong>{game.winner ? game.winner === 'draw' ? 'Draw' : sharedClassic ? `${players.find(player => player.id === game.winner)?.label} wins` : game.winner === 'blue' ? 'Victory' : 'Defeat' : thinking ? `${activePlayer.label} thinking` : `${activePlayer.label}'s move`}</strong><p>{notice}</p></div>
        {rushMode && <><div className={`rush-status ${view.rush?.suddenDeath ? 'sudden' : ''}`}>{view.rush?.suddenDeath ? <><strong>⚡ SUDDEN DEATH</strong><span>{Math.max(0, map.deadlinePly - game.ply)} turns remain · wall reserves fade</span></> : <><strong>MOMENTUM <span>{view.rush?.momentum.blue}/3</span></strong><span>Progress charges Energy · chain 3 for +1 bonus</span></>}</div><div className="rush-meta"><span>{map.name.toUpperCase()} · {game.layout.toUpperCase()}</span><span>SEED <strong>{view.rush?.seed}</strong>{view.rush?.seedLocked ? ' 🔒' : ''}</span><span>TURN {game.ply}/{map.deadlinePly}</span></div></>}
        {debugAI && aiExplanation && <pre className="ai-debug" aria-label="AI turn explanation">{aiExplanation}</pre>}
        <div className="control-group actions-group"><div className="control-label"><span>CURRENT ACTION</span><small>ONE PER TURN</small></div><button className={`action-button ${mode === 'move' ? 'selected' : ''}`} onClick={() => { setMode('move'); setHover(null); }} disabled={!canAct}><span className="action-icon move-icon">✣</span><span><strong>Move</strong><small>Advance one cell</small></span><span className="action-check">{mode === 'move' ? '●' : '○'}</span></button><div className="wall-actions"><button className={`action-button ${mode.endsWith('horizontal') ? 'selected' : ''}`} onClick={() => selectWall('horizontal')} disabled={!canAct || activeWalls === 0}><span className="action-icon wall-icon horizontal-icon" /><span><strong>Wall</strong><small>Horizontal</small></span></button><button className={`action-button ${mode.endsWith('vertical') ? 'selected' : ''}`} onClick={() => selectWall('vertical')} disabled={!canAct || activeWalls === 0}><span className="action-icon wall-icon vertical-icon" /><span><strong>Wall</strong><small>Vertical</small></span></button></div>
          {rushMode && <div className="rush-actions"><button className={`rush-action ${mode === 'assist' ? 'selected' : ''}`} onClick={() => setMode('assist')} disabled={!canAct || assistCount === 0} title="Spend one scarce Assist to cross two legal edges"><span>↗</span><strong>Assist</strong><small>×{assistCount}</small></button><button className={`rush-action ${mode === 'break' ? 'selected' : ''}`} onClick={() => setMode('break')} disabled={!canAct || energy < 4 || !breakable.length}><span>✳</span><strong>Break</strong><small>{energy < 4 ? 'NEED 4 EN' : !breakable.length ? 'NO TARGET' : '4 EN'}</small></button><button className={`rush-action ${isPhantomMode(mode) ? 'selected phantom-selected' : ''}`} onClick={selectPhantom} disabled={!canAct || !view.rush?.ownPhantomAvailable || game.remaining.blue === 0}><span>◇</span><strong>Phantom</strong><small>{view.rush?.ownPhantomAvailable ? 'READY' : 'USED'}</small></button></div>}
        </div>
        <div className="hint-box"><span className="hint-spark">✳</span><p>{mode === 'break' ? 'Tap an enemy barrier to shatter it.' : mode === 'assist' ? `Choose a glowing two-step route. ${assistCount} charge${assistCount === 1 ? '' : 's'} held.` : placementMode ? isPhantomMode(mode) ? 'Place your decoy at a glowing junction.' : 'Tap a glowing junction to set a barrier.' : rushMode ? '⚡ rewards add Energy. ↗ rewards add one Assist, up to two.' : 'Tap a glowing cell to move.'}</p></div>
        {!sharedClassic && <div className="control-group difficulty-group"><div className="control-label"><span>RIVAL INTELLIGENCE</span><small>LOCAL AI</small></div><div className="difficulty-switch" role="group">{(['easy', 'normal', 'hard'] as const).map(level => <button key={level} className={difficulty === level ? 'active' : ''} onClick={() => setDifficulty(level)}>{level}</button>)}</div></div>}<div className="route-readout"><div><small>BLUE ROUTE</small><strong>{blueRoute}<span>steps</span></strong></div><div><small>RED ROUTE</small><strong>{redRoute}<span>steps</span></strong></div></div><button className="restart-bottom" onClick={rematch}><span>↺</span> Rematch · {view.rush?.seedLocked ? 'same seed' : rushMode ? 'new seed' : 'same rules'} <span>↗</span></button><button className="change-mode-bottom" onClick={() => setStarted(false)}>Choose another mode, map, or layout</button>
      </aside>
    </main><footer className="footer"><span>GRIDBREAK / {map.name.toUpperCase()} {game.layout.toUpperCase()} {rushMode ? 'RUSH' : 'CLASSIC'}</span><span>BUILT FOR THE NEXT MOVE.</span></footer>
  </div>;
}
