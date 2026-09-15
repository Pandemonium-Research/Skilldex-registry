// Skillset coherence lives in @skilldex/validator, shared with skilldex.
//
// It was a port of skilldex's implementation, kept in sync by hand, under a header explaining that
// the two had been "diffed function-by-function and run against every real skillset to confirm
// identical output". That is not something anyone should have to do twice. What made the move safe
// is that this copy had already abstracted its I/O behind CoherenceSource — the checks never knew
// whether the bytes came from a working tree or a fetched blob — so there was nothing left to
// reconcile but the file itself.
//
// WHY THE REGISTRY COMPUTES THIS RATHER THAN TRUSTING THE CLI, unchanged by the move: the API is
// the trust boundary, not the CLI. Any holder of a publish token could POST a coherence score of
// their choosing, and since coherence is stored sortable, a self-reported value would be a
// forgeable ranking signal. `src/routes/skillsets-publish.ts` supplies the source, backed by the
// blobs it has already fetched.

export {
  checkSkillsetCoherence,
  parseDeclaredConventions,
  extractAssetReferences,
  parseMarkdownTables,
} from "@skilldex/validator";

export type {
  AssetReference,
  CoherenceCheck,
  CoherenceDiagnostic,
  CoherenceSource,
  DeclaredConvention,
  MarkdownTable,
  SkillsetCoherenceResult,
} from "@skilldex/validator";
