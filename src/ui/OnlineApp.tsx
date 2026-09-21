import { useEffect, useRef, useState } from 'react';
import { MAP_CONFIGS, type MatchConfiguration } from '../game/modes';
import type { PlayerId } from '../game/state';
import { ONLINE_SERVER_URL, OnlineConnection, clearOnlineSession, createOnlineRoom, joinOnlineRoom, loadOnlineSession, saveOnlineSession, type ConnectionState, type StoredOnlineSession } from '../online/client';
import type { OnlineErrorCode, PublicRoomState, RoomAdmission } from '../online/protocol';
import ConvergenceMatch from './ConvergenceMatch';
import OnlineRaceMatch from './OnlineRaceMatch';

type Screen = 'menu' | 'create' | 'join' | 'room';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The online service could not complete that request.';
const configLabel = (configuration: MatchConfiguration) => `${configuration.mode.toUpperCase()} · ${MAP_CONFIGS[configuration.mapId].name} · ${configuration.layout === 'convergence' ? 'CENTER' : configuration.layout.toUpperCase()} · ${configuration.playerCount} PLAYERS`;

export default function OnlineApp({ onExit, initialConfiguration }: { onExit: () => void; initialConfiguration?: MatchConfiguration }) {
  const [screen, setScreen] = useState<Screen>(initialConfiguration ? 'create' : 'menu');
  const [displayName, setDisplayName] = useState(() => loadOnlineSession()?.displayName ?? '');
  const [roomCode, setRoomCode] = useState('');
  const [room, setRoom] = useState<PublicRoomState | null>(null);
  const [stored, setStored] = useState<StoredOnlineSession | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
  const [pending, setPending] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const connection = useRef<OnlineConnection | null>(null);
  const [resumable, setResumable] = useState<StoredOnlineSession | null>(() => loadOnlineSession());
  useEffect(() => () => connection.current?.close(), []);

  function connectSession(session: StoredOnlineSession, initial: PublicRoomState | null) {
    connection.current?.close(); setStored(session); setRoom(initial); setScreen('room'); setError('');
    const next = new OnlineConnection(session, initial, { onSnapshot: snapshot => { setRoom(snapshot); setError(''); }, onConnection: setConnectionState, onError: (_code: OnlineErrorCode | 'NETWORK_ERROR', message: string) => setError(message), onPending: setPending });
    connection.current = next; next.connect();
  }
  function acceptAdmission(admission: RoomAdmission, name: string) {
    const session = { roomCode: admission.room.code, displayName: name.trim(), credentials: admission.credentials };
    saveOnlineSession(session); setResumable(session); connectSession(session, admission.room);
  }
  async function create() {
    if (!initialConfiguration) return;
    setBusy(true); setError('');
    try { acceptAdmission(await createOnlineRoom(displayName, initialConfiguration), displayName); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function join() {
    setBusy(true); setError('');
    try { acceptAdmission(await joinOnlineRoom(displayName, roomCode), displayName); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  function leaveOnline() { connection.current?.close(); connection.current = null; setRoom(null); setStored(null); setPending(false); onExit(); }

  if (screen === 'room' && stored && room?.game && (room.phase === 'playing' || room.phase === 'finished')) {
    const own = room.members.find(member => member.isSelf)!;
    const status = Object.fromEntries(room.members.map(member => [member.playerId, member.connection === 'connected' ? 'online' : member.connection === 'reconnecting' ? 'reconnecting…' : 'disconnected'])) as Record<PlayerId, string>;
    const common = { localPlayerId: room.selfPlayerId, pending: pending || connectionState !== 'connected', connectionLabel: connectionState.toUpperCase(), memberStatus: status, onAction: (action: Parameters<OnlineConnection['sendGameAction']>[0]) => connection.current?.sendGameAction(action) ?? false, onRematch: () => { if (!own.rematchVote) connection.current?.sendRematch(true); }, rematchLabel: own.rematchVote ? 'VOTE SENT' : 'VOTE REMATCH', onMainMenu: leaveOnline };
    return <div className="online-match-wrap" data-room-code={room.code} data-room-sequence={room.sequence} data-online-mode={room.configuration.mode}>
      {error && <div className="online-match-error" role="alert">{error}</div>}
      {room.configuration.mode === 'convergence'
        ? <ConvergenceMatch game={room.game} online {...common} />
        : <OnlineRaceMatch view={room.game} {...common} />}
    </div>;
  }

  if (screen === 'room' && stored) {
    const own = room?.members.find(member => member.isSelf); const host = own?.isHost === true;
    const required = room?.configuration.playerCount ?? 0;
    const canStart = !!room && room.phase === 'ready' && room.members.length === required && room.members.every(member => member.ready && member.connection === 'connected');
    return <div className="online-screen" data-room-code={room?.code ?? stored.roomCode} data-room-sequence={room?.sequence ?? -1}><header className="topbar"><div className="brand"><span className="brand-mark"><i /><i /><i /><i /></span><span>GRID<span className="brand-light">BREAK</span></span></div><button className="restart-top mode-change" onClick={leaveOnline}>Main Menu</button></header>
      <main className="online-room-shell"><div className="eyebrow"><span className={`signal-dot ${connectionState}`} /> ONLINE · {connectionState.toUpperCase()}</div>
        <section className="online-room-heading"><div><small>PRIVATE UNLISTED ROOM</small><h1>{room?.code ?? stored.roomCode}</h1><p>Share this code with invited players. The host selected the authoritative match configuration.</p></div><div className="room-config">{room ? <><span>{room.configuration.mode.toUpperCase()} · {MAP_CONFIGS[room.configuration.mapId].name}</span><strong>{room.configuration.layout.toUpperCase()} · {required} PLAYERS</strong></> : <strong>CONNECTING</strong>}</div></section>
        {error && <p className="online-error" role="alert">{error}</p>}
        {!room ? <div className="online-waiting"><span className="online-spinner" /> Restoring authoritative room state…</div> : room.phase === 'abandoned' || room.phase === 'expired' ? <div className="online-terminal"><strong>{room.phase.toUpperCase()}</strong><p>This room is no longer active.</p><button onClick={leaveOnline}>MAIN MENU</button></div> : <>
          <div className="online-member-list" aria-label="Room players">{Array.from({ length: required }, (_, index) => { const member = room.members[index]; return <div className={`online-member ${member?.ready ? 'ready' : ''}`} key={member?.playerId ?? index}><b>{index + 1}</b><span><strong>{member?.displayName ?? 'Waiting for player…'}</strong><small>{member ? `${member.playerId.toUpperCase()} · ${member.connection}${member.isHost ? ' · HOST' : ''}` : 'OPEN SLOT'}</small></span><em>{member?.ready ? '✓ READY' : member ? 'NOT READY' : '—'}</em></div>; })}</div>
          <div className="online-lobby-actions"><button className="online-ready" disabled={!own || pending || connectionState !== 'connected'} onClick={() => connection.current?.sendReady(!own?.ready)}>{own?.ready ? 'CANCEL READY' : 'READY UP'}</button>{host ? <button className="online-start" disabled={!canStart || pending} onClick={() => connection.current?.sendStart()}>START MATCH <span>↗</span></button> : <div className="host-wait">HOST STARTS WHEN EVERYONE IS READY</div>}</div>
          <p className="disconnect-policy">Disconnected players keep their seat. Turns wait for reconnect and never skip silently.</p>
        </>}
      </main></div>;
  }

  const form = screen === 'create' || screen === 'join';
  return <div className="online-screen"><header className="topbar"><div className="brand"><span className="brand-mark"><i /><i /><i /><i /></span><span>GRID<span className="brand-light">BREAK</span></span></div><button className="restart-top mode-change" onClick={onExit}>Main Menu</button></header>
    <main className="online-entry-shell"><div className="eyebrow"><span className="signal-dot" /> ONLINE MULTIPLAYER V2</div><h1>Enter the<br /><em>same match.</em></h1><p>Online is a private, server-authoritative way to play Classic, Rush, or Convergence.</p>
      {!ONLINE_SERVER_URL && <p className="online-error" role="alert">Online server is not configured for this deployment.</p>}
      {screen === 'menu' && <div className="online-entry-actions"><button onClick={() => setScreen('join')}><small>JOIN</small><strong>ROOM CODE</strong><span>The room provides its mode, map, and layout.</span></button>{resumable && <button className="resume-room" onClick={() => connectSession(resumable, null)}><small>RECONNECT</small><strong>RESUME {resumable.roomCode}</strong><span>Restore this browser’s private seat.</span></button>}{resumable && <button className="forget-room" onClick={() => { clearOnlineSession(); setResumable(null); }}><small>SESSION</small><strong>FORGET SAVED ROOM</strong><span>Remove this browser’s reconnect credential.</span></button>}</div>}
      {form && <section className="online-form"><button className="online-back" onClick={() => initialConfiguration ? onExit() : setScreen('menu')}>← {initialConfiguration ? 'MATCH SETUP' : 'ONLINE MENU'}</button><label>DISPLAY NAME<input maxLength={20} autoComplete="nickname" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Your temporary name" /></label>
        {screen === 'create' && initialConfiguration ? <div className="online-selected-config"><small>HOSTING</small><strong>{configLabel(initialConfiguration)}</strong><span>The guest joins this exact configuration.</span></div> : <label>ROOM CODE<input value={roomCode} onChange={event => setRoomCode(event.target.value.toUpperCase())} placeholder="GB-X7K9" autoCapitalize="characters" /></label>}
        {error && <p className="online-error" role="alert">{error}</p>}<button className="online-submit" disabled={busy || !ONLINE_SERVER_URL} onClick={screen === 'create' ? create : join}>{busy ? 'CONNECTING…' : screen === 'create' ? 'CREATE PRIVATE ROOM' : 'JOIN PRIVATE ROOM'} <span>↗</span></button>
      </section>}
    </main></div>;
}
