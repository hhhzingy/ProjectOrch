/** 严格 JSON 规范化；只用于稳定摘要和比较，不接受 SQL 或动态执行定义。 */
export function canonicalJson(input: unknown): string {
  const ancestors = new Set<object>();
  const encode = (value: unknown, depth: number): string => {
    if (depth > 32) throw new Error("JSON_TOO_DEEP");
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (!value || typeof value !== "object") throw new Error("NON_JSON_VALUE");
    if (ancestors.has(value)) throw new Error("CYCLIC_JSON");
    if (Object.getOwnPropertySymbols(value).length) throw new Error("NON_JSON_PROPERTY");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(descriptors).some(key => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw new Error("NON_JSON_PROPERTY");
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const entry = descriptors[String(i)];
          if (!entry || !Object.hasOwn(entry, "value") || !entry.enumerable) throw new Error("NON_JSON_PROPERTY");
          items.push(encode(entry.value, depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("NON_JSON_OBJECT");
      const items: string[] = [];
      for (const key of Object.keys(descriptors).sort()) {
        const entry = descriptors[key];
        if (!entry || !Object.hasOwn(entry, "value") || !entry.enumerable) throw new Error("NON_JSON_PROPERTY");
        items.push(`${JSON.stringify(key)}:${encode(entry.value, depth + 1)}`);
      }
      return `{${items.join(",")}}`;
    } finally { ancestors.delete(value); }
  };
  const text = encode(input, 0);
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("JSON_TOO_LARGE");
  return text;
}
