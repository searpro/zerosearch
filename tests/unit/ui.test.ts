import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { Emitter } from '../../src/engine/events.js';
import type { AskResult, GenerationStatus } from '../../src/engine/protocol.js';
import { answerTurn, generationOffer } from '../../src/ui/render.js';
import { Widget } from '../../src/ui/widget.js';

const answer = (overrides: Partial<AskResult> = {}): AskResult => ({
  grounded: true,
  citations: [
    {
      chunkId: 'https://x.example/pricing#1',
      url: 'https://x.example/pricing',
      title: 'Pricing',
      headingPath: ['Team'],
      body: '$49 per month.',
      score: 0.03,
      dense: 0.49,
    },
  ],
  suggestions: [],
  fetched: [],
  tookMs: 12,
  answer: null,
  sources: [],
  cited: [],
  ...overrides,
});

function make() {
  const events = new Emitter();
  const widget = new Widget({ ...DEFAULT_CONFIG }, events);
  widget.mount();
  const root = widget.element.shadowRoot!;
  return {
    widget,
    events,
    root,
    input: root.querySelector<HTMLTextAreaElement>('.input')!,
    form: root.querySelector<HTMLFormElement>('.composer')!,
    transcript: root.querySelector<HTMLElement>('.transcript')!,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('composer', () => {
  it('sends the question through onAsk and renders the answer', async () => {
    const { widget, transcript } = make();
    const onAsk = vi.fn(async () => answer());
    widget.onAsk = onAsk;

    await widget.submit('how much does the team plan cost');

    expect(onAsk).toHaveBeenCalledWith('how much does the team plan cost', expect.any(Function));
    expect(transcript.querySelector('.turn-user')?.textContent).toBe('how much does the team plan cost');
    expect(transcript.querySelector('.citation-body')?.textContent).toBe('$49 per month.');
    expect(transcript.querySelector('.citation-source')?.textContent).toBe('Pricing › Team');
  });

  it('submits on the form, clearing the input', async () => {
    const { widget, input, form } = make();
    widget.onAsk = async () => answer();

    input.value = 'a question';
    form.requestSubmit();
    await vi.waitFor(() => expect(input.value).toBe(''));
  });

  it('sends on Enter but not on Shift+Enter', async () => {
    const { widget, input } = make();
    const onAsk = vi.fn(async () => answer());
    widget.onAsk = onAsk;
    input.value = 'a question';

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(onAsk).not.toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(onAsk).toHaveBeenCalledTimes(1));
  });

  it('ignores an empty or whitespace-only question', async () => {
    const { widget } = make();
    const onAsk = vi.fn(async () => answer());
    widget.onAsk = onAsk;

    await widget.submit('   ');
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('disables the composer while a question is in flight', async () => {
    const { widget, input, root } = make();
    let release!: (value: AskResult) => void;
    widget.onAsk = () => new Promise<AskResult>((resolve) => (release = resolve));

    const pending = widget.submit('slow question');
    expect(input.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.send')!.disabled).toBe(true);
    expect(root.querySelector('.turn-pending')).toBeTruthy();

    release(answer());
    await pending;
    expect(input.disabled).toBe(false);
    expect(root.querySelector('.turn-pending')).toBeNull();
  });

  it('will not queue a second question while one is running', async () => {
    const { widget } = make();
    const onAsk = vi.fn(() => new Promise<AskResult>(() => {}));
    widget.onAsk = onAsk;

    void widget.submit('first');
    await widget.submit('second');
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it('renders a failure as an error turn rather than throwing', async () => {
    const { widget, transcript } = make();
    widget.onAsk = async () => {
      throw new Error('the worker died');
    };

    await widget.submit('anything');
    expect(transcript.querySelector('.turn-error')?.textContent).toBe('the worker died');
  });

  it('fires onFirstOpen exactly once', () => {
    const { widget } = make();
    const onFirstOpen = vi.fn();
    widget.onFirstOpen = onFirstOpen;

    widget.open();
    widget.close();
    widget.open();
    expect(onFirstOpen).toHaveBeenCalledTimes(1);
  });
});

describe('answerTurn', () => {
  it('says it found nothing, and offers pages instead', () => {
    const el = answerTurn(
      answer({
        grounded: false,
        citations: [],
        suggestions: [{ url: 'https://x.example/faq', title: 'FAQ' }],
      }),
    );

    expect(el.querySelector('.answer-empty')?.textContent).toContain("couldn't find that");
    expect(el.querySelector('.suggestions a')?.textContent).toBe('FAQ');
    expect(el.querySelector('.citation')).toBeNull();
  });

  it('handles finding nothing with nothing to suggest', () => {
    const el = answerTurn(answer({ grounded: false, citations: [], suggestions: [] }));
    expect(el.querySelector('.answer-empty')).toBeTruthy();
    expect(el.querySelector('.suggestions')).toBeNull();
  });

  it('links each citation to its source with a safe rel', () => {
    const link = answerTurn(answer()).querySelector<HTMLAnchorElement>('.citation-source')!;
    expect(link.getAttribute('href')).toBe('https://x.example/pricing');
    // The href comes from crawled content, so deny it access back to us.
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');
  });

  it('treats crawled content as text, never as markup', () => {
    const hostile = answer({
      citations: [
        {
          chunkId: 'c',
          url: 'https://x.example/p',
          title: '<img src=x onerror=alert(1)>',
          headingPath: ['</a><script>alert(2)</script>'],
          body: '<script>alert(3)</script>',
          score: 1,
          dense: 0.9,
        },
      ],
    });

    const el = answerTurn(hostile);
    // Building this markup from page content would be an injection vector on
    // the host's own site, so every value goes in through textContent.
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.citation-body')?.textContent).toBe('<script>alert(3)</script>');
  });
});

const status = (overrides: Partial<GenerationStatus> = {}): GenerationStatus => ({
  available: true,
  enabled: false,
  cached: false,
  modelLabel: 'SmolLM2 360M',
  approxBytes: 272 * 1024 * 1024,
  reason: 'WebGPU available',
  ...overrides,
});

describe('generated answers', () => {
  const generated = (text: string) =>
    answer({
      answer: text,
      sources: [
        {
          chunkId: 'c1',
          url: 'https://x.example/pricing',
          title: 'Pricing',
          headingPath: ['Team'],
          body: '$49 per month.',
          score: 1,
          dense: 0.5,
        },
      ],
      cited: [1],
    });

  it('renders prose with its citation markers as links', () => {
    const el = answerTurn(generated('The Team plan is $49 per month [1].'));

    expect(el.querySelector('.answer-text')?.textContent).toContain('$49 per month');
    const cite = el.querySelector<HTMLAnchorElement>('.answer-cite')!;
    expect(cite.textContent).toBe('1');
    expect(cite.getAttribute('href')).toBe('https://x.example/pricing');
    expect(cite.rel).toContain('noopener');
  });

  it('shows the passages the answer was written from', () => {
    const el = answerTurn(generated('It is $49 [1].'));
    expect(el.querySelector('.citation-body')?.textContent).toBe('$49 per month.');
  });

  it('treats model output as text, never as markup', () => {
    // The model can emit anything; building HTML from it would be an injection
    // vector on the host's own site.
    const el = answerTurn(generated('<img src=x onerror=alert(1)> and <script>alert(2)</script>'));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('.answer-text')?.textContent).toContain('<script>');
  });

  it('falls back to the passage list when there is no generated answer', () => {
    const el = answerTurn(answer({ answer: null }));
    expect(el.querySelector('.answer-text')).toBeNull();
    expect(el.querySelector('.citation-body')).toBeTruthy();
  });
});

describe('generationOffer', () => {
  it('states the download size plainly', () => {
    const el = generationOffer(status(), () => {})!;
    // Burying a 272MB cost is how a widget loses a visitor's trust.
    expect(el.textContent).toContain('272 MB');
    expect(el.querySelector('.offer-button')?.textContent).toBe('Download');
  });

  it('does not mention a download when the weights are already cached', () => {
    const el = generationOffer(status({ cached: true }), () => {})!;
    expect(el.textContent).not.toContain('MB');
    expect(el.querySelector('.offer-button')?.textContent).toBe('Turn on');
  });

  it('offers nothing on a device that cannot generate', () => {
    expect(generationOffer(status({ available: false }), () => {})).toBeNull();
  });

  it('offers nothing once generation is on', () => {
    expect(generationOffer(status({ enabled: true }), () => {})).toBeNull();
  });

  it('calls back when clicked', () => {
    const onEnable = vi.fn();
    generationOffer(status(), onEnable)!.querySelector<HTMLButtonElement>('.offer-button')!.click();
    expect(onEnable).toHaveBeenCalledTimes(1);
  });
});

describe('streaming', () => {
  it('replaces the searching turn on the first token, then renders the final answer', async () => {
    const { widget, transcript } = make();
    let emit!: (text: string) => void;
    let finish!: (result: AskResult) => void;

    widget.onAsk = (_query, onToken) => {
      emit = onToken;
      return new Promise<AskResult>((resolve) => (finish = resolve));
    };

    const pending = widget.submit('how much');
    await vi.waitFor(() => expect(transcript.querySelector('.turn-pending')).toBeTruthy());

    emit('The Team plan');
    emit(' is $49.');
    expect(transcript.querySelector('.turn-pending')).toBeNull();
    expect(transcript.querySelector('.turn-streaming')?.textContent).toBe('The Team plan is $49.');

    finish(answer({ answer: 'The Team plan is $49 [1].', sources: answer().citations, cited: [1] }));
    await pending;

    // Swapped for the final render: markers can only be linked once the source
    // list is known.
    expect(transcript.querySelector('.turn-streaming')).toBeNull();
    expect(transcript.querySelector('.answer-cite')).toBeTruthy();
  });
});
