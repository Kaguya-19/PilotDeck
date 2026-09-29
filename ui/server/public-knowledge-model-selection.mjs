/** Validate a formal browser search against the selected PilotDeck host catalog.
 * The selected model belongs to PD dialogue; SD's public retrieval stays lexical.
 */
export class PublicKnowledgeModelError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'PublicKnowledgeModelError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status) => { throw new PublicKnowledgeModelError(code, message, status); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function bindBrowserKnowledgeSearchModel(input, catalog) {
  if (!record(input) || !record(input.body)) fail('PUBLIC_INPUT_INVALID', 'Knowledge search requires a body.', 400);
  if (Object.hasOwn(input.body, 'model_config_id') || Object.hasOwn(input.body, 'modelConfigId')) {
    fail('PUBLIC_SD_MODEL_SELECTION_FORBIDDEN', 'SD model_config_id cannot select a PilotDeck model.', 400);
  }
  const requested = input.selectedPdModelId;
  if (typeof requested !== 'string' || !requested.trim() || requested !== requested.trim()) {
    fail('PUBLIC_PD_MODEL_SELECTION_REQUIRED', 'Select the current PilotDeck model for Knowledge search.', 400);
  }
  if (!record(catalog) || !Array.isArray(catalog.data)) {
    fail('PUBLIC_PD_MODEL_CATALOG_INVALID', 'The selected PilotDeck model catalog is unavailable.', 502);
  }
  const defaults = catalog.data.filter(item => record(item) && item.is_default === true);
  let selected;
  if (record(catalog.defaultSelection)) {
    const { provider, model, mode } = catalog.defaultSelection;
    if ((mode !== undefined && mode !== 'model') || typeof provider !== 'string' || typeof model !== 'string') {
      fail('PUBLIC_PD_MODEL_CATALOG_INVALID', 'The PilotDeck default model selection is invalid.', 502);
    }
    const id = `${provider}/${model}`;
    const matches = catalog.data.filter(item => record(item) && item.id === id && item.provider === provider && item.model === model);
    if (matches.length !== 1 || (defaults.length && (defaults.length !== 1 || defaults[0] !== matches[0]))) {
      fail('PUBLIC_PD_MODEL_CATALOG_INVALID', 'The PilotDeck default model does not match one catalog entry.', 502);
    }
    selected = matches[0];
  } else {
    if (defaults.length !== 1) fail('PUBLIC_PD_MODEL_CATALOG_INVALID', 'Exactly one current PilotDeck model is required.', 502);
    selected = defaults[0];
  }
  if (selected.id !== `${selected.provider}/${selected.model}` || typeof selected.id !== 'string') {
    fail('PUBLIC_PD_MODEL_CATALOG_INVALID', 'PilotDeck model IDs must be provider/model.', 502);
  }
  if (requested !== selected.id) {
    fail('PUBLIC_PD_MODEL_SELECTION_MISMATCH', 'The browser model differs from the current PilotDeck model.', 409);
  }
  if (selected.available !== undefined ? selected.available !== true : selected.enabled !== true) {
    fail('PUBLIC_PD_MODEL_UNAVAILABLE', 'The selected PilotDeck model is unavailable.', 409);
  }
  const { selectedPdModelId: _selection, ...publicInput } = input;
  return Object.freeze({
    input: { ...publicInput, body: { ...input.body } },
    selection: Object.freeze({ id: selected.id, model_use: 'pilotdeck_dialogue_only', retrieval_mode: 'staffdeck_public_lexical' }),
  });
}
