/**
 * Public surface of the Remotion project template + manifest→code generator (Task
 * #16). A pure, non-DBOS module: a template file set plus a deterministic
 * `manifest → generated files` function, shared by the future scaffold (Task 17) and
 * commit (Task 21) DBOS steps.
 */
export {
  generateManifestFiles,
  generateProjectFiles,
  generateStaticFiles,
  serializeManifest,
  type GeneratedFile,
} from "./generate";
export { applyManifest, writeRemotionScaffold } from "./scaffold";
export { assignSceneFileNames, toComponentName, type AssignedScene } from "./naming";
export { canonicalizeManifest } from "./manifest-json";
export { REACT_VERSION, REMOTION_VERSION } from "./versions";
