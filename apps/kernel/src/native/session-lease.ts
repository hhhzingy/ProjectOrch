import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseSessionRef, sameSession, type SessionRef } from "@projectorch/adapter-contract";

/** 可信Supervisor共用同一固定目录；占位残留绝不按PID/时钟自动抢占。 */
export class NativeSessionLease {
  readonly #filename: string;
  readonly #fd: number;
  readonly #token = randomUUID();
  #released = false;
  readonly #session: SessionRef;
  private constructor(filename: string, fd: number, session: SessionRef) { this.#filename = filename; this.#fd = fd; this.#session = session; }
  /** 只核对路径，不创建会话或占位；供外部副作用之前使用。 */
  static assertDirectory(directory: string): void {
    if (!path.isAbsolute(directory) || /^(?:\\\\|\/\/)/.test(directory)) throw new Error("LOCAL_LEASE_DIRECTORY_REQUIRED");
    for (let cursor = path.resolve(directory); ; cursor = path.dirname(cursor)) {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_LEASE_DIRECTORY");
      if (path.dirname(cursor) === cursor) break;
    }
  }
  /** 受信启动器准备专用目录；先核对已有祖先，不能穿过链接创建。 */
  static prepareDirectory(directory: string): void {
    if (!path.isAbsolute(directory) || /^(?:\\\\|\/\/)/.test(directory)) throw new Error("LOCAL_LEASE_DIRECTORY_REQUIRED");
    for (let cursor = path.resolve(directory); ; cursor = path.dirname(cursor)) {
      if (existsSync(cursor)) { const stat = lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_LEASE_DIRECTORY"); }
      if (path.dirname(cursor) === cursor) break;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.assertDirectory(directory);
  }
  static acquire(directory: string, input: SessionRef): NativeSessionLease {
    const ref = parseSessionRef(input);
    this.assertDirectory(directory);
    // workspace是上下文；同一原生ID换workspace不能取得第二份owner占位。
    const key = createHash("sha256").update(JSON.stringify([ref.harnessId, ref.hostId, ref.profileId, ref.nativeConversationId])).digest("hex");
    const filename = path.join(realpathSync(directory), `${key}.lease`);
    if(existsSync(filename+'.recovery'))throw new Error('NATIVE_OWNER_RECOVERY_ACTIVE');
    let fd: number;
    try { fd = openSync(filename, "wx+", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("NATIVE_OWNER_OCCUPIED");
      throw new Error("LEASE_CREATE_FAILED");
    }
    const lease = new NativeSessionLease(filename, fd, ref);
    try { writeFileSync(fd, JSON.stringify({ version: 1, token: lease.#token, pid: process.pid })); fsyncSync(fd); }
    catch { closeSync(fd); throw new Error("LEASE_WRITE_UNCERTAIN"); } // 写入失败也留下占位，不冒险自动接管。
    return lease;
  }
  /** 只供已验证精确原生终态的生产驱动调用；PID死亡仅为额外条件，不能单独解锁。 */
  static recoverAfterTerminal(directory:string,input:SessionRef,terminal:{session:SessionRef;executionId:string;terminalConfirmed:boolean;status:string}):void{
    const ref=parseSessionRef(input);
    if(!sameSession(ref,parseSessionRef(terminal.session))||!terminal.executionId||terminal.terminalConfirmed!==true||!['completed','failed','interrupted'].includes(terminal.status))throw new Error('LEASE_TERMINAL_PROOF_REQUIRED');
    this.assertDirectory(directory);
    const key=createHash('sha256').update(JSON.stringify([ref.harnessId,ref.hostId,ref.profileId,ref.nativeConversationId])).digest('hex');
    const filename=path.join(realpathSync(directory),`${key}.lease`),lock=filename+'.recovery';
    let recoveryFd:number;
    try{recoveryFd=openSync(lock,'wx',0o600);}catch{throw new Error('NATIVE_OWNER_RECOVERY_ACTIVE');}
    try{
      if(!existsSync(filename))return;
      const stat=lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error('LEASE_IDENTITY_CHANGED');
      const bytes=readFileSync(filename),old=JSON.parse(bytes.toString('utf8')) as {pid?:number;token?:string;version?:number};
      if(old.version!==1||!Number.isSafeInteger(old.pid)||!old.pid||old.pid<1||!old.token)throw new Error('LEASE_IDENTITY_CHANGED');
      // 当前或仍存活/无法判断的持有者不接替；业务终态本身也不允许抢活owner。
      try{process.kill(old.pid,0);throw new Error('NATIVE_OWNER_STILL_ALIVE');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
      const current=lstatSync(filename);
      if(current.ino!==stat.ino||current.dev!==stat.dev||current.size!==stat.size||!readFileSync(filename).equals(bytes))throw new Error('LEASE_IDENTITY_CHANGED');
      unlinkSync(filename);
    }finally{closeSync(recoveryFd);unlinkSync(lock);}
  }
  /** 仅可信进程管理器提供退出证明；不向模型/Web暴露，不以lease释放替代原生核对。 */
  releaseAfterExit(confirmed: boolean): void {
    if (!confirmed || this.#released) throw new Error("LEASE_RELEASE_FORBIDDEN");
    this.assertCurrent(this.#session);
    unlinkSync(this.#filename); closeSync(this.#fd); this.#released = true;
  }
  /** 只验证本实例实际持有的文件和完整会话，不把本地租约本身当作原生隔离证明。 */
  assertCurrent(session: SessionRef): void {
    if (this.#released || !sameSession(this.#session, parseSessionRef(session))) throw new Error("LEASE_SESSION_MISMATCH");
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(this.#filename); } catch { throw new Error("LEASE_IDENTITY_CHANGED"); }
    const held = fstatSync(this.#fd);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== held.ino || stat.dev !== held.dev || stat.size !== held.size) throw new Error("LEASE_IDENTITY_CHANGED");
    let content: { token?: unknown };
    try {
      if (held.size > 4096) throw new Error();
      const buffer = Buffer.alloc(held.size);
      if (readSync(this.#fd, buffer, 0, buffer.length, 0) !== buffer.length) throw new Error();
      content = JSON.parse(buffer.toString("utf8"));
    } catch { throw new Error("LEASE_IDENTITY_CHANGED"); }
    if (content.token !== this.#token) throw new Error("LEASE_IDENTITY_CHANGED");
  }
}
