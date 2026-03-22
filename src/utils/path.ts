/** Convert a project path to Claude Code's dirName encoding */
export function pathToDirName(projectPath: string): string {
  const resolved = projectPath.replace(/\/+$/, "");
  return resolved.replace(/[/_.]/g, "-");
}
