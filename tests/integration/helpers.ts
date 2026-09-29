import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

export const app = createApp();
export const api = () => request(app);

/** Empties every table between tests. */
export async function resetDb() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

let phoneCounter = 0;
export function nextPhone() {
  phoneCounter += 1;
  return `98${String(10_000_000 + phoneCounter).slice(-8)}`;
}

export type Owner = { token: string; userId: number };

export async function signupOwner(name = "Owner"): Promise<Owner> {
  const res = await api()
    .post("/v1/auth/signup")
    .send({ name, identifier: nextPhone(), password: "password123" });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.data.accessToken, userId: res.body.data.userId };
}

export async function createLibrary(owner: Owner, seatCount = 5) {
  const res = await api()
    .post("/v1/libraries")
    .set(auth(owner.token))
    .send({ name: "Focus Library", address: "Sector 14, Hisar", seatCount });
  if (res.status !== 201) throw new Error(`create library failed: ${JSON.stringify(res.body)}`);
  const seats = await api().get(`/v1/libraries/${res.body.data.id}/seats`).set(auth(owner.token));
  return { id: res.body.data.id as number, seats: seats.body.data as Array<{ id: number; label: string }> };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export function addStudent(
  token: string,
  libraryId: number,
  overrides: {
    seatId: number;
    startTime?: string;
    endTime?: string;
    startDate?: string;
    days?: number;
    fee?: number;
    payment?: { amount: number; mode: string } | null;
    name?: string;
  },
) {
  const { seatId, startTime = "09:00", endTime = "17:00", startDate, days = 30, fee = 1000 } = overrides;
  return api()
    .post(`/v1/libraries/${libraryId}/students`)
    .set(auth(token))
    .send({
      name: overrides.name ?? "Ravi Kumar",
      phone: nextPhone(),
      membership: { seatId, startTime, endTime, days, fee, ...(startDate ? { startDate } : {}) },
      ...(overrides.payment === null
        ? {}
        : { payment: overrides.payment ?? { amount: fee, mode: "CASH" } }),
    });
}
