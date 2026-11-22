import { requireUser } from '../auth/middleware';

export async function getUser(context: { userId: string }): Promise<{ id: string }> {
  const id = requireUser(context);
  return { id };
}

export const userRoute = '/api/users/:id';