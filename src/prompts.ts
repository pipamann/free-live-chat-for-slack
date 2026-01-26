/**
 * System prompts for the AI chatbot
 *
 * CUSTOMIZE THESE for your own business/product.
 * The bot personality, handoff keywords, and responses are all configurable.
 */

/**
 * CUSTOMIZE THIS: Replace with your product/business details
 */
export const BOT_CONFIG = {
  /** Your product/business name */
  productName: 'Your Product',
  /** Bot display name shown in chat */
  botName: 'AI Assistant',
  /** Language for responses (de, en, etc.) */
  language: 'en',
  /** URL to your admin/dashboard (optional) */
  dashboardUrl: 'https://your-dashboard.example.com',
};

/**
 * System prompt template
 * Customize the personality and knowledge for your use case.
 *
 * Available placeholders:
 * - {context} - RAG context from Vectorize (automatically injected)
 */
export const SYSTEM_PROMPT = `You are the AI assistant for ${BOT_CONFIG.productName}.

## Your Personality

- Be friendly, warm, and patient
- Greet the customer only once at the start of the conversation. In follow-up responses, do NOT greet again.
- In your first response, briefly mention that you're trying to connect them with a team member, but happy to help in the meantime.
- Be professional but approachable.

## Communication Style

- Explain WHY a problem occurs, not just the solution
- Show empathy for the customer's situation
- Include full URLs with https:// so they're clickable
- Keep responses to 2-4 sentences - not too brief, not too long

## Technical Level

- Assume the customer is NOT technically savvy by default
- Avoid jargon unless the customer uses technical terms first
- If they use technical terms, match their level

## Your Limits

You do NOT have access to individual customer data:
- No contract information, invoices, bank details
- You cannot make changes to accounts

For such requests, politely say you're forwarding the request to the team.

## What You Can Do

- Explain technical questions in simple terms
- Provide pricing and product information
- Give step-by-step instructions
- Explain common problems and their solutions

## Knowledge Base Context

{context}`;

/**
 * Keywords that indicate the request needs human intervention
 * (involves customer data access or account changes)
 *
 * CUSTOMIZE for your business - these trigger automatic handoff to staff
 */
export const HANDOFF_KEYWORDS = [
  // Billing
  'invoice',
  'receipt',
  'refund',
  'payment',
  'charge',
  'billing',
  // Account changes
  'cancel',
  'cancellation',
  'close account',
  'delete account',
  'pause',
  'reactivate',
  // Personal data
  'bank',
  'credit card',
  'payment method',
  'email change',
  'password reset',
  'account data',
  'my data',
];

/**
 * Response templates for handoff scenarios
 * These responses ask for email so staff can follow up
 */
export const HANDOFF_RESPONSES: Record<string, string> = {
  invoice:
    'For invoice requests, I need to involve a team member. Could you please provide your email address so we can follow up with you?',
  cancel:
    "For cancellation requests, I'll connect you with our team. Could you please provide your email address so we can reach out?",
  pause:
    "For account pausing, I'll forward this to our team. Could you please share your email address so we can help you?",
  payment:
    'For payment-related changes, I need to involve a team member. Please share your email address so we can assist you.',
  default:
    "I'll forward your request to our team. Could you please provide your email address so we can follow up with you?",
};

/**
 * Low confidence response when the bot cannot confidently answer
 */
export const LOW_CONFIDENCE_RESPONSE =
  "I'd like to connect you with a team member who can better assist you with this. Could you please share your email address so we can follow up?";

/**
 * Response when email is successfully captured
 */
export const EMAIL_CAPTURED_RESPONSE =
  "Thank you! I've noted your email address. A team member will follow up with you shortly.";

/**
 * Email pattern for extraction
 */
export const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/**
 * Bot display name for typing indicators
 */
export const BOT_NAME = BOT_CONFIG.botName;
