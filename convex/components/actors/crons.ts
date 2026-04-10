import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval(
  "recovery scan",
  { minutes: 5 },
  internal.recovery.runRecoveryScan,
);

export default crons;
