import { google } from "googleapis";

function getPrivateKey() {
  const key = process.env.GOOGLE_PRIVATE_KEY || "";
  return key.replace(/\\n/g, "\n");
}

async function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: getPrivateKey(),
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const authClient = await auth.getClient();
  return google.calendar({ version: "v3", auth: authClient });
}

export default async function handler(req, res) {
  try {
    const calendar = await getCalendarClient();

    const calendarIds = (process.env.SOURCE_CALENDAR_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (calendarIds.length === 0) {
      return res.status(500).json({
        error: "SOURCE_CALENDAR_IDS が空です",
      });
    }

    const now = new Date();
    const after7days = new Date();
    after7days.setDate(now.getDate() + 7);

    const result = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: after7days.toISOString(),
        timeZone: "Asia/Tokyo",
        items: calendarIds.map((id) => ({ id })),
      },
    });

    return res.status(200).json({
      ok: true,
      calendars: result.data.calendars,
      groups: result.data.groups || {},
      timeMin: result.data.timeMin,
      timeMax: result.data.timeMax,
    });
  } catch (error) {
    console.error("test-calendar error:", error);

    return res.status(500).json({
      error: error.message,
      details: error.response?.data || null,
      envCheck: {
        hasClientEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
        hasPrivateKey: !!process.env.GOOGLE_PRIVATE_KEY,
        hasSourceCalendarIds: !!process.env.SOURCE_CALENDAR_IDS,
      },
    });
  }
}