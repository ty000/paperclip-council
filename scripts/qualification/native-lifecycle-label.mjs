/** Shared only by the deterministic launcher, its scenario and its final assertion. */
export function nativeLifecycleLabel(env = process.env) {
  if (env.COUNCIL_N5_CONTINUATION === "1") return "N5 CONTINUATION";
  if (env.COUNCIL_N5_NATIVE_LIFECYCLE === "1") return "N5";
  return env.COUNCIL_N3_NATIVE_LIFECYCLE === "1" ? "N3" : "N2";
}
