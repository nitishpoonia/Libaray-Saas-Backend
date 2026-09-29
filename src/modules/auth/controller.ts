import type { Request, Response } from "express";
import { sendData } from "../../lib/http";
import { requireUser } from "../../middleware/libraryAccess";
import { loginBody, logoutBody, refreshBody, signupBody } from "./schemas";
import * as auth from "./service";

export async function signup(req: Request, res: Response) {
  const input = signupBody.parse(req.body);
  const { userId, tokens } = await auth.signup(input);
  sendData(res, { userId, ...tokens }, undefined, 201);
}

export async function login(req: Request, res: Response) {
  const input = loginBody.parse(req.body);
  const { userId, tokens } = await auth.login(input);
  sendData(res, { userId, ...tokens });
}

export async function refresh(req: Request, res: Response) {
  const { refreshToken } = refreshBody.parse(req.body);
  sendData(res, await auth.refresh(refreshToken));
}

export async function logout(req: Request, res: Response) {
  const user = requireUser(req);
  const { deviceToken } = logoutBody.parse(req.body ?? {});
  await auth.logout(user.id, user.sessionId, deviceToken);
  res.status(204).end();
}

export async function logoutAll(req: Request, res: Response) {
  const user = requireUser(req);
  await auth.revokeAllSessions(user.id);
  res.status(204).end();
}
