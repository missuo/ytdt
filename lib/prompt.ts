import type { ChatMessage } from './llm';
import { languageName } from './languages';
import type { GlossaryEntry, SummaryJob, TranslateJob, VideoSummary } from './types';

export const PROMPT_VERSION = 1;

export function buildTranslateMessages(job: TranslateJob, extraInstructions: string): ChatMessage[] {
  const target = languageName(job.targetLang);
  const system = [
    `You are a professional subtitle translator. Translate YouTube subtitles into ${target}.`,
    '',
    'Rules:',
    '- Input lines look like "[id] text". Reply with exactly one line per id to translate, in the same order, formatted as "[id] translation". Never merge, split, skip or renumber ids.',
    '- Subtitle lines are often fragments of a sentence that continues on the next line. Read the neighbouring lines so every fragment is translated to fit the whole sentence, while each translation still covers only its own line, so the lines read naturally in sequence.',
    '- Use the earlier lines and their existing translations to keep names, terminology, tone and pronouns consistent.',
    '- Write natural, concise subtitles a native speaker would write. Keep names, brands and code as appropriate. Silently fix obvious speech-recognition mistakes.',
    '- Output only the translated lines. No explanations, notes, quotes or markdown.',
  ];
  if (job.summary?.summary) system.push('', 'About this video:', job.summary.summary);
  if (job.summary?.glossary.length) {
    system.push('', 'Glossary (use these renderings):');
    for (const g of job.summary.glossary) system.push(`- ${g.term} => ${g.translation}`);
  }
  if (extraInstructions.trim()) system.push('', 'Additional instructions:', extraInstructions.trim());

  const user: string[] = [];
  if (job.title) user.push(`Video title: ${job.title}`, '');
  if (job.previous.length) {
    user.push('Earlier lines (context only, do not output):');
    for (const l of job.previous) {
      user.push(`[${l.id}] ${l.text}`);
      if (l.translation) user.push(`    => ${l.translation}`);
    }
    user.push('');
  }
  user.push(`Translate these lines into ${target}:`);
  for (const l of job.lines) user.push(`[${l.id}] ${l.text}`);
  if (job.following.length) {
    user.push('', 'Next lines (context only, do not output):');
    for (const l of job.following) user.push(`[${l.id}] ${l.text}`);
  }

  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user.join('\n') },
  ];
}

/**
 * Incremental parser for "[id] translation" lines in a streamed reply.
 * Ignores `<think>` blocks some open models emit inline.
 */
export class TranslationStreamParser {
  private buf = '';
  private inThink = false;
  private lastId: number | null = null;

  constructor(
    private readonly wanted: Set<number>,
    private readonly onLine: (id: number, text: string) => void,
  ) {}

  push(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      this.line(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  end() {
    if (this.buf) this.line(this.buf);
    this.buf = '';
  }

  private line(raw: string) {
    let s = raw;
    if (this.inThink) {
      const close = s.indexOf('</think>');
      if (close < 0) return;
      this.inThink = false;
      s = s.slice(close + 8);
    }
    const open = s.indexOf('<think>');
    if (open >= 0) {
      this.inThink = !s.includes('</think>', open);
      s = s.slice(0, open);
    }
    s = s.trim().replace(/^[-*]\s+/, '');
    if (!s) return;
    const m = /^[[【](\d+)[\]】]\s*[:：]?\s*(.*)$/.exec(s);
    if (m) {
      const id = Number(m[1]);
      const text = (m[2] ?? '').trim();
      this.lastId = this.wanted.has(id) ? id : null;
      if (this.lastId != null && text) this.onLine(id, text);
    } else if (this.lastId != null && !s.startsWith('=>')) {
      // Model put the translation on the line after its id.
      this.onLine(this.lastId, s);
      this.lastId = null;
    }
  }
}

export function buildSummaryMessages(job: SummaryJob): ChatMessage[] {
  const target = languageName(job.targetLang);
  return [
    {
      role: 'system',
      content: [
        `You prepare context for translating a video's subtitles into ${target}.`,
        'Reply in exactly this format and nothing else:',
        'SUMMARY: <2-4 sentences in English: topic, speakers, setting, tone>',
        'GLOSSARY:',
        `<source term> => <${target} rendering>`,
        '',
        'List up to 25 names, recurring terms and jargon whose translation should stay consistent. Leave GLOSSARY empty if there are none.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Title: ${job.title}`,
        job.description ? `Description: ${job.description.slice(0, 1500)}` : '',
        '',
        'Transcript:',
        job.transcript,
      ].join('\n'),
    },
  ];
}

export function parseSummary(text: string): VideoSummary {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const summary = /SUMMARY:\s*([\s\S]*?)(?:\n\s*GLOSSARY:|$)/i.exec(cleaned)?.[1]?.trim() ?? '';
  const glossaryBlock = /GLOSSARY:\s*([\s\S]*)$/i.exec(cleaned)?.[1] ?? '';
  const glossary: GlossaryEntry[] = [];
  for (const line of glossaryBlock.split('\n')) {
    const m = /^\s*[-*]?\s*(.+?)\s*(?:=>|->|→)\s*(.+?)\s*$/.exec(line);
    if (m?.[1] && m[2]) glossary.push({ term: m[1], translation: m[2] });
  }
  return { summary, glossary: glossary.slice(0, 40) };
}
