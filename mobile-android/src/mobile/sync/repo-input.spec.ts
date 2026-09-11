// 仓库标识解析的用例：钉住"用户可能粘进来的各种形态"都能落到 owner/repo，
// 同时钉住"认不出来的必须明确拒绝"——拼一串乱码去打 API 会变成看不懂的 404。
import { describe, expect, it } from 'vitest'
import { explainRepoProblem, normalizeRepo, parseRepoInput } from './repo-input'

describe('parseRepoInput', () => {
  it('裸 owner/repo 原样通过', () => {
    expect(normalizeRepo('MuggleWu/miki')).toBe('MuggleWu/miki')
  })

  it('浏览器地址栏那种 URL（带 .git / 末尾斜杠 / 查询串 / 片段）', () => {
    expect(normalizeRepo('https://github.com/MuggleWu/miki.git')).toBe('MuggleWu/miki')
    expect(normalizeRepo('https://github.com/MuggleWu/miki/')).toBe('MuggleWu/miki')
    expect(normalizeRepo('http://www.github.com/MuggleWu/miki?tab=readme#x')).toBe('MuggleWu/miki')
  })

  it('scp 形式与 ssh 形式', () => {
    expect(normalizeRepo('git@github.com:MuggleWu/miki.git')).toBe('MuggleWu/miki')
    expect(normalizeRepo('ssh://git@github.com/MuggleWu/miki.git')).toBe('MuggleWu/miki')
  })

  it('URL 里套了路径（复制了文件页地址）也只取 owner/repo', () => {
    expect(normalizeRepo('https://github.com/MuggleWu/miki/tree/main/mobile-android')).toBe('MuggleWu/miki')
  })

  it('前后空白与换行会被吃掉（从别处复制粘贴很常见）', () => {
    expect(normalizeRepo('  MuggleWu/miki\n')).toBe('MuggleWu/miki')
  })

  it('把 PAT 填进仓库栏要能识别出来，并给出正确的引导', () => {
    const r = parseRepoInput('github_pat_11ABCDEFG0abcdefghijklmnop')
    expect(r.repo).toBeNull()
    expect(r.problem).toBe('looks-like-token')
    expect(explainRepoProblem(r.problem!)).toContain('token 填在下面那一栏')
  })

  it('非 GitHub 的地址明确拒绝', () => {
    expect(parseRepoInput('https://gitlab.com/me/repo').problem).toBe('not-github')
  })

  it('只有 owner 或空串 → 拒绝', () => {
    expect(parseRepoInput('MuggleWu').problem).toBe('unparsable')
    expect(parseRepoInput('   ').problem).toBe('empty')
  })
})
