import readOnlySuite, { deploymentOptions, setup as suiteSetup } from "./read-only.js";

export const options = deploymentOptions();
export const setup = suiteSetup;
export default readOnlySuite;
