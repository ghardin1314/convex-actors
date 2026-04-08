import { defineApp } from "convex/server";
import actors from "./components/actors/convex.config.js";

const app = defineApp();
app.use(actors);
export default app;