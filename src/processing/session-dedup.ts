const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface SessionData {
  atomIds: Set<string>;
  createdAt: number;
}

const sessions = new Map<string, SessionData>();

function getSessionKey(sessionId?: string): string {
  if (sessionId) return sessionId;
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}`;
}

function getOrCreateSession(sessionId?: string): SessionData {
  const key = getSessionKey(sessionId);
  let session = sessions.get(key);

  if (session && Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(key);
    session = undefined;
  }

  if (!session) {
    session = { atomIds: new Set(), createdAt: Date.now() };
    sessions.set(key, session);
  }

  return session;
}

export function getServedIds(sessionId?: string): Set<string> {
  return new Set(getOrCreateSession(sessionId).atomIds);
}

export function recordServed(atomIds: string[], sessionId?: string): void {
  const session = getOrCreateSession(sessionId);
  for (const id of atomIds) {
    session.atomIds.add(id);
  }
}

export function clearSession(sessionId?: string): void {
  const key = getSessionKey(sessionId);
  sessions.delete(key);
}

export function dedup<T extends { atom: { id: string } }>(
  items: T[],
  sessionId?: string,
): T[] {
  const served = getServedIds(sessionId);
  if (served.size === 0) return items;

  const fresh: T[] = [];
  const seen: T[] = [];

  for (const item of items) {
    if (served.has(item.atom.id)) {
      seen.push(item);
    } else {
      fresh.push(item);
    }
  }

  // Fresh items first, then previously-served (demoted, not removed)
  return [...fresh, ...seen];
}
