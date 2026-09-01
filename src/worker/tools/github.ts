import type { Tool } from './registry'

export const githubTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'github_post_issue',
        description: 'Post a new issue to a public GitHub repository. Use for outreach, bug reports, or collaboration with external projects.',
        parameters: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner (e.g. "fardinvahdat")' },
            repo: { type: 'string', description: 'Repository name (e.g. "x402trace")' },
            title: { type: 'string', description: 'Issue title' },
            body: { type: 'string', description: 'Issue body (markdown)' },
          },
          required: ['owner', 'repo', 'title', 'body'],
        },
      },
    },
    label: ['Posting GitHub issue', 'Posted GitHub issue'],
    run: async (ctx, args) => {
      const pat = ctx.env.GITHUB_PAT
      if (!pat) return 'GITHUB_PAT secret is not configured. Ask Eli to set it with: npx wrangler secret put GITHUB_PAT'
      const { owner, repo, title, body } = args as { owner: string; repo: string; title: string; body: string }
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Angel-Agent',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, body }),
      })
      if (!res.ok) {
        const err = await res.text()
        return `GitHub API error ${res.status}: ${err}`
      }
      const issue = await res.json<{ html_url: string; number: number }>()
      return `Issue #${issue.number} created: ${issue.html_url}`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'github_post_comment',
        description: 'Post a comment on an existing GitHub issue or PR.',
        parameters: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            issue_number: { type: 'number', description: 'Issue or PR number' },
            body: { type: 'string', description: 'Comment body (markdown)' },
          },
          required: ['owner', 'repo', 'issue_number', 'body'],
        },
      },
    },
    label: ['Posting GitHub comment', 'Posted GitHub comment'],
    run: async (ctx, args) => {
      const pat = ctx.env.GITHUB_PAT
      if (!pat) return 'GITHUB_PAT secret is not configured. Ask Eli to set it with: npx wrangler secret put GITHUB_PAT'
      const { owner, repo, issue_number, body } = args as { owner: string; repo: string; issue_number: number; body: string }
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Angel-Agent',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      })
      if (!res.ok) {
        const err = await res.text()
        return `GitHub API error ${res.status}: ${err}`
      }
      const comment = await res.json<{ html_url: string }>()
      return `Comment posted: ${comment.html_url}`
    },
  },
]
