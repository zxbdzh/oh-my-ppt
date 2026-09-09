import { describe, expect, it } from 'vitest'
import { resolveMcpLaunch } from '../../../src/main/external-agent/mcp-launch'

describe('resolveMcpLaunch', () => {
  it('packaged app only needs --mcp', () => {
    expect(
      resolveMcpLaunch({
        executable: 'C:\\Program Files\\Oh My PPT\\Oh My PPT.exe',
        packaged: true,
        entry: 'C:\\ignored\\out\\main\\index.js'
      })
    ).toEqual({
      executable: 'C:\\Program Files\\Oh My PPT\\Oh My PPT.exe',
      args: ['--mcp'],
      command: '"C:\\Program Files\\Oh My PPT\\Oh My PPT.exe" --mcp',
      packaged: true
    })
  })

  it('dev launch includes the current main entry', () => {
    expect(
      resolveMcpLaunch({
        executable: 'C:\\electron.exe',
        packaged: false,
        entry: 'F:\\github\\oh-my-ppt\\out\\main\\index.js'
      })
    ).toEqual({
      executable: 'C:\\electron.exe',
      args: ['F:\\github\\oh-my-ppt\\out\\main\\index.js', '--mcp'],
      command: 'C:\\electron.exe F:\\github\\oh-my-ppt\\out\\main\\index.js --mcp',
      packaged: false
    })
  })
})
