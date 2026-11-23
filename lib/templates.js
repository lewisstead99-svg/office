// The Terms of Sale master. Field names and page-1 positions were measured from
// "BD Terms of Sale 2026 Master Copy.pdf" (an Adobe Sign export) on 23 Nov 2026.
export const TERMS_OF_SALE = {
  id: 'terms-of-sale',
  name: 'Terms of Sale',
  fields: {
    client: 'Client', propertyAddress: 'Property Address', mobile: 'Mobile Telephone', email: 'Email Address',
    feePercent: 'Text Field 3', guidePrice: 'Text Field 1', sellerInitials: 'Initials 1', sellerSignature: 'For the Vendor',
    sellerName: 'Name', sellerDate: 'Date', senderSignature: 'For Berkeleys', senderName: 'Name 1', senderDate: 'Date 1',
  },
  dropFields: ['Text Field 2', 'ES_CERTIFYING_SIGNATURE'],
  // Joint sole and Multiple stay off until the client supplies their wording for page 1.
  bases: {
    sole: { label: 'Sole', text: null, enabled: true },
    jointSole: { label: 'Joint sole', text: null, enabled: false, needsOtherAgent: true },
    multiple: { label: 'Multiple', text: null, enabled: false },
  },
  basisRect: { page: 0, x: 88, y: 514, width: 456, height: 30 },
  headerBox: { left: 50, bottom: 730, right: 190, top: 790 },
  footerBox: { left: 0, bottom: 0, right: 596, top: 66 },
};

const TEMPLATES = { [TERMS_OF_SALE.id]: TERMS_OF_SALE };

export function getTemplate(id) {
  const t = TEMPLATES[id];
  if (!t) throw new Error(`Unknown template: ${id}`);
  return t;
}

export function enabledBases(template) {
  return Object.entries(template.bases)
    .filter(([key, b]) => b.enabled && (key === 'sole' || b.text))
    .map(([key, b]) => ({ key, label: b.label, needsOtherAgent: !!b.needsOtherAgent }));
}

// Draft wording for the client's solicitor to confirm (spec: "Needs from the client").
export const CANCEL_NOTICE = [
  'Your right to cancel',
  'You have the right to cancel this contract within 14 days without giving any reason. The cancellation period will expire 14 days after the day this contract was agreed.',
  'To cancel, tell us of your decision by a clear statement (for example, a letter sent by post or an email) to Berkeleys Drummond, 1 Haven Road, Canford Cliffs, Poole, BH13 7LE, hello@berkeleysdrummond.com, 01202 708383. You may use the model cancellation form below, but you do not have to.',
  'To meet the cancellation deadline, it is enough for you to send your message before the cancellation period has expired.',
  'If you cancel, we will stop marketing your property. If you asked us to start marketing during the cancellation period, you will pay an amount in proportion to the service provided until you told us you were cancelling, compared with the full coverage of the contract.',
];

export const MARKETING_REQUEST = 'asks Berkeleys Drummond to start marketing the property now, during the 14-day cancellation period.';

export const MODEL_FORM_LINES = [
  'Model cancellation form',
  '(Complete and return this form only if you wish to cancel the contract.)',
  'To: Berkeleys Drummond, 1 Haven Road, Canford Cliffs, Poole, BH13 7LE. hello@berkeleysdrummond.com',
  'I/We hereby give notice that I/We cancel my/our contract for the supply of the following service: estate agency services for the sale of {propertyAddress}',
  'Agreed on: ______________________',
  'Name(s) of consumer(s): ______________________',
  'Address of consumer(s): ______________________',
  'Signature of consumer(s) (only if this form is sent on paper): ______________________',
  'Date: ______________________',
];
