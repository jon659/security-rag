import { serve } from "@hono/node-server";
import { wire } from "./wire.js";

const { app } = wire();
serve({ fetch: app.fetch, port: 3000 }, () => console.log("security-rag on http://localhost:3000"));
