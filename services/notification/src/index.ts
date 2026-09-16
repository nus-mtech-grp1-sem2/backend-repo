import "dotenv/config";
import { createApp } from "./app.js";

const SERVICE = "notification";
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3006);

createApp().listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
});
