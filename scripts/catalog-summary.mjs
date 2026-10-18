// Codex catalogs retain hidden model metadata for internal use and old sessions.
// Missing visibility is treated as visible for catalogs from older providers.
export function summarizeCatalog(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.some(model => !model || typeof model !== 'object'))
    throw Error('Invalid model catalog');
  const totalCount = catalog.models.length;
  const hiddenCount = catalog.models.filter(model => model.visibility === 'hide').length;
  return {count: totalCount - hiddenCount, totalCount, hiddenCount};
}
