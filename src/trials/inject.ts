// Scenario overrides for red-team trials. Empty in normal operation.
export const inject: { supplierNote: Record<string, string> } = { supplierNote: {} };
export const clearInjections = () => { inject.supplierNote = {}; };
