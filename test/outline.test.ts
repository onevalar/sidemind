import { describe, expect, it } from 'vitest'
import { outlineHeadings } from '../src/outline'

describe('draft document outline', () => {
  it('uses exact draft offsets for six heading levels, setext, inline text and nested headings', () => {
    const content = '# 主标题\n\n正文\n\n## **第二**级 [链接](https://example.com)\n\n> ### 引用内\n\n第五级\n------\n\n##### 五级\n\n###### 六级\n'
    const headings = outlineHeadings(content)
    expect(headings.map(h => h.title)).toEqual(['主标题', '第二级 链接', '引用内', '第五级', '五级', '六级'])
    expect(headings.map(h => h.depth)).toEqual([1, 2, 3, 2, 5, 6])
    expect(headings.map(h => content.slice(h.start).split('\n')[0])).toEqual(['# 主标题', '## **第二**级 [链接](https://example.com)', '### 引用内', '第五级', '##### 五级', '###### 六级'])
    const draft = '新增段落\n\n' + content
    expect(outlineHeadings(draft)[4]!.start).toBe(headings[4]!.start + 6)
  })

  it('does not treat fenced code or raw HTML as navigable Markdown headings', () => {
    expect(outlineHeadings('```md\n# 代码中的标题\n```\n\n<h2>原始 HTML</h2>\n\n正文')).toEqual([])
  })
})
