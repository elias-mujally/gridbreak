import { useEffect, useRef, useState } from 'react';
import { MAP_CONFIGS, type ConvergencePlayerCount, type MapId } from '../game/modes';
import type { PlayerId } from '../game/state';
import {
  ONLINE_SERVER_URL, OnlineConnection, clearOnlineSession, createOnlineRoom, joinOnlineRoom,
  loadOnlineSession, saveOnlineSession, type ConnectionState, type StoredOnlineSession,
} from '../online/client';
import type { OnlineErrorCode, PublicRoomState, RoomAdmission } from '../online/protocol';
import ConvergenceMatch from './ConvergenceMatch';

type Screen = 'menu' | 'create' | 'join' | 'room';

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'The online service could not complete that request.';
}

export default function OnlineApp({ onExit }: { onExit: () => void }) {
  const [screen, setScreen] = useState<Screen>('menu');
  const [displayName, setDisplayName] = useState(() => loadOnlineSession()?.displayName ?? '');
  const [roomCode, setRoomCode] = useState('');
  const [mapId, setMapId] = useState<MapId>('grand');
  const [playerCount, setPlayerCount] = useState<ConvergencePlayerCount>(4);
  const [room, setRoom] = useState<PublicRoomState | null>(null);
  const [stored, setStored] = useState<StoredOnlineSession | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connection = useRef<OnlineConnection | null>(null);
  const [resumable, setResumable] = useState<StoredOnlineSession | null>(() => loadOnlineSession());

  useEffect(() => () => connection.current?.close(), []);

  function connectSession(session: StoredOnlineSession, initial: PublicRoomState | null) {
    connection.current?.close();
    setStored(session); setRoom(initial); setScreen('room'); setError('');
    const next = new OnlineConnection(session, initial, {
      onSnapshot: snapshot => { setRoom(snapshot); setError(''); },
      onConnection: setConnectionState,
      onError: (_code: OnlineErrorCode | 'NETWORK_ERROR', message: string) => setError(message),
      onPending: setPending,
    });
    connection.current = next; next.connect();
  }

  function acceptAdmission(admission: RoomAdmission, name: string) {
    const session = { roomCode: admission.room.code, displayName: name.trim(), credentials: admission.credentials };
    saveOnlineSession(session); setResumable(session); connectSession(session, admission.room);
  }

  async function create() {
    setBusy(true); setError('');
    try { acceptAdmission(await createOnlineRoom(displayName, mapId, playerCount), displayName); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function join() {
    setBusy(true); setError('');
    try { acceptAdmission(await joinOnlineRoom(displayName, roomCode), displayName); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  function leaveOnline() {
    connection.current?.close(); connection.current = null; setRoom(null); setStored(null); setPending(false); onExit();
  }

  if (screen === 'room' && stored && room?.game && (room.phase === 'playing' || room.phase === 'finished')) {
    const own = room.members.find(member => member.sessionId === stored.credentials.sessionId);
    const status = Object.fromEntries(room.members.map(member => [member.playerId, member.connection === 'connected' ? 'online' : member.connection === 'reconnecting' ? 'reconnecting…' : 'disconnected'])) as Record<PlayerId, string>;
    return <div className="online-match-wrap" data-room-code={room.code} data-room-sequence={room.sequence}>
      {error && <div className="online-match-error" role="alert">{error}</div>}
      <ConvergenceMatch game={room.game} localPlayerId={own?.playerId} pending={pending || connectionState !== 'connected'} online connectionLabel={connectionState.toUpperCase()} memberStatus={status}
        onAction={action => action.type === 'move' || action.type === 'wall' ? connection.current?.sendGameAction(action) ?? false : false}
        onRematch={() => { if (!own?.rematchVote) connection.current?.sendRematch(true); }} rematchLabel={own?.rematchVote ? 'VOTE SENT' : 'VOTE REMATCH'} onMainMenu={leaveOnline} />
    </div>;
  }

  if (screen === 'room' && stored) {
    const own = room?.members.find(member => member.sessionId === stored.credentials.sessionId);
    const host = room?.hostSessionId === stored.credentials.sessionId;
    const canStart = !!room && room.phase === 'ready' && room.members.length === room.requiredPlayers && room.members.every(member => member.ready && member.connection === 'connected');
    return <div className="online-screen" data-room-code={room?.code ?? stored.roomCode} data-room-sequence={room?.sequence ?? -1}><header className="topbar"><div className="brand"><span className="brand-mark"><i /><i /><i /><i /></span><span>GRID<span className="brand-light">BREAK</span></span></div><button className="restart-top mode-change" onClick={leaveOnline}>Main Menu</button></header>
      <main className="online-room-shell">
        <div className="eyebrow"><span className={`signal-dot ${connectionState}`} /> ONLINE · {connectionState.toUpperCase()}</div>
        <section className="online-room-heading"><div><small>PRIVATE UNLISTED ROOM</small><h1>{room?.code ?? stored.roomCode}</h1><p>Share this code with the invited players. Internal room IDs and session credentials stay hidden.</p></div><div className="room-config"><span>{room ? MAP_CONFIGS[room.mapId].name : 'Connecting'}</span><strong>{room?.requiredPlayers ?? '—'} PLAYERS</strong></div></section>
        {error && <p className="online-error" role="alert">{error}</p>}
        {!room ? <div className="online-waiting"><span className="online-spinner" /> Restoring authoritative room state…</div> : room.phase === 'abandoned' || room.phase === 'expired' ? <div className="online-terminal"><strong>{room.phase.toUpperCase()}</strong><p>This room is no longer active.</p><button onClick={leaveOnline}>MAIN MENU</button></div> : <>
          <div className="online-member-list" aria-label="Room players">{Array.from({ length: room.requiredPlayers }, (_, index) => {
            const member = room.members[index];
            return <div className={`online-member ${member?.ready ? 'ready' : ''}`} key={member?.sessionId ?? index}><b>{index + 1}</b><span><strong>{member?.displayName ?? 'Waiting for player…'}</strong><small>{member ? `${member.playerId.toUpperCase()} · ${member.connection}` : 'OPEN SLOT'}</small></span><em>{member?.ready ? '✓ READY' : member ? 'NOT READY' : '—'}</em></div>;
          })}</div>
          <div className="online-lobby-actions">
            <button className="online-ready" disabled={!own || pending || connectionState !== 'connected'} onClick={() => connection.current?.sendReady(!own?.ready)}>{own?.ready ? 'CANCEL READY' : 'READY UP'}</button>
            {host ? <button className="online-start" disabled={!canStart || pending} onClick={() => connection.current?.sendStart()}>START MATCH <span>↗</span></button> : <div className="host-wait">HOST STARTS WHEN EVERYONE IS READY</div>}
          </div>
          <p className="disconnect-policy">Disconnected players keep their seat. Turns are never skipped; the room waits for reconnect.</p>
        </>}
      </main></div>;
  }

  return <div className="online-screen"><header className="topbar"><div className="brand"><span className="brand-mark"><i /><i /><i /><i /></span><span>GRID<span className="brand-light">BREAK</span></span></div><button className="restart-top mode-change" onClick={onExit}>Main Menu</button></header>
    <main className="online-entry-shell">
      <div className="eyebrow"><span className="signal-dot" /> ONLINE MULTIPLAYER V1</div>
      <h1>Enter the<br /><em>same grid.</em></h1>
      <p>Private Convergence rooms for two to four guests. Every move is validated by the authoritative server.</p>
      {!ONLINE_SERVER_URL && <p className="online-error" role="alert">Online server is not configured for this deployment.</p>}
      {screen === 'menu' && <div className="online-entry-actions"><button onClick={() => setScreen('create')}><small>01 / HOST</small><strong>CREATE ROOM</strong><span>Choose a map and player count.</span></button><button onClick={() => setScreen('join')}><small>02 / GUEST</small><strong>JOIN ROOM</strong><span>Enter an unlisted room code.</span></button>{resumable && <button className="resume-room" onClick={() => connectSession(resumable, null)}><small>RECONNECT</small><strong>RESUME {resumable.roomCode}</strong><span>Restore this browser’s temporary session.</span></button>}{resumable && <button className="forget-room" onClick={() => { clearOnlineSession(); setResumable(null); setError(''); }}><small>SESSION</small><strong>FORGET SAVED ROOM</strong><span>Remove this browser’s reconnect credential.</span></button>}</div>}
      {(screen === 'create' || screen === 'join') && <section className="online-form">
        <button className="online-back" onClick={() => { setScreen('menu'); setError(''); }}>← ONLINE MENU</button>
        <label>DISPLAY NAME<input maxLength={20} autoComplete="nickname" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Your temporary name" /></label>
        {screen === 'create' ? <><div className="online-choice-label">CONVERGENCE MAP</div><div className="online-map-options">{(['arena', 'grand', 'titan'] as const).map(id => <button className={mapId === id ? 'chosen' : ''} onClick={() => { setMapId(id); if (id === 'arena') setPlayerCount(2); }} key={id}><strong>{MAP_CONFIGS[id].name}</strong><span>{MAP_CONFIGS[id].convergence!.width}×{MAP_CONFIGS[id].convergence!.height}</span></button>)}</div><div className="online-choice-label">PLAYERS</div><div className="online-count-options">{([2, 3, 4] as const).filter(count => MAP_CONFIGS[mapId].convergence!.supportedPlayerCounts.includes(count)).map(count => <button className={playerCount === count ? 'chosen' : ''} onClick={() => setPlayerCount(count)} key={count}>{count}</button>)}</div></> : <label>ROOM CODE<input value={roomCode} onChange={event => setRoomCode(event.target.value.toUpperCase())} placeholder="GB-X7K9" autoCapitalize="characters" /></label>}
        {error && <p className="online-error" role="alert">{error}</p>}
        <button className="online-submit" disabled={busy || !ONLINE_SERVER_URL} onClick={screen === 'create' ? create : join}>{busy ? 'CONNECTING…' : screen === 'create' ? 'CREATE PRIVATE ROOM' : 'JOIN PRIVATE ROOM'} <span>↗</span></button>
      </section>}
    </main></div>;
}
