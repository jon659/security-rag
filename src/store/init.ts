import { loadConfig } from "../config.js";
import { makeStore } from "./pg.js";

const cfg = loadConfig();
const store = makeStore(cfg.databaseUrl);
await store.init();
console.log("schema ready; chunks:", await store.count());
await store.close();
