// FRIDAY Teams notification module
const WEBHOOK_URL = process.env.FRIDAY_TEAMS_WEBHOOK_URL;
const FRIDAY_PUBLIC_URL = process.env.FRIDAY_PUBLIC_URL || 'http://5.223.79.255:3000';

export async function sendFridayTeamsCard({ ticketId, title, summary, details, actionType }) {
  if (!WEBHOOK_URL) {
    console.warn('[FRIDAY TEAMS] FRIDAY_TEAMS_WEBHOOK_URL not set -- skipping');
    return { success: false };
  }
  try {
    const reviewUrl = actionType === 'phase1'
      ? `${FRIDAY_PUBLIC_URL}/build-review/${ticketId}/phase1`
      : `${FRIDAY_PUBLIC_URL}/build-review/${ticketId}/final`;

    const actions = [
      { "@type": "OpenUri", "name": "\ud83d\udd0d View Build Review", "targets": [{ "os": "default", "uri": reviewUrl }] }
    ];

    const card = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      "themeColor": "1E3348",
      "summary": title,
      "sections": [
        {
          "activityTitle": `\ud83c\udfd7\ufe0f FRIDAY | ${title}`,
          "activitySubtitle": `Ticket: **${ticketId}**`,
          "facts": [{ "name": "Summary", "value": summary }],
          "markdown": true
        },
        ...(details ? [{ "title": "Build Details", "text": details, "markdown": true }] : [])
      ],
      "potentialAction": actions
    };

    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card)
    });

    if (!res.ok) throw new Error(`Teams webhook failed: ${res.status}`);
    console.log(`[FRIDAY] Teams card sent: ${title}`);
    return { success: true };
  } catch(e) {
    console.warn('[FRIDAY TEAMS] Card failed (non-fatal):', e.message);
    return { success: false, error: e.message };
  }
}
