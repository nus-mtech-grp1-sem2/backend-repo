import "dotenv/config";
import express from "express";

/**
 * Auth service.
 *
 * Event-specific Organizer and Helper access is owned by the Event service's
 * event_team_memberships table, not Cognito groups, so this service currently
 * has nothing to do beyond reporting that it's up.
 */

const SERVICE = "auth";
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3007);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: SERVICE });
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
});
