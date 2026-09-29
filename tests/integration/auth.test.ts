import { beforeEach, describe, expect, it } from "vitest";
import { api, auth, nextPhone, resetDb } from "./helpers";

beforeEach(resetDb);

describe("auth", () => {
  it("signs up, logs in and gives a 14-day trial", async () => {
    const phone = nextPhone();
    const signup = await api()
      .post("/v1/auth/signup")
      .send({ name: "Asha", identifier: phone, password: "password123" });
    expect(signup.status).toBe(201);

    const me = await api().get("/v1/me").set(auth(signup.body.data.accessToken));
    expect(me.body.data.user.phone).toBe(`+91${phone}`);
    const trialDays =
      (new Date(me.body.data.organization.trialEndsAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(trialDays)).toBe(14);

    const login = await api().post("/v1/auth/login").send({ identifier: `+91 ${phone}`, password: "password123" });
    expect(login.status).toBe(200);
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    const phone = nextPhone();
    await api().post("/v1/auth/signup").send({ name: "Asha", identifier: phone, password: "password123" });

    const wrongPassword = await api().post("/v1/auth/login").send({ identifier: phone, password: "nope-nope" });
    const unknown = await api().post("/v1/auth/login").send({ identifier: nextPhone(), password: "nope-nope" });
    expect(wrongPassword.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknown.body);
  });

  it("refuses a duplicate account", async () => {
    const phone = nextPhone();
    await api().post("/v1/auth/signup").send({ name: "Asha", identifier: phone, password: "password123" });
    const again = await api().post("/v1/auth/signup").send({ name: "Asha", identifier: phone, password: "password123" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ACCOUNT_EXISTS");
  });

  it("rotates refresh tokens and revokes them on logout", async () => {
    const signup = await api()
      .post("/v1/auth/signup")
      .send({ name: "Asha", identifier: "asha@example.com", password: "password123" });
    const first = signup.body.data.refreshToken;

    const refreshed = await api().post("/v1/auth/refresh").send({ refreshToken: first });
    expect(refreshed.status).toBe(200);

    // The old refresh token no longer works once rotated.
    const reused = await api().post("/v1/auth/refresh").send({ refreshToken: first });
    expect(reused.status).toBe(401);

    const logout = await api().post("/v1/auth/logout").set(auth(refreshed.body.data.accessToken)).send({});
    expect(logout.status).toBe(204);
    const afterLogout = await api().post("/v1/auth/refresh").send({ refreshToken: refreshed.body.data.refreshToken });
    expect(afterLogout.status).toBe(401);
  });

  it("logs out other devices on password change", async () => {
    const phone = nextPhone();
    const deviceA = await api().post("/v1/auth/signup").send({ name: "Asha", identifier: phone, password: "password123" });
    const deviceB = await api().post("/v1/auth/login").send({ identifier: phone, password: "password123" });

    const change = await api()
      .post("/v1/me/password")
      .set(auth(deviceA.body.data.accessToken))
      .send({ currentPassword: "password123", newPassword: "newpassword456" });
    expect(change.status).toBe(204);

    expect((await api().post("/v1/auth/refresh").send({ refreshToken: deviceB.body.data.refreshToken })).status).toBe(401);
    expect((await api().post("/v1/auth/refresh").send({ refreshToken: deviceA.body.data.refreshToken })).status).toBe(200);
  });

  it("rejects requests without a valid token", async () => {
    expect((await api().get("/v1/me")).status).toBe(401);
    expect((await api().get("/v1/me").set(auth("garbage"))).body.error.code).toBe("INVALID_TOKEN");
  });
});
