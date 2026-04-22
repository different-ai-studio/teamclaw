export function getCommandText(
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return "";
  return (
    (typeof args.command === "string" ? args.command : null) ||
    (typeof args.cmd === "string" ? args.cmd : null) ||
    (typeof args.input === "string" ? args.input : null) ||
    ""
  );
}

export function getToolCallOutputText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const resultObj = result as Record<string, unknown>;
    return (
      (typeof resultObj.raw === "string" ? resultObj.raw : null) ||
      (typeof resultObj.output === "string" ? resultObj.output : null) ||
      (typeof resultObj.result === "string" ? resultObj.result : null) ||
      (typeof resultObj.text === "string" ? resultObj.text : null) ||
      ""
    );
  }
  return "";
}
