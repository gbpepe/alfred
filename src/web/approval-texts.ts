// APPROVALTAGEN1108: every text the server sends the OWNER about an approval, in the post's /
// install's language (approvalTextLang(): the explicit AGENT_TEXT_LANG key).
import { APP_TZ } from '../config.js'

export type ApprovalLang = 'hu' | 'en'

/** The expiry as the owner reads it: hu exactly as before; en a medium date and a short time, the same zone. */
export function formatExpiry(timeoutAt: number | null | undefined, lang: ApprovalLang): string {
  if (!timeoutAt) return lang === 'en' ? 'none' : 'nincs'
  const d = new Date(timeoutAt * 1000)
  return lang === 'en'
    ? d.toLocaleString('en-GB', { timeZone: APP_TZ, dateStyle: 'medium', timeStyle: 'short' })
    : d.toLocaleString('hu-HU', { timeZone: APP_TZ })
}

/** A wall-clock moment in an owner alert (the notify.ts tamper alerts): hu exactly as before. */
export function formatMoment(d: Date, lang: ApprovalLang): string {
  return lang === 'en'
    ? d.toLocaleString('en-GB', { timeZone: APP_TZ, dateStyle: 'medium', timeStyle: 'medium' })
    : d.toLocaleString('hu-HU', { timeZone: APP_TZ })
}

/** The time of a decision in the DM thread (hours:minutes), in APP_TZ. */
export function formatDecisionTime(d: Date, lang: ApprovalLang): string {
  return d.toLocaleTimeString(lang === 'en' ? 'en-GB' : 'hu-HU', { hour: '2-digit', minute: '2-digit', timeZone: APP_TZ })
}

export const OWNER_TEXT = {
  hu: {
    requestTag: '[JÓVÁHAGYÁS KELL]',
    chatApprovedTag: '[JÓVÁHAGYVA A CHATBEN]',
    expires: 'Lejárat',
    decideOnDashboard: (id: string) => `Döntés: Dashboard -> Jóváhagyások (id: ${id})`,
    chatApprovedBy: (messageId: string) => `Jóváhagyás: a chat-üzeneted (üzenet-azonosító: ${messageId})`,
    nothingToDo: 'Nincs további teendőd, ez csak tájékoztatás.',
    logOnDashboard: (id: string) => `Napló: Dashboard -> Jóváhagyások (id: ${id})`,
    decideLine: {
      reaction: 'Döntés: reagálj erre az üzenetre ✅ (jóváhagyás) vagy ❌ (elutasítás) reakcióval. Csak a te reakciód számít, és csak amíg ez az üzenet változatlan.',
      reply: 'Döntés: írd be válaszként: mehet (jóváhagyás) vagy nem (elutasítás). Csak a te válaszod számít, és csak amíg ez az üzenet változatlan.',
      both: 'Döntés: írd be válaszként: mehet (jóváhagyás) vagy nem (elutasítás), vagy reagálj ✅ / ❌ reakcióval. Csak a te válaszod számít, és csak amíg ez az üzenet változatlan.',
    },
    orOnDashboard: (pageUrl: string, id: string) => `Vagy a dashboardon: ${pageUrl} (id: ${id})`,
    dashboardOnly: (reason: string) => `Erre a kérésre a chat-jóváhagyás nem érhető el (${reason}); a döntés a dashboardon.`,
    agentCreateTooLong: (id: string, url: string) => `Új ügynök létrehozását kérték (${id}). A kérés túl hosszú az azonnali jóváhagyáshoz, a dashboardon döntesz: ${url}`,
    result: { approved: 'Jóváhagyva', rejected: 'Elutasítva' },
    editedNotice: 'A szerkesztett üzenetet nem veszem döntésnek. Ha döntöttél, írd be újra: mehet vagy nem.',
    refusedFeedback: (when: string, reason: string) => `Elutasítva (${when}): a döntés nem fogadható el (${reason}). Ha jóvá akartad hagyni, kérd újra.`,
    unchangedFeedback: (when: string) => `A kérés már nem volt függőben (lejárt, vagy máshol döntöttek róla), ezért nem változott (${when}).`,
    replyFeedback: (result: string, when: string, ts: string) => `${result} (${when}, a ${ts} üzeneted alapján).`,
    notMeant: (pageUrl: string) => ` Ha nem erre gondoltál: ${pageUrl}`,
    reactionFeedback: (result: string, when: string) => `${result} (${when}, chat-reakció).`,
    alertReplyUsed: (id: string) => `[FIGYELEM] Egy chat-válasz már egy másik kérést döntött el, ezért ez a kérés elutasítva (id: ${id}).`,
    alertRefused: (reason: string, id: string) => `[FIGYELEM] Egy chat-jóváhagyás nem volt elfogadható (${reason}), a kérés elutasítva (id: ${id}).`,
  },
  en: {
    requestTag: '[APPROVAL NEEDED]',
    chatApprovedTag: '[APPROVED IN CHAT]',
    expires: 'Expires',
    decideOnDashboard: (id: string) => `Decide: Dashboard -> Approvals (id: ${id})`,
    chatApprovedBy: (messageId: string) => `Approved by: your chat message (message id: ${messageId})`,
    nothingToDo: 'Nothing more to do, this is for your information.',
    logOnDashboard: (id: string) => `Log: Dashboard -> Approvals (id: ${id})`,
    decideLine: {
      reaction: 'To decide: react to this message with ✅ (approve) or ❌ (reject). Only your reaction counts, and only while this message is unchanged.',
      reply: 'To decide: reply with approve or go (approve), or reject or no (reject); mehet, jóváhagyom, nem and elutasítom work too. Only your reply counts, and only while this message is unchanged.',
      both: 'To decide: reply with approve or go (approve), or reject or no (reject); mehet, jóváhagyom, nem and elutasítom work too; or react with ✅ / ❌. Only your reply counts, and only while this message is unchanged.',
    },
    orOnDashboard: (pageUrl: string, id: string) => `Or on the dashboard: ${pageUrl} (id: ${id})`,
    dashboardOnly: (reason: string) => `Chat approval is not available for this request (${reason}); decide on the dashboard.`,
    agentCreateTooLong: (id: string, url: string) => `A new agent was requested (${id}). The request is too long for chat approval; decide on the dashboard: ${url}`,
    result: { approved: 'Approved', rejected: 'Rejected' },
    editedNotice: 'An edited message does not count as a decision. If you decided, write it again: approve or reject.',
    refusedFeedback: (when: string, reason: string) => `Rejected (${when}): the decision could not be accepted (${reason}). If you meant to approve, ask again.`,
    unchangedFeedback: (when: string) => `The request was no longer pending (it expired, or was decided elsewhere), so nothing changed (${when}).`,
    replyFeedback: (result: string, when: string, ts: string) => `${result} (${when}, based on your message ${ts}).`,
    notMeant: (pageUrl: string) => ` If this is not what you meant: ${pageUrl}`,
    reactionFeedback: (result: string, when: string) => `${result} (${when}, chat reaction).`,
    alertReplyUsed: (id: string) => `[WARNING] A chat reply had already decided another request, so this request was rejected (id: ${id}).`,
    alertRefused: (reason: string, id: string) => `[WARNING] A chat approval could not be accepted (${reason}), so the request was rejected (id: ${id}).`,
  },
}

export type OwnerText = (typeof OWNER_TEXT)['hu']
