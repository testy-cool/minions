import { expect, mock, test } from 'claude-code/testing'

const BASE = '/x/teresa/.pi/extensions/pi-emote'
const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const png = (name: string) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })
const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, title: '', isFocused: false } as any

function fakeSet(on: any, config: object = {}, idle = ['idle.png', 'idle_blink.png']) {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })
  on('command.register', () => ({ value: undefined }) as any)
  on('session.root', () => ({ value: '/x/teresa' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('fs.read', () => ({ value: JSON.stringify({ emotes: [{ model: '*', 'emote-set': 'pm' }], ...config }) }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', ($: any, e: any) => {
    const path = typeof e === 'string' ? e : e.path
    if (path === `${BASE}/emotes/pm`) return { value: [dir('hi'), dir('idle'), png('sheet.png')] }
    if (path.endsWith('/hi')) return { value: [png('hi1.png'), png('hi2.png')] }
    if (path.endsWith('/idle')) return { value: idle.map(png) }
    return { value: [] }
  })
}

test('greets with the set\'s hi frame on session start', async ($, on) => {
  fakeSet(on)
  const clock = mock.clock(on)
  const blits: string[] = []
  on('ui.blit', ($: any, e: any) => { blits.push(e.source.file); return { value: {} } })
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  const image = await ui.find({ type: 'Image' })
  expect(JSON.stringify(image)).toContain(`${BASE}/emotes/pm/hi/hi1.png`)

  await clock.advance(2100)
  expect(blits).toContain(`${BASE}/emotes/pm/hi/hi2.png`)
  expect(blits.at(-1)).toBe(`${BASE}/emotes/pm/idle/idle.png`)
})

test('a minion whose config asks for more rows gets a bigger face', async ($, on) => {
  fakeSet(on, { avatarRows: 6 })
  mock.clock(on)
  on('ui.blit', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  const image: any = await ui.find({ type: 'Image' })
  expect(image.props.rows).toBe(6)
  expect(image.props.columns).toBe(12)
})

test('a minion whose config asks for a plain face shows its frames as drawn', async ($, on) => {
  fakeSet(on, { avatarPlain: true })
  mock.clock(on)
  const runs: string[][] = []
  on('process.run', ($: any, e: any) => { runs.push(e.argv ?? e); return { value: { exitCode: 0, stdout: '', stderr: '' } } as any })
  on('ui.blit', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  const image = await ui.find({ type: 'Image' })
  expect(JSON.stringify(image)).toContain(`${BASE}/emotes/pm/hi/hi1.png`)
  expect(JSON.stringify(runs)).not.toContain('scanline')
})

test('a face is 4 rows by 8 columns when the config names no size', async ($, on) => {
  fakeSet(on)
  mock.clock(on)
  on('ui.blit', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  const image: any = await ui.find({ type: 'Image' })
  expect(image.props.rows).toBe(4)
  expect(image.props.columns).toBe(8)
  const box: any = await ui.find({ key: 'band' })
  expect(box.props.marginTop).toBe(0)
})

test('a minion whose config asks for a top margin gets its band pushed down', async ($, on) => {
  fakeSet(on, { avatarMarginTop: 2 })
  mock.clock(on)
  on('ui.blit', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  const box: any = await ui.find({ key: 'band' })
  expect(box.props.marginTop).toBe(2)
})

test('a face has no top margin when the config names a bad one', async ($, on) => {
  fakeSet(on, { avatarMarginTop: 9 })
  mock.clock(on)
  on('ui.blit', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  const box: any = await ui.find({ key: 'band' })
  expect(box.props.marginTop).toBe(0)
})

test('/portrait picks up a changed config without a restart', async ($, on) => {
  const config: any = {}
  fakeSet(on, config)
  mock.clock(on)
  on('ui.blit', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  config.avatarRows = 6
  config.avatarPlain = true
  config.avatarMarginTop = 1
  const said = await $.command.run({ command: 'portrait', args: '' } as any)
  expect(JSON.stringify(said)).toContain('Portrait reloaded')
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  const image: any = await ui.find({ type: 'Image' })
  expect(image.props.rows).toBe(6)
  expect(((await ui.find({ key: 'band' })) as any).props.marginTop).toBe(1)
  expect(image.props.source.file).toBe(`${BASE}/emotes/pm/hi/hi1.png`)
})

test('a state drawn as numbered loop frames plays them in order, over and over', async ($, on) => {
  fakeSet(on, {}, ['loop_003.png', 'loop_001.png', 'loop_002.png'])
  const clock = mock.clock(on)
  const blits: string[] = []
  on('ui.blit', ($: any, e: any) => { blits.push(e.source.file); return { value: {} } })
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  await clock.advance(2100)
  blits.length = 0
  await clock.advance(2000)
  const idle = blits.filter(f => f.includes('/idle/')).map(f => f.split('/').at(-1) ?? '')
  const order = ['loop_001.png', 'loop_002.png', 'loop_003.png']
  expect(idle.length).toBeGreaterThan(4)
  idle.slice(1).forEach((f, i) => expect(order.indexOf(f)).toBe((order.indexOf(idle[i]!) + 1) % 3))
})

test('bounce frames run forward then backward, with no repeat at the turns', async ($, on) => {
  fakeSet(on, {}, ['bounce_001.png', 'bounce_002.png', 'bounce_003.png'])
  const clock = mock.clock(on)
  const blits: string[] = []
  on('ui.blit', ($: any, e: any) => { blits.push(e.source.file); return { value: {} } })
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  await clock.advance(2100)
  blits.length = 0
  await clock.advance(2200)
  const seen = blits.filter(f => f.includes('/idle/')).map(f => f.split('/').at(-1) ?? '').join(' ')
  expect(seen).toContain('bounce_001.png bounce_002.png bounce_003.png bounce_002.png bounce_001.png bounce_002.png')
})

test('draws nothing of its own without a portrait set', async ($, on) => {
  on('command.register', () => ({ value: undefined }) as any)
  on('session.root', () => ({ value: '/x/elsewhere' }))
  on('session.model', () => ({ value: 'm' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  mock.clock(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e) as any; return <Text>engine</Text> })
  on('session.start', () => ({ cwd: '/x' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ text: 'engine' })).toBeDefined()
})

test('the history beside the face lists finished steps in plain words', async ($, on) => {
  fakeSet(on)
  mock.clock(on)
  on('ui.blit', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/x' }) as any)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/x/teresa/notes.md' } as any)
  await $.tool.call({ tool: 'Bash', command: 'git status --short', description: 'Show working tree status' } as any)
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect(await ui.find({ text: 'Reading notes.md' })).toBeDefined()
  expect(await ui.find({ text: 'Show working tree status' })).toBeDefined()
  expect(await ui.find({ text: /git status/ })).toBeUndefined()
})

test('a file deep in a long path is named in full', async ($, on) => {
  fakeSet(on)
  mock.clock(on)
  on('ui.blit', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/x' }) as any)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as any)
  await $.session.start({ cwd: '/x' } as any)
  await $.tool.call({ tool: 'Write', file_path: `/x/${'deep/'.repeat(20)}capture-fix.md` } as any)
  const ui = await $.ui.mount({ plugin: 'minion-avatar', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ text: 'Writing capture-fix.md' })).toBeDefined()
})
