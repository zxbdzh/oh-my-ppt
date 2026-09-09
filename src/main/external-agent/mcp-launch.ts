export function resolveMcpLaunch(input: {
  executable: string
  packaged: boolean
  entry?: string
}): { executable: string; args: string[]; command: string; packaged: boolean } {
  const entry =
    !input.packaged && input.entry && !input.entry.startsWith('-') ? input.entry : undefined
  const args = entry ? [entry, '--mcp'] : ['--mcp']
  return {
    executable: input.executable,
    args,
    command: [input.executable, ...args].map(quoteCliArg).join(' '),
    packaged: input.packaged
  }
}

function quoteCliArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}
