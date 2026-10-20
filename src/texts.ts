/**
 * Every message the visitor or your team sees, in one place.
 * Translate or reword freely. The widget's own labels are set in its embed config (see README).
 */

export const VISITOR_TEXTS = {
  stage1: "One moment please, I'm checking whether someone from our team is available.",
  stage2:
    "Sorry, nobody is available right now. Leave your email address or phone number below and we'll get back to you as soon as possible.",
  contactReceived: "Thank you! We've received your details and will get back to you soon.",
  emailNoted: "Thanks, I've noted your email address. A team member will follow up with you.",
  invalidContact: 'Please enter a valid email address or phone number.',
  alreadyEnded: 'This chat has ended. Please start a new one.',
  tooManyMessages: 'You are sending messages too quickly. Please wait a moment.',
  sessionFull: 'This chat has reached its maximum length. Please start a new one.',
  invalidMessage: 'Invalid message format.',
  fileTypeNotAllowed: 'This file type is not allowed. Allowed: JPG, PNG, GIF, WebP, PDF and plain text.',
  fileTooLarge: 'This file is too large. The maximum is 10 MB.',
  fileContentMismatch: "The file's content does not match its type.",
  tooManyUploads: 'You have reached the upload limit for this chat.',
  fileFailed: '[A file could not be delivered]',
};

export const SLACK_TEXTS = {
  newChat: '💬 *New live chat*',
  visitor: 'Visitor',
  page: 'Page',
  referrer: 'Referrer',
  unknown: 'Unknown',
  fileUploaded: (name: string) => `📎 Visitor sent a file: ${name}`,
  fileMessage: (name: string) => `📎 [File: ${name}]`,
  emailCaptured: (email: string) => `📧 Email captured: ${email}`,
  contactLeft: '📇 Visitor left contact details:',
  email: 'Email',
  phone: 'Phone',
  ticketCreated: '🎫 Ticket created.',
  ticketFailed: '⚠️ Creating the ticket failed. Please follow up manually.',
  botPrefix: (botName: string) => `🤖 ${botName}:`,
  stageNotice: (text: string) => `⏳ Auto-reply sent: _${text}_`,
};
