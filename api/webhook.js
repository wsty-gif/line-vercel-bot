import { google } from "googleapis";

const userState = new Map();

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const LEAD_TIME_MS = 60 * 60 * 1000; // 1時間後から表示

function toJst(date) {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

function getJstParts(date) {
  const j = toJst(date);
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    weekday: j.getUTCDay(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
  };
}

function makeUtcDateFromJst(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0));
}

function formatSlotLabel(date) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const j = toJst(date);

  const m = j.getUTCMonth() + 1;
  const d = j.getUTCDate();
  const w = weekdays[j.getUTCDay()];
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");

  return `${m}/${d}(${w}) ${hh}:${mm}`;
}

function toGoogleJstDateTime(date) {
  const j = toJst(date);

  const y = j.getUTCFullYear();
  const m = String(j.getUTCMonth() + 1).padStart(2, "0");
  const d = String(j.getUTCDate()).padStart(2, "0");
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");
  const ss = String(j.getUTCSeconds()).padStart(2, "0");

  return `${y}-${m}-${d}T${hh}:${mm}:${ss}+09:00`;
}

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

async function getAvailableSlots() {
  const calendar = await getCalendarClient();

  const calendarIds = (process.env.SOURCE_CALENDAR_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const now = new Date();
  const minSelectableTime = new Date(now.getTime() + LEAD_TIME_MS);

  const after7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

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
  const baseJst = getJstParts(now);

  for (let i = 0; i < 7; i++) {
    // JST日付ベースで日ごとに処理
    const jstDayBase = new Date(Date.UTC(baseJst.year, baseJst.month - 1, baseJst.day + i));
    const year = jstDayBase.getUTCFullYear();
    const month = jstDayBase.getUTCMonth() + 1;
    const day = jstDayBase.getUTCDate();
    const weekday = jstDayBase.getUTCDay();

    // 平日のみ
    if (weekday === 0 || weekday === 6) continue;

    for (let hour = 10; hour < 18; hour++) {
      for (const minute of [0, 30]) {
        const slotStart = makeUtcDateFromJst(year, month, day, hour, minute);
        const slotEnd = makeUtcDateFromJst(year, month, day, hour, minute + 30);

        // 18:00を超える枠は除外
        const endJst = getJstParts(slotEnd);
        if (endJst.hour > 18 || (endJst.hour === 18 && endJst.minute > 0)) {
          continue;
        }

        // 現在時刻から1時間後以降のみ
        if (slotStart < minSelectableTime) {
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

        if (slots.length >= 5) {
          return slots;
        }
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

  const startDate = new Date(slot.start);
  const endDate = new Date(slot.end);

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
        dateTime: toGoogleJstDateTime(startDate),
        timeZone: "Asia/Tokyo",
      },
      end: {
        dateTime: toGoogleJstDateTime(endDate),
        timeZone: "Asia/Tokyo",
      },
    },
  });

  console.log("booking event id:", result.data.id);
  console.log("booking event htmlLink:", result.data.htmlLink);
  console.log("booking event start:", result.data.start);
  console.log("booking event end:", result.data.end);

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
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
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

  const text = await res.text();
  console.log("LINE reply status:", res.status);
  console.log("LINE reply body:", text);

  if (!res.ok) {
    throw new Error(`LINE reply failed: ${res.status} ${text}`);
  }
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
      userId: userId,
      job: "",
      area: "",
      timing: ""
    });

    await reply(event.replyToken, [
      quickReply(
        "ご登録ありがとうございます😊\n\n3つだけ教えてください。\n①希望職種\n②希望勤務地\n③転職時期\n\nまずは希望職種を教えてください。",
        ["営業", "事務", "販売", "施工管理", "コールセンター", "IT", "その他"]
      )
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
          text: "最初からご案内しますので、もう一度友だち追加後のメッセージからご回答ください。"
        }
      ]);
      return;
    }

    // 希望職種
    if (state.step === "job") {
      state.job = text;
      state.step = "area";
      userState.set(userId, state);

      console.log("state after job:", JSON.stringify(state));

      await reply(event.replyToken, [
        quickReply(
          "ありがとうございます😊\n希望勤務地を教えてください。",
          ["関東", "関西", "東海", "九州", "全国"]
        )
      ]);
      return;
    }

    // 希望勤務地
    if (state.step === "area") {
      state.area = text;
      state.step = "timing";
      userState.set(userId, state);

      console.log("state after area:", JSON.stringify(state));

      await reply(event.replyToken, [
        quickReply(
          "ありがとうございます😊\n転職時期を教えてください。",
          ["すぐに", "1か月以内", "3か月以内", "半年以内", "良い求人があれば"]
        )
      ]);
      return;
    }

    // 転職時期
    if (state.step === "timing") {
      state.timing = text;
      state.step = "booking_select";
      userState.set(userId, state);

      console.log("state after timing:", JSON.stringify(state));

      const slots = await getAvailableSlots();

      if (slots.length === 0) {
        await reply(event.replyToken, [
          {
            type: "text",
            text: "現在ご案内できる面談候補が見つかりませんでした。担当より別途ご連絡いたします。"
          }
        ]);
        return;
      }

      await reply(event.replyToken, [createSlotQuickReply(slots)]);
      return;
    }

    await reply(event.replyToken, [
      {
        type: "text",
        text: "ご希望条件は確認済みです。候補日時の選択をお願いします😊"
      }
    ]);
    return;
  }

  if (event.type === "postback") {
    const state = userState.get(userId);

    if (!state) {
      await reply(event.replyToken, [
        {
          type: "text",
          text: "予約情報の保持に失敗しました。恐れ入りますが、最初からもう一度お試しください。"
        }
      ]);
      return;
    }

    try {
      const rawData = event.postback?.data || "{}";
      console.log("postback rawData:", rawData);

      const data = JSON.parse(rawData);
      console.log("postback parsed:", data);

      if (data.type === "booking_select") {
        // まず即時返信
        await reply(event.replyToken, [
          {
            type: "text",
            text: `ご希望日時「${data.label}」で予約処理を進めています。少々お待ちください😊`
          }
        ]);

        try {
          const available = await isStillAvailable(data.start, data.end);
          console.log("still available:", available);

          if (!available) {
            const slots = await getAvailableSlots();

            if (slots.length === 0) {
              await pushMessage(userId, [
                {
                  type: "text",
                  text: "申し訳ありません。選択された時間は埋まってしまいました。担当より別途ご連絡いたします。"
                }
              ]);
              userState.delete(userId);
              return;
            }

            await pushMessage(userId, [
              {
                type: "text",
                text: "申し訳ありません。選択された時間は埋まってしまいました。別の候補をお送りします。"
              },
              createSlotQuickReply(slots)
            ]);
            return;
          }

          const booking = await createBookingEvent(state, {
            label: data.label,
            start: data.start,
            end: data.end,
          });

          console.log("booking event id:", booking?.id);
          console.log("booking event htmlLink:", booking?.htmlLink);

          try {
            await saveToGas({
              userId,
              job: state.job,
              area: state.area,
              timing: state.timing,
              bookingLabel: data.label,
              bookingStart: data.start,
              bookingEnd: data.end,
              bookingEventId: booking.id,
              bookingHtmlLink: booking.htmlLink || ""
            });
            console.log("saveToGas success");
          } catch (gasError) {
            console.error("saveToGas error:", gasError);
          }

          await pushMessage(userId, [
            {
              type: "text",
              text:
                `面談予約を受け付けました😊\n\n` +
                `予約日時：${data.label}\n` +
                `希望職種：${state.job}\n` +
                `希望勤務地：${state.area}\n` +
                `転職時期：${state.timing}\n\n` +
                `担当者より改めてご連絡いたします。`
            }
          ]);

          userState.delete(userId);
          return;

        } catch (error) {
          console.error("postback booking error:", error);

          await pushMessage(userId, [
            {
              type: "text",
              text: "申し訳ありません。予約処理中にエラーが発生しました。担当より別途ご連絡いたします。"
            }
          ]);
          return;
        }
      }

      await reply(event.replyToken, [
        {
          type: "text",
          text: "予約内容の判定に失敗しました。恐れ入りますが、もう一度お試しください。"
        }
      ]);
      return;

    } catch (error) {
      console.error("postback booking error:", error);

      await reply(event.replyToken, [
        {
          type: "text",
          text: "申し訳ありません。予約処理中にエラーが発生しました。担当より別途ご連絡いたします。"
        }
      ]);
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

async function pushMessage(userId, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      to: userId,
      messages,
    }),
  });

  const text = await res.text();
  console.log("LINE push status:", res.status);
  console.log("LINE push body:", text);

  if (!res.ok) {
    throw new Error(`LINE push failed: ${res.status} ${text}`);
  }
}