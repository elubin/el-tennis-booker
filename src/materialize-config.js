import { materializeBookingConfigFromEnv } from "./config.js";

const result = materializeBookingConfigFromEnv();
if (result.created) {
  console.log(`Wrote ${result.path} from environment variables.`);
} else if (result.reason) {
  console.log(result.reason);
}