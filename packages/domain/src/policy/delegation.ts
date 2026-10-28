/** T037准备切片：多层授权委派链。逐段validateGrant并累计深度；任一段越权/超深即整链拒绝；
 * 返回终端有效深度供绑定/派发层使用。纯函数。 */
import { validateGrant, type DenialReason, type GrantValidation, type PermissionProfile } from "./index.js";

export interface DelegationLink {
  /** 本段受让方档案（必须已过parsePermissionProfile，含其delegableActions与maxDelegationDepth）。 */
  readonly profile: PermissionProfile;
  /** 本段起始深度：首段为0，后续为上一段结果。 */
  readonly depth: number;
}

export type ChainValidation =
  | { readonly valid: true; readonly finalDepth: number; readonly links: number }
  | { readonly valid: false; readonly failedAtIndex: number; readonly reason: DenialReason };

/** 校验委托链 links[i]→links[i+1]：每段按validateGrant（授予⊆可委派、路径收窄、深度递减）。 */
export function validateDelegationChain(links: readonly DelegationLink[]): ChainValidation {
  if (links.length === 0) return { valid: false, failedAtIndex: 0, reason: "DELEGATION_DEPTH_EXCEEDED" };
  for (let index = 1; index < links.length; index++) {
    const parent = links[index - 1];
    const child = links[index];
    if (parent === undefined || child === undefined) return { valid: false, failedAtIndex: index, reason: "DELEGATION_DEPTH_EXCEEDED" };
    if (child.depth !== parent.depth + 1) return { valid: false, failedAtIndex: index, reason: "DELEGATION_DEPTH_EXCEEDED" };
    const result: GrantValidation = validateGrant(parent.profile, child.profile, child.depth);
    if (!result.valid) return { valid: false, failedAtIndex: index, reason: result.reason };
  }
  const last = links[links.length - 1];
  if (last === undefined) return { valid: false, failedAtIndex: 0, reason: "DELEGATION_DEPTH_EXCEEDED" };
  return { valid: true, finalDepth: last.depth, links: links.length - 1 };
}
