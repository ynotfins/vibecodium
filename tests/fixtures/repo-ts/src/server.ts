import { AuthMiddleware } from './auth/middleware';
import { createSession, SessionStore } from './auth/session';

export const defaultPort = 8080;

export interface ServerOptions {
  port: number;
  sessions: SessionStore;
}

export function createServer(options: ServerOptions) {
  const middleware = new AuthMiddleware(options.sessions);
  return { options, middleware, listen: (): number => options.port };
}

export class HttpServer {
  constructor(private readonly options: ServerOptions) {}

  start(): number {
    return createServer(this.options).listen();
  }
}