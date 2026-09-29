import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, lstatSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { prepareWorkspaceSkills } from '../workspace-skills.mjs'

const root = mkdtempSync(join(tmpdir(), 'devin-lite-skills-'))
const tempRoot = resolve(tmpdir()) + sep
assert.ok(resolve(root).startsWith(tempRoot), 'cleanup must stay inside the temp directory')

try {
  const parent = join(root, 'shared')
  const workspace = join(parent, 'project')
  const source = join(parent, '.agents', 'skills')
  const own = join(workspace, '.devin', 'skills', 'owned')
  for (const path of [join(source, 'owned'), join(source, 'shared'), own]) mkdirSync(path, { recursive: true })
  writeFileSync(join(parent, '.agents', 'AGENTS.md'), '# Shared skill index\n')
  writeFileSync(join(source, 'owned', 'SKILL.md'), 'PARENT_OWNED\n')
  writeFileSync(join(source, 'shared', 'SKILL.md'), 'PARENT_SHARED\n')
  writeFileSync(join(own, 'SKILL.md'), 'PROJECT_OWNED\n')

  const first = prepareWorkspaceSkills(workspace)
  assert.deepEqual(first, { linked: ['shared'], warning: '' })
  assert.equal(readFileSync(join(own, 'SKILL.md'), 'utf8'), 'PROJECT_OWNED\n')
  const inherited = join(workspace, '.agents', 'skills', 'shared')
  assert.ok(lstatSync(inherited).isSymbolicLink(), 'shared skill is linked, not copied')
  assert.equal(readFileSync(join(inherited, 'SKILL.md'), 'utf8'), 'PARENT_SHARED\n')
  assert.deepEqual(prepareWorkspaceSkills(workspace), { linked: [], warning: '' }, 'registration is idempotent')

  const unrelated = join(root, 'unindexed', 'child')
  mkdirSync(join(unrelated, '..', '.agents', 'skills', 'unused'), { recursive: true })
  writeFileSync(join(unrelated, '..', '.agents', 'skills', 'unused', 'SKILL.md'), 'UNINDEXED\n')
  mkdirSync(unrelated)
  assert.deepEqual(prepareWorkspaceSkills(unrelated), { linked: [], warning: '' })
  assert.equal(existsSync(join(unrelated, '.agents')), false, 'unindexed ancestors are ignored')
} finally {
  assert.ok(resolve(root).startsWith(tempRoot), 'refuse cleanup outside temp')
  rmSync(root, { recursive: true, force: true })
}

console.log('workspace skill registration: OK')
