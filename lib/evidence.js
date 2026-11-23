// The facts that go on the "Signing record" page, gathered from the event log.
export function evidenceFrom({ contract, signers, events, templateVersion }) {
  return {
    ref: String(contract.id).slice(0, 8).toUpperCase(),
    propertyAddress: contract.fields?.propertyAddress ?? '',
    templateVersion: { version: templateVersion?.version ?? null, sha256: templateVersion?.sha256 ?? null },
    presentedSha256: contract.presentedSha256 ?? null,
    presentedLength: contract.presentedLength ?? null,
    sender: { name: contract.sender?.name ?? '', email: contract.sender?.email ?? '', sentAt: contract.sentAt ?? null },
    signers: signers.map(s => {
      const mine = events.filter(e => e.signerId === s.id);
      const opens = mine.filter(e => e.type === 'opened');
      const consent = mine.filter(e => e.type === 'consented').at(-1);
      const signed = mine.filter(e => e.type === 'signed').at(-1);
      return {
        name: s.name,
        email: s.email,
        sharedEmail: !!s.sharedEmail,
        sentAt: contract.sentAt ?? null,
        opens: opens.slice(0, 5).map(e => ({ at: e.at, ip: e.ip ?? null, userAgent: e.userAgent ?? null })),
        moreOpens: Math.max(0, opens.length - 5),
        consentedAt: consent?.at ?? null,
        signedAt: s.signedAt ?? signed?.at ?? null,
        ip: signed?.ip ?? null,
        userAgent: signed?.userAgent ?? null,
        startMarketingNow: s.startMarketingNow ?? null,
      };
    }),
  };
}
