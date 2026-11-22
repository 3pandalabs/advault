/**
 * WhatsApp in the UI, switched off by the owner (2026-11-22) until the loop is
 * ready for customers. While false, no page asks for a mobile number or
 * mentions WhatsApp: signup, Settings, the wizard, the campaign page, the
 * Change my offer card, the dashboard card and /dashboard/offer. The API is
 * unchanged (it still accepts a phone, and nothing is sent unless
 * WHATSAPP_SENDS=on). Turn back on by setting this to true.
 */
export const WHATSAPP_UI_ENABLED = false;
