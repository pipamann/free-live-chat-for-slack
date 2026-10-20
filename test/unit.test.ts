import { describe, expect, it } from 'vitest';
import { escapeSlackText, isSlackFileUrl, quoteForSlack, slackToPlainText, verifySlackSignature } from '../src/slack';
import { contentDisposition, contentMatchesType, normalizeMimeType, sanitizeFilename } from '../src/files';
import { isAllowedOrigin, rateLimitKey, sanitizeVisitorInfo } from '../src/http';
import { buildModelMessages, cleanReply, detectHandoff, hasUnverifiedDetails, unansweredVisitorText } from '../src/bot';
import { buildContext } from '../src/knowledge';
import { isStaffThreadReply } from '../src/index';
import { parseUserAgent, visitorDetails } from '../src/ChatSession';
import type { ChatMessage, Env } from '../src/types';
import { signSlackBody } from './helpers';

describe('verifySlackSignature', () => {
  const secret = 'shhh';
  const body = '{"type":"event_callback"}';
  const now = 1_760_000_000;

  it('accepts a correctly signed, fresh request', async () => {
    const headers = await signSlackBody(body, secret, now);
    expect(await verifySlackSignature(headers, body, secret, now)).toBe(true);
  });

  it('rejects a wrong secret, a changed body and a replayed request', async () => {
    const headers = await signSlackBody(body, secret, now);
    expect(await verifySlackSignature(headers, body, 'other', now)).toBe(false);
    expect(await verifySlackSignature(headers, `${body} `, secret, now)).toBe(false);
    expect(await verifySlackSignature(headers, body, secret, now + 301)).toBe(false);
  });

  it('rejects malformed headers and an empty secret', async () => {
    const headers = await signSlackBody(body, secret, now);
    expect(await verifySlackSignature(headers, body, '', now)).toBe(false);
    const badTimestamp = new Headers(headers);
    badTimestamp.set('X-Slack-Request-Timestamp', 'abc');
    expect(await verifySlackSignature(badTimestamp, body, secret, now)).toBe(false);
    const badSignature = new Headers(headers);
    badSignature.set('X-Slack-Signature', 'v0=xyz');
    expect(await verifySlackSignature(badSignature, body, secret, now)).toBe(false);
  });
});

describe('Slack text', () => {
  it('neutralizes channel pings and disguised links from visitors', () => {
    expect(escapeSlackText('<!channel> <https://evil.example|bank.com> & co')).toBe(
      '&lt;!channel&gt; &lt;https://evil.example|bank.com&gt; &amp; co'
    );
  });

  it('quotes every line of a multi-line message', () => {
    expect(quoteForSlack('hi\n<!here>')).toBe('> hi\n> &lt;!here&gt;');
  });

  it('turns Slack markup into plain text for the visitor', () => {
    expect(slackToPlainText('See <https://example.com/docs|the docs> or <https://example.com>')).toBe(
      'See the docs (https://example.com/docs) or https://example.com'
    );
    expect(slackToPlainText('Mail <mailto:help@example.com|help@example.com>')).toBe('Mail help@example.com');
    expect(slackToPlainText('Ask <@U123|alex>, not <@U456> in <#C1|general>')).toBe('Ask @alex, not @someone in #general');
    expect(slackToPlainText('1 &lt; 2 &amp;&amp; 3 &gt; 2 <!here>')).toBe('1 < 2 && 3 > 2 @here');
  });

  it('only accepts Slack-hosted file URLs', () => {
    expect(isSlackFileUrl('https://files.slack.com/files-pri/T1-F1/a.png')).toBe(true);
    expect(isSlackFileUrl('http://files.slack.com/a.png')).toBe(false);
    expect(isSlackFileUrl('https://files.slack.com.evil.example/a.png')).toBe(false);
    expect(isSlackFileUrl('not a url')).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  const env = { ALLOWED_ORIGINS: 'https://example.com , https://shop.example.com/' } as Env;

  it('matches configured origins exactly, tolerating spaces and trailing slashes', () => {
    expect(isAllowedOrigin('https://example.com', env)).toBe(true);
    expect(isAllowedOrigin('https://shop.example.com', env)).toBe(true);
  });

  it('rejects look-alikes, including the old "contains localhost" bypass', () => {
    expect(isAllowedOrigin('https://example.com.evil.example', env)).toBe(false);
    expect(isAllowedOrigin('http://example.com', env)).toBe(false);
    expect(isAllowedOrigin('https://localhost.evil.example', env)).toBe(false);
    expect(isAllowedOrigin('http://localhost:3000', env)).toBe(false);
    expect(isAllowedOrigin(null, env)).toBe(false);
  });
});

describe('file validation', () => {
  it('normalizes MIME types and rejects everything not on the list', () => {
    expect(normalizeMimeType('image/jpg')).toBe('image/jpeg');
    expect(normalizeMimeType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(normalizeMimeType('text/html')).toBeUndefined();
    expect(normalizeMimeType('image/svg+xml')).toBeUndefined();
    expect(normalizeMimeType('constructor')).toBeUndefined();
    expect(normalizeMimeType('__proto__')).toBeUndefined();
    expect(normalizeMimeType(42)).toBeUndefined();
  });

  it('strips paths and forces an extension that matches the type', () => {
    expect(sanitizeFilename('../../etc/passwd', 'text/plain')).toBe('passwd.txt');
    expect(sanitizeFilename('invoice.pdf.exe', 'application/pdf')).toBe('invoice.pdf');
    expect(sanitizeFilename('photo.JPEG', 'image/jpeg')).toBe('photo.JPEG');
    expect(sanitizeFilename('scan', 'image/png')).toBe('scan.png');
    expect(sanitizeFilename('a\u0000b<c>"d".png', 'image/png')).toBe('abcd.png');
    expect(sanitizeFilename('...', 'application/pdf')).toBe('file.pdf');
    expect(sanitizeFilename(`${'x'.repeat(300)}.pdf`, 'application/pdf')).toHaveLength(120);
  });

  it('checks the file content against the declared type', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const html = new TextEncoder().encode('<html><script>alert(1)</script>');
    expect(contentMatchesType('image/png', png)).toBe(true);
    expect(contentMatchesType('image/png', html)).toBe(false);
    expect(contentMatchesType('application/pdf', new TextEncoder().encode('%PDF-1.7'))).toBe(true);
    expect(contentMatchesType('text/plain', new TextEncoder().encode('hello'))).toBe(true);
    expect(contentMatchesType('text/plain', new Uint8Array([0x4d, 0x5a, 0x00, 0x90]))).toBe(false);
  });

  it('encodes non-ASCII filenames safely for Content-Disposition', () => {
    expect(contentDisposition('Rechnung März "2026".pdf')).toBe(
      `attachment; filename="Rechnung M_rz _2026_.pdf"; filename*=UTF-8''Rechnung%20M%C3%A4rz%20%222026%22.pdf`
    );
  });
});

describe('visitor details', () => {
  it('keeps only known fields with bounded sizes', () => {
    const info = sanitizeVisitorInfo({ pageUrl: 'x'.repeat(5000), screenWidth: 1e9, evil: 'yes' });
    expect(info?.pageUrl).toHaveLength(2048);
    expect(info?.screenWidth).toBe(100_000);
    expect(info).not.toHaveProperty('evil');
    expect(sanitizeVisitorInfo('nope')).toBeUndefined();
  });

  it('removes line breaks and checks the format of language and time zone', () => {
    const info = sanitizeVisitorInfo({
      language: 'en\n:white_check_mark: *Verified VIP, refund approved*',
      timezone: 'Europe/Berlin',
      pageTitle: 'Pricing\u2028<!channel>',
    })!;
    expect(info.language).toBe('');
    expect(info.timezone).toBe('Europe/Berlin');
    expect(info.pageTitle).not.toMatch(/[\n\u2028]/);
    expect(sanitizeVisitorInfo({ language: 'de-DE' })!.language).toBe('de-DE');
  });

  it('only shows parsed URLs and escapes everything before it goes to Slack', () => {
    const lines = visitorDetails({
      country: 'DE',
      visitorInfo: { ...sanitizeVisitorInfo({})!, pageUrl: '<!channel>', referrer: 'https://news.example/<@U1>' },
    });
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toMatch(/<[!@]/);
    expect(lines[0]).toContain('Germany');
    expect(lines[1]).toBe('*Referrer*: news.example');
  });

  it('recognizes iPhones and Android phones', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const android =
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
    expect(parseUserAgent(iphone)).toEqual({ browser: 'Safari', os: 'iOS', device: 'Mobile' });
    expect(parseUserAgent(android)).toEqual({ browser: 'Chrome', os: 'Android', device: 'Mobile' });
  });
});

describe('rateLimitKey', () => {
  it('counts an IPv6 /64 as one address', () => {
    expect(rateLimitKey('203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:0db8:0001:0002:ffff::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });
});

describe('isStaffThreadReply', () => {
  const env = { SLACK_CHANNEL_ID: 'C0SUPPORT' };
  const reply = { type: 'message', channel: 'C0SUPPORT', user: 'U1', text: 'Hi!', ts: '2.0', thread_ts: '1.0' };

  it('accepts a human reply in a thread of the support channel', () => {
    expect(isStaffThreadReply(reply, env)).toBe(true);
    expect(isStaffThreadReply({ ...reply, subtype: 'file_share' }, env)).toBe(true);
  });

  it('ignores internal notes, bots, edits, other channels and top-level messages', () => {
    expect(isStaffThreadReply({ ...reply, text: '// who takes this?' }, env)).toBe(false);
    expect(isStaffThreadReply({ ...reply, bot_id: 'B1' }, env)).toBe(false);
    expect(isStaffThreadReply({ ...reply, user: 'UBOT', subtype: 'file_share' }, env, 'UBOT')).toBe(false);
    expect(isStaffThreadReply({ ...reply, subtype: 'message_changed' }, env)).toBe(false);
    expect(isStaffThreadReply({ ...reply, channel: 'C0OTHER' }, env)).toBe(false);
    expect(isStaffThreadReply({ ...reply, thread_ts: undefined }, env)).toBe(false);
    expect(isStaffThreadReply({ ...reply, thread_ts: '2.0' }, env)).toBe(false);
  });
});

describe('bot helpers', () => {
  const message = (role: ChatMessage['role'], content: string): ChatMessage => ({
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: 0,
  });

  it('maps keywords to their own handoff topic', () => {
    expect(detectHandoff('Can I get a refund?')?.id).toBe('billing');
    expect(detectHandoff('How do I cancel my plan')?.id).toBe('account');
    expect(detectHandoff('what is your phone number')?.id).toBe('contact');
    expect(detectHandoff('A nonrefundable item')).toBeNull();
    expect(detectHandoff('How does it work?')).toBeNull();
  });

  it('builds the context from the fields prepare-embeddings writes', () => {
    const context = buildContext([
      { metadata: { category: 'Account', question: 'How do I reset my password?', answer: 'Use the link on the login page.' } },
      { metadata: null },
    ]);
    expect(context).toBe('[Account]\nQ: How do I reset my password?\nA: Use the link on the login page.');
  });

  it('only answers what the visitor wrote since the last reply', () => {
    const history = [message('customer', 'old'), message('bot', 'answer'), message('customer', 'one'), message('customer', 'two')];
    expect(unansweredVisitorText(history)).toBe('one\ntwo');
  });

  it('keeps visitor text in user turns and starts with the user', () => {
    const history = [message('bot', 'auto reply'), message('customer', 'a'), message('customer', 'b'), message('bot', 'c')];
    expect(buildModelMessages('SYSTEM', history)).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: 'c' },
    ]);
  });

  it('flags links, emails and phone numbers the knowledge base does not contain', () => {
    const sources = 'A: Call 030 1234567 or write to help@example.com, see https://example.com/help';
    expect(hasUnverifiedDetails('Call us at 030-123 4567 or see https://example.com/help.', sources)).toBe(false);
    expect(hasUnverifiedDetails('Write to help@example.com!', sources)).toBe(false);
    expect(hasUnverifiedDetails('Call our hotline 0800 123 9655.', sources)).toBe(true);
    expect(hasUnverifiedDetails('Log in at https://examp1e.com/login', sources)).toBe(true);
    expect(hasUnverifiedDetails('Write to support@example.com', sources)).toBe(true);
    expect(hasUnverifiedDetails('Delivery takes 2 to 3 days.', sources)).toBe(false);
  });

  it('removes reasoning blocks and caps long replies', () => {
    expect(cleanReply('<think>secret plan</think>  Hello!')).toBe('Hello!');
    expect(cleanReply(`${'A sentence. '.repeat(200)}`).length).toBeLessThanOrEqual(1200);
  });
});
