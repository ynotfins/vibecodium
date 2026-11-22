import { createHash } from 'node:crypto';

export interface SessionRecord {
  id: string;
  userId: string;
}

const MAX_SESSIONS = 1000;

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  put(record: SessionRecord): SessionRecord {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error('session limit reached');
    }
    this.sessions.set(record.id, record);
    return record;
  }

  get size(): number {
    return this.sessions.size;
  }
}

export function createSession(userId: string): SessionRecord {
  const id = createHash('sha256').update(userId).digest('hex');
  return { id, userId };
}
