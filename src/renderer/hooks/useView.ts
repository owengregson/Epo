/**
 * The console's former view keys. The view router is gone (the console column
 * shows the live state; everything else is a stage); this type survives only
 * for the interim Settings view's navigation prop, which the shell maps onto
 * stages, and goes with that view.
 */
export type ViewKey = 'overview' | 'chain' | 'queues' | 'settings';
