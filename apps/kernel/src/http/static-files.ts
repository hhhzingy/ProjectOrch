/** T043准备切片：本地静态资源服务。仅服务固定WEB_DIST目录；路径单一相对语法（穿越/绝对/反斜杠拒绝）；
 * 解析后realpath不得逃逸目录（junction/符号链接拒绝）；扩展名白名单Content-Type；只支持GET/HEAD；未认证可达（配对登录面）。 */
import { createReadStream, lstatSync, realpathSync, statSync, type ReadStream } from "node:fs";
import path from "node:path";
import { isWellFormedRelativePath } from "@projectorch/domain/policy";
import { GatewayError } from "./local-gateway.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };

export class StaticFileSource {
  readonly #root: string;
  readonly #rootReal: string;
  constructor(webDistDir: string) {
    const resolved = path.resolve(webDistDir);
    this.#root = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
    try { this.#rootReal = realpathSync.native(resolved); } catch { throw new Error("STATIC_ROOT_UNRESOLVED"); }
    const stat = lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("STATIC_ROOT_INVALID");
  }
  /** 返回安全打开的文件流；任何越界/特殊文件/未知扩展名一律404（不泄露存在性）。 */
  open(urlPath: string): { readonly stream: ReadStream; readonly contentType: string; readonly byteSize: number } {
    if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
    if (!urlPath.startsWith("/") || !isWellFormedRelativePath(urlPath.slice(1))) throw new GatewayError(404, "NOT_FOUND");
    const extension = path.extname(urlPath).toLowerCase();
    const contentType = CONTENT_TYPES[extension];
    if (!contentType) throw new GatewayError(404, "NOT_FOUND");
    const absolute = path.join(this.#root, urlPath.replaceAll("/", path.sep));
    let real: string;
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new GatewayError(404, "NOT_FOUND");
      real = realpathSync.native(absolute);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(404, "NOT_FOUND");
    }
    const rootReal = this.#rootReal.endsWith(path.sep) ? this.#rootReal : this.#rootReal + path.sep;
    if (!real.startsWith(rootReal)) throw new GatewayError(404, "NOT_FOUND");
    const byteSize = statSync(absolute).size;
    return { stream: createReadStream(absolute), contentType, byteSize };
  }
}
