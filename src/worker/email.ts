// One address, one key. Gmail ignores dots and anything after a plus in the part
// before the @, and treats googlemail.com as gmail.com, so eli.finer@gmail.com,
// elifiner+x@googlemail.com and ElIfIner@gmail.com are the same inbox. Other
// providers do care about dots, so they are only lowercased.
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  const at = email.lastIndexOf('@')
  if (at < 1) return email
  let local = email.slice(0, at)
  let domain = email.slice(at + 1)
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.split('+')[0]!.replace(/\./g, '')
  return `${local}@${domain}`
}
