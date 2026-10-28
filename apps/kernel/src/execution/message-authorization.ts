import type { Store } from '@projectorch/persistence';
import { NativeRpcError } from '../native/stdio-peer.js';
import { readProjectPolicy } from '../auth/project-policy.js';

/** 原始授权在队列中可能已撤销。只读当前主体记录，不复活/重签已撤销凭据。 */
export function assertMessageSenderAuthorized(store: Store, messageId: string, now: number, trustedLocalUserId?: string): void {
  const deny = (): never => { throw new NativeRpcError('MESSAGE_SENDER_AUTHORIZATION_EXPIRED','not_sent'); };
  const source = store.db.prepare('SELECT m.project_id AS p,m.to_role_id AS target,c.source_principal_id AS source,c.id AS command FROM messages m JOIN commands c ON c.id=m.command_id AND c.project_id=m.project_id WHERE m.id=?').get(messageId) as {p:string;target:string;source:string;command:string}|undefined;
  if (!source) deny();
  const row = source!;
  if (trustedLocalUserId && row.source === trustedLocalUserId) return;
  if (/^control-[a-f0-9]{64}$/.test(row.source)) {
    const grant = store.db.prepare('SELECT project_id,permissions_json FROM control_entries WHERE token_hash=? AND revoked_at IS NULL AND created_at<=? AND expires_at>?').get(row.source.slice(8),now,now) as {project_id:string;permissions_json:string}|undefined;
    if (!grant || (grant.project_id!=='*' && grant.project_id!==row.p)) deny();
    const actions:unknown = JSON.parse(grant!.permissions_json);
    if (!Array.isArray(actions) || !actions.includes('message.send')) deny();
    return;
  }
  // Agent消息必须有真实命令作用域及仍有效的原始凭据/绑定；历史无来源记录不猜填。
  const agent=store.db.prepare(`SELECT r.permission_profile AS profile,r.permission_profile_revision AS rev,r.id AS role FROM agent_command_scopes scope
    JOIN agent_credentials c ON c.id=scope.credential_id AND c.project_id=scope.project_id
    JOIN role_bindings b ON b.id=c.binding_id AND b.epoch=c.binding_epoch AND b.project_id=c.project_id AND b.ended_at IS NULL
    JOIN roles r ON r.id=b.role_id AND r.project_id=b.project_id AND r.desired_state='enabled' AND r.binding_state='ready'
    WHERE scope.command_id=? AND scope.project_id=? AND c.revoked_at IS NULL AND c.created_at<=? AND c.expires_at>?`).get(row.command,row.p,now,now) as {profile:string;rev:number;role:string}|undefined;
  if (!agent) deny();
  const policy=readProjectPolicy(store.db,row.p);
  const profile=policy.profiles.find(p=>p.id===agent!.profile && p.revision===agent!.rev);
  if (!profile || !profile.actions.includes('message.send') || (profile.roleIds.length>0 && !profile.roleIds.includes(row.target))) deny();
}
