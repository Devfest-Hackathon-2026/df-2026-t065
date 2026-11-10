// TEST ONLY: registers tsHooks.mjs (see there).
import { register } from "node:module";

register("./tsHooks.mjs", import.meta.url);
