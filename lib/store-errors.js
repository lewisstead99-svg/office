export class ConflictError extends Error {
  constructor(message = 'Someone else updated this contract at the same moment. Please try again.') {
    super(message);
    this.status = 409;
  }
}
