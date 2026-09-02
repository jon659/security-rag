import { handle } from "hono/aws-lambda";
import { wire } from "./wire.js";

const { app } = wire();
export const handler = handle(app);
