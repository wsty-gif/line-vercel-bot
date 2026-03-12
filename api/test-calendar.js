import { google } from "googleapis";

function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/calendar"]
  );
}

export default async function handler(req, res) {
  try {
    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const calendars = process.env.SOURCE_CALENDAR_IDS.split(",");

    const now = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(now.getDate() + 7);

    const result = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: nextWeek.toISOString(),
        items: calendars.map(id => ({ id: id.trim() }))
      }
    });

    res.status(200).json(result.data);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
}