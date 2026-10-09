/**
 * The page bundle's public surface — every function the Actor can call in the
 * tab, kept in a function-local `__epoPage` by `pageCall`.
 *
 * A version module builds a script as
 * `pageCall(fn, cfg)`, so adding a function
 * here is the only step needed to make it callable from page context.
 */

export type { ActionButtonCfg, ButtonState } from './action-button';
export { locateActionButton, probeActionButton } from './action-button';
export { canClick, clickTarget } from './click-target';
export type { ConfirmCfg } from './confirm';
export { locateConfirm } from './confirm';
export type { LocateRect, LocateScroll, Rect, RegexLit } from './dom';
export type { ConfirmRequestCfg, LabeledCfg, TextEntryCfg } from './drawer';
export { locateConfirmRequest, locateLabeled, locateTextEntry } from './drawer';
export type { AvatarAltCfg, ProfileLinkCfg } from './identity';
export { clickProfileLink, locateProfileLink, readAvatarAlt, readProfileHref } from './identity';
export type {
  InspectAncestor,
  InspectBannerCfg,
  InspectCfg,
  InspectRecord,
} from './inspect';
export { buildRecord, inspectBanner, inspectTick } from './inspect';
export type { Descriptor, LocateResult, Strategy } from './locate';
export { locate, probe } from './locate';
export type { BlockTextCfg, DialogCfg } from './probe';
export { blockText, dialogPresent } from './probe';
export { measureRendererCanary } from './renderer-canary';
export type { DrawerScrollCfg, ListScrollCfg } from './scroll';
export { locateDrawerScroll, locateScrollContainer } from './scroll';
export type { StatCfg } from './stat';
export { locateStat } from './stat';
