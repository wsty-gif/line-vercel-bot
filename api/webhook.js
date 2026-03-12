import { google } from "googleapis";

const userState = new Map();

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

function isWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function overlaps(slotStart, slotEnd, busyStart, busyEnd) {
  return slotStart < busyEnd && slotEnd > busyStart;
}

function formatSlotLabel(date) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${m}/${d}(${w}) ${hh}:${mm}`;
}

async function getAvailableSlots() {
  const calendar = await getCalendarClient();

  const calendarIds = (process.env.SOURCE_CALENDAR_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const now = new Date();
  const after7days = new Date();
  after7days.setDate(now.getDate() + 7);

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: after7days.toISOString(),
      timeZone: "Asia/Tokyo",
      items: calendarIds.map((id) => ({ id })),
    },
  });

  const busyList = [];
  for (const id of calendarIds) {
    const arr = fb.data.calendars?.[id]?.busy || [];
    for (const b of arr) {
      busyList.push({
        start: new Date(b.start),
        end: new Date(b.end),
      });
    }
  }

  const slots = [];

  for (let i = 0; i < 7; i++) {
    const day = new Date(now);
    day.setDate(now.getDate() + i);
    day.setHours(10, 0, 0, 0);

    if (!isWeekday(day)) continue;

    while (day.getHours() < 18) {
      const slotStart = new Date(day);
      const slotEnd = new Date(day);
      slotEnd.setMinutes(slotEnd.getMinutes() + 30);

      if (slotEnd.getHours() > 18 || (slotEnd.getHours() === 18 && slotEnd.getMinutes() > 0)) {
        break;
      }

      if (slotStart <= now) {
        day.setMinutes(day.getMinutes() + 30);
        continue;
      }

      const isBusy = busyList.some((b) =>
        overlaps(slotStart, slotEnd, b.start, b.end)
      );

      if (!isBusy) {
        slots.push({
          label: formatSlotLabel(slotStart),
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
        });
      }

      day.setMinutes(day.getMinutes() + 30);

      if (slots.length >= 5) {
        return slots;
      }
    }
  }

  return slots;
}

async function isStillAvailable(start, end) {
  const calendar = await getCalendarClient();

  const calendarIds = (process.env.SOURCE_CALENDAR_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: start,
      timeMax: end,
      timeZone: "Asia/Tokyo",
      items: calendarIds.map((id) => ({ id })),
    },
  });

  for (const id of calendarIds) {
    const busy = fb.data.calendars?.[id]?.busy || [];
    if (busy.length > 0) {
      return false;
    }
  }

  return true;
}

async function createBookingEvent(state, slot) {
  const calendar = await getCalendarClient();

  const result = await calendar.events.insert({
    calendarId: process.env.BOOKING_CALENDAR_ID,
    requestBody: {
      summary: `LINE面談予約｜${state.job}｜${state.area}`,
      description:
        `希望職種: ${state.job}\n` +
        `希望勤務地: ${state.area}\n` +
        `転職時期: ${state.timing}\n` +
        `予約枠: ${slot.label}\n` +
        `LINE userId: ${state.userId || ""}`,
      start: {
        dateTime: slot.start,
        timeZone: "Asia/Tokyo",
      },
      end: {
        dateTime: slot.end,
        timeZone: "Asia/Tokyo",
      },
    },
  });

  return result.data;
}

function quickReply(text, options) {
  return {
    type: "text",
    text,
    quickReply: {
      items: options.map((o) => ({
        type: "action",
        action: {
          type: "message",
          label: o,
          text: o,
        },
      })),
    },
  };
}

function createSlotQuickReply(slots) {
  return {
    type: "text",
    text: "面談候補のお時間です。ご都合の良いものを1つお選びください😊",
    quickReply: {
      items: slots.map((slot) => ({
        type: "action",
        action: {
          type: "postback",
          label: slot.label,
          data: JSON.stringify({
            type: "booking_select",
            start: slot.start,
            end: slot.end,
            label: slot.label,
          }),
          displayText: slot.label,
        },
      })),
    },
  };
}

async function reply(replyToken, messages) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
  });
}

async function saveToGas(data) {
  const gasUrl = process.env.GAS_SAVE_URL;
  if (!gasUrl) return;

  await fetch(gasUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
}

async function handleEvent(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  if (event.type === "follow") {
    userState.set(userId, {
      step: "job",
      userId,
      job: "",
      area: "",
      timing: "",
    });

    await reply(event.replyToken, [
      quickReply(
        "ご登録ありがとうございます😊\n\n3つだけ教えてください。\n①希望職種\n②希望勤務地\n③転職時期\n\nまずは希望職種を教えてください。",
        ["営業", "事務", "販売", "施工管理", "コールセンター", "IT", "その他"]
      ),
    ]);
    return;
  }

  if (event.type === "message" && event.message?.type === "text") {
    const text = event.message.text.trim();
    const state = userState.get(userId);

    if (!state) {
      await reply(event.replyToken, [
        {
          type: "text",
          text: "最初からご案内しますので、もう一度友だち追加後のメッセージからご回答ください。",
        },
      ]);
      return;
    }

    if (state.step === "job") {
      state.job = text;
      state.step = "area";
      userState.set(userId, state);

      await reply(event.replyToken, [
        quickReply(
          "ありがとうございます😊\n希望勤務地を教えてください。",
          ["関東", "関西", "東海", "九州", "全国"]
        ),
      ]);
      return;
    }

    if (state.step === "area") {
      state.area = text;
      state.step = "timing";
      userState.set(userId, state);

      await reply(event.replyToken, [
        quickReply(
          "ありがとうございます😊\n転職時期を教えてください。",
          ["すぐに", "1か月以内", "3か月以内", "半年以内", "良い求人があれば"]
        ),
      ]);
      return;
    }

    if (state.step === "timing") {
      state.timing = text;
      state.step = "booking_select";
      userState.set(userId, state);

      const slots = await getAvailableSlots();

      if (slots.length === 0) {
        await reply(event.replyToken, [
          {
            type: "text",
            text: "現在ご案内できる面談候補が見つかりませんでした。担当より別途ご連絡いたします。",
          },
        ]);
        return;
      }

      await reply(event.replyToken, [createSlotQuickReply(slots)]);
      return;
    }

    await reply(event.replyToken, [
      {
        type: "text",
        text: "ご希望条件は確認済みです。候補日時の選択をお願いします😊",
      },
    ]);
    return;
  }

  if (event.type === "postback") {
    const state = userState.get(userId);
    if (!state) return;

    const data = JSON.parse(event.postback.data || "{}");

    if (data.type === "booking_select") {
      const available = await isStillAvailable(data.start, data.end);

      if (!available) {
        const slots = await getAvailableSlots();

        if (slots.length === 0) {
          await reply(event.replyToken, [
            {
              type: "text",
              text: "申し訳ありません。選択された時間は埋まってしまいました。担当より別途ご連絡いたします。",
            },
          ]);
          userState.delete(userId);
          return;
        }

        await reply(event.replyToken, [
          {
            type: "text",
            text: "申し訳ありません。選択された時間は埋まってしまいました。別の候補をお選びください。",
          },
          createSlotQuickReply(slots),
        ]);
        return;
      }

      const booking = await createBookingEvent(state, {
        label: data.label,
        start: data.start,
        end: data.end,
      });

      await saveToGas({
        userId,
        job: state.job,
        area: state.area,
        timing: state.timing,
        bookingLabel: data.label,
        bookingStart: data.start,
        bookingEnd: data.end,
        bookingEventId: booking.id,
      });

      await reply(event.replyToken, [
        {
          type: "text",
          text:
            `面談予約を受け付けました😊\n\n` +
            `予約日時：${data.label}\n` +
            `希望職種：${state.job}\n` +
            `希望勤務地：${state.area}\n` +
            `転職時期：${state.timing}\n\n` +
            `担当者より改めてご連絡いたします。`,
        },
      ]);

      userState.delete(userId);
      return;
    }
  }
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    if (request.method === "POST") {
      try {
        const bodyText = await request.text();
        const body = JSON.parse(bodyText);
        const events = body.events || [];

        for (const event of events) {
          await handleEvent(event);
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("webhook error:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};