import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

const REGISTRIES = ['.devin', '.cognition', '.agents']

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

function skillNames(workspace) {
  const names = new Set()
  for (const registry of REGISTRIES) {
    const root = join(workspace, registry, 'skills')
    if (!isDirectory(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (isDirectory(join(root, entry.name)) && existsSync(join(root, entry.name, 'SKILL.md'))) names.add(entry.name)
    }
  }
  return names
}

/**
 * A parent may publish skills for several child workspaces. Devin CLI only
 * discovers registries in the session cwd, so find the nearest explicitly
 * indexed shared registry. An arbitrary ancestor skills folder is insufficient.
 */
function sharedRegistry(workspace) {
  let parent = dirname(workspace)
  while (parent !== parse(parent).root) {
    const root = join(parent, '.agents')
    if (existsSync(join(root, 'AGENTS.md')) && isDirectory(join(root, 'skills'))) return join(root, 'skills')
    parent = dirname(parent)
  }
  return undefined
}

/** Link only missing shared skills; never overwrite a project-local skill. */
export function prepareWorkspaceSkills(cwd) {
  const workspace = resolve(cwd)
  const source = sharedRegistry(workspace)
  if (!source) return { linked: [], warning: '' }

  let missing
  try {
    const present = skillNames(workspace)
    missing = readdirSync(source, { withFileTypes: true })
      .filter(entry => isDirectory(join(source, entry.name)) && existsSync(join(source, entry.name, 'SKILL.md')))
      .map(entry => entry.name)
      .filter(name => !present.has(name))
  } catch (error) {
    return { linked: [], warning: `共享技能扫描失败：${error.message}` }
  }
  if (!missing.length) return { linked: [], warning: '' }

  const targetRoot = join(workspace, '.agents', 'skills')
  try {
    for (const path of [join(workspace, '.agents'), targetRoot]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
        throw new Error(`${path} is a link; refusing to write through it`)
      }
    }
    mkdirSync(targetRoot, { recursive: true })
  } catch (error) {
    return { linked: [], warning: `共享技能注册目录不可写：${error.message}` }
  }

  const linked = []
  const failures = []
  for (const name of missing) {
    const destination = join(targetRoot, name)
    try {
      // A dangling link or other existing path must not be replaced.
      try { lstatSync(destination); throw new Error('destination already exists') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      symlinkSync(join(source, name), destination, process.platform === 'win32' ? 'junction' : 'dir')
      if (!existsSync(join(destination, 'SKILL.md'))) throw new Error('SKILL.md unavailable after link')
      linked.push(name)
    } catch (error) { failures.push(`${name}: ${error.message}`) }
  }
  return { linked, warning: failures.length ? `共享技能未完全注册：${failures.join('；')}` : '' }
}
