import type { Tool } from './registry'

const NOUNS = [
  'anchor','basin','candle','desert','engine','falcon','glacier','harbor','island','jungle',
  'kettle','lantern','magnet','needle','orchid','pillar','quarry','ribbon','saddle','temple',
  'umbrella','valley','window','zenith','arrow','bridge','castle','dagger','ember','forest',
  'garden','helmet','ivory','jasmine','knot','ladder','mirror','nebula','ocean','prism',
  'quartz','raven','shield','throne','urchin','vessel','walrus','yarn','anvil','beacon',
  'chimney','drum','eclipse','fossil','goblet','harpoon','inlet','jewel','kiln','loom',
  'marrow','nomad','obelisk','pebble','quill','reef','socket','timber','utensil','vortex',
  'wharf','axis','bazaar','coral','depot','estuary','flint','gorge','husk','iceberg',
  'jigsaw','keel','lever','mortar','nucleus','orbit','parcel','queue','ratchet','spool',
  'trellis','valve','wedge','yoke','zipper','album','blister','capsule','dowel','filament',
]
const ADJECTIVES = [
  'absent','brittle','calm','dark','eager','faint','gentle','hollow','idle','jarring',
  'keen','loose','muted','narrow','odd','plain','quiet','rigid','steep','taut',
  'uneven','vivid','wary','young','bitter','crisp','dense','dusty','exact','flat',
  'grave','harsh','inner','just','kind','late','mild','neat','open','pale',
  'raw','sharp','thick','vast','warm','bold','clear','deep','dry','even',
  'fresh','grand','high','icy','lean','loud','new','old','proud','rich',
  'slow','tall','wide','blank','crude','dim','dull','false','grim','heavy',
  'left','long','rare','safe','slim','soft','sour','stiff','swift','thin',
  'tight','tough','true','vague','weak','wild','worn','wrong','brief','broad',
  'clean','cold','cool','fair','fast','fine','firm','free','full','glad',
]
const VERBS = [
  'anchors','bends','carries','drifts','echoes','folds','gathers','holds','ignites','joins',
  'keeps','lifts','melts','nudges','opens','pulls','quiets','reveals','splits','turns',
  'unveils','wanders','yields','absorbs','breaks','catches','dissolves','erases','floods',
  'grips','haunts','inverts','jumps','kindles','lowers','mirrors','notices','outpaces',
  'presses','questions','rotates','shapes','traces','unfolds','vaults','watches','crosses',
  'burns','climbs','cracks','drags','falls','grazes','hides','kneels','leads','marks',
  'nests','orbits','plants','rakes','scrapes','tilts','unwinds','veers','wraps','zeroes',
]
const ADVERBS = [
  'almost','barely','calmly','deeply','eagerly','faintly','gently','harshly','idly','justly',
  'keenly','loosely','mainly','neatly','oddly','plainly','quietly','rarely','sharply','tightly',
  'utterly','vividly','warmly','blindly','briefly','clearly','closely','coldly','darkly','dimly',
  'dryly','evenly','fairly','firmly','flatly','freely','fully','gladly','grimly','highly',
]

function cryptoRandom(max: number): number {
  const arr = new Uint32Array(1)
  crypto.getRandomValues(arr)
  return arr[0] % max
}

function pick<T>(list: T[]): T {
  return list[cryptoRandom(list.length)]
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = cryptoRandom(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function randomWords(count: number): string[] {
  const all = [...NOUNS, ...ADJECTIVES, ...VERBS, ...ADVERBS]
  const words: string[] = []
  const used = new Set<number>()
  const max = Math.min(count, all.length)
  while (words.length < max) {
    const idx = cryptoRandom(all.length)
    if (!used.has(idx)) { used.add(idx); words.push(all[idx]) }
  }
  return words
}

function nonsenseSentence(): string {
  const patterns = [
    () => `The ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(ADVERBS)} ${pick(VERBS)} the ${pick(ADJECTIVES)} ${pick(NOUNS)}.`,
    () => `A ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(VERBS)} while the ${pick(NOUNS)} ${pick(ADVERBS)} ${pick(VERBS)}.`,
    () => `${pick(ADVERBS).replace(/^./, c => c.toUpperCase())}, the ${pick(NOUNS)} ${pick(VERBS)} every ${pick(ADJECTIVES)} ${pick(NOUNS)}.`,
    () => `The ${pick(NOUNS)} and the ${pick(NOUNS)} ${pick(ADVERBS)} ${pick(VERBS)} beneath the ${pick(ADJECTIVES)} ${pick(NOUNS)}.`,
    () => `Every ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(VERBS)} a ${pick(ADJECTIVES)} ${pick(NOUNS)} that ${pick(ADVERBS)} ${pick(VERBS)}.`,
    () => `When the ${pick(NOUNS)} ${pick(VERBS)}, the ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(ADVERBS)} ${pick(VERBS)}.`,
  ]
  return pick(patterns)()
}

export const randomTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'random_words',
        description: 'Generate a cryptographically random list of words, or a grammatically correct nonsense sentence. Useful for brainstorming, free association, or creative prompts.',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['words', 'sentence'],
              description: "'words' returns a shuffled list of random words. 'sentence' returns a grammatically correct but nonsensical sentence. Default: 'words'.",
            },
            count: {
              type: 'number',
              description: 'Number of random words to return (words mode only, default 10, max 50).',
            },
          },
        },
      },
    },
    label: ['Generating random words', 'Generated random words'],
    run: async (_ctx, args) => {
      const mode = (args.mode as string) || 'words'
      if (mode === 'sentence') {
        const sentences: string[] = []
        const n = Math.min(Math.max((args.count as number) || 3, 1), 10)
        for (let i = 0; i < n; i++) sentences.push(nonsenseSentence())
        return sentences.join('\n')
      }
      const count = Math.min(Math.max((args.count as number) || 10, 1), 50)
      return randomWords(count).join(', ')
    },
  },
]
