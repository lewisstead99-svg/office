// Email senders. All share send({ to, subject, text, html, attachments? }) → { id }.

export function createMemoryMailer() {
  let failures = 0;
  const sent = [];
  return {
    sent,
    failNext(n = 1) { failures = n; },
    async send(msg) {
      if (failures > 0) { failures--; throw new Error('Email failed: test failure'); }
      sent.push(structuredClone(msg));
      return { id: `mem-${sent.length}` };
    },
  };
}

// For local runs: prints what would be sent, including any signing link.
export function createConsoleMailer(log = console.log) {
  const mem = createMemoryMailer();
  return {
    sent: mem.sent,
    async send(msg) {
      const r = await mem.send(msg);
      const link = (msg.text.match(/https?:\/\/\S+\/s\/[\w-]+/) || [])[0];
      log(`\n✉  To: ${msg.to.join(', ')}\n   ${msg.subject}${link ? `\n   Link: ${link}` : ''}${msg.attachments?.length ? `\n   Attached: ${msg.attachments.map(a => a.filename).join(', ')}` : ''}`);
      return r;
    },
  };
}

export function createResendMailer({ apiKey, from, fetchImpl = globalThis.fetch }) {
  return {
    async send({ to, subject, text, html, attachments, replyTo }) {
      const body = { from, to, subject, text, html };
      if (replyTo) body.reply_to = replyTo;
      if (attachments?.length) body.attachments = attachments.map(a => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') }));
      const r = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = await r.text();
      if (!r.ok) throw new Error(`Email failed (${r.status}): ${raw.slice(0, 200)}`);
      try { return { id: JSON.parse(raw).id }; } catch { return { id: null }; }
    },
  };
}
