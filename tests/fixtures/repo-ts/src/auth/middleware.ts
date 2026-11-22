export interface AuthContext {
  userId: string;
}

export type Next = () => Promise<void>;

export class AuthMiddleware {
  constructor(private readonly sessions: SessionStore) {}

  async handle(context: AuthContext, next: Next): Promise<void> {
    if (!context.userId) {
      throw new Error('unauthenticated');
    }
    await next();
  }
}

export function requireUser(context: AuthContext): string {
  return context.userId;
}

export const authHeader = 'authorization';