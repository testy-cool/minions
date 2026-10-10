import { expect, mock, test } from 'claude-code/testing'

const BASE = '/x/teresa/.pi/extensions/pi-emote'
const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const png = (name: string) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })
const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, title: '', isFocused: false } as any

function fakeSet(on: any) {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })
  on('session.root', () => ({ value: '/x/teresa' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('fs.read', () => ({ value: JSON.stringify({ emotes: [{ model: '*', 'emote-set': 'pm' }] }) }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', ($: any, e: any) => {
    const path = typeof e === 'string' ? e : e.path
    if (path === `${BASE}/emotes/pm`) return { value: [dir('hi'), dir('idle'), png('sheet.png')] }
    if (path.endsWith('/hi')) return { value: [png('hi1.png'), png('hi2.png')] }
    if (path.endsWith('/idle')) return { value: [png('idle.png'), png('idle_blink.png')] }
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

test('draws nothing of its own without a portrait set', async ($, on) => {
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
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ text: 'Reading notes.md' })).toBeDefined()
  expect(await ui.find({ text: 'Show working tree status' })).toBeDefined()
  expect(await ui.find({ text: /git status/ })).toBeUndefined()
})
