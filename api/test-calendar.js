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

    const start = new Date();
    start.setHours(start.getHours() + 2, 0, 0, 0);

    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 30);

    const result = await calendar.events.insert({
      calendarId: process.env.BOOKING_CALENDAR_ID,
      requestBody: {
        summary: "LINE面談予約テスト",
        description: "Vercelからの自動登録テスト",
        start: {
          dateTime: start.toISOString(),
          timeZone: "Asia/Tokyo",
        },
        end: {
          dateTime: end.toISOString(),
          timeZone: "Asia/Tokyo",
        },
      },
    });

    return res.status(200).json({
      ok: true,
      eventId: result.data.id,
      htmlLink: result.data.htmlLink,
    });
  } catch (error) {
    console.error("test-booking error:", error);
    return res.status(500).json({
      error: error.message,
      details: error.response?.data || null,
    });
  }
}