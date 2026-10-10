import readOnlySuite, { deploymentOptions } from "./read-only.js";

export const options = deploymentOptions();
export { readOnlyJourney, securityProbe, setup } from "./read-only.js";
export default readOnlySuite;
