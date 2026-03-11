import crypto from "crypto";

const userState = new Map();

export default {
  async fetch(request) {

    if (request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    if (request.method === "POST") {

      const bodyText = await request.text();
      const body = JSON.parse(bodyText);

      const events = body.events || [];

      for (const event of events) {
        await handleEvent(event);
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }
};

async function handleEvent(event) {

  const userId = event.source?.userId;
  if (!userId) return;

  if (event.type === "follow") {

    userState.set(userId, {
      step: "job",
      job: "",
      area: "",
      timing: ""
    });

    await reply(event.replyToken, [
      quickReply(
        "ご登録ありがとうございます😊\n\n3つだけ教えてください。\n①希望職種\n②希望勤務地\n③転職時期\n\nまずは希望職種を教えてください。",
        ["営業","事務","販売","施工管理","コールセンター","IT","その他"]
      )
    ]);

    return;
  }

  if (event.type === "message" && event.message.type === "text") {

    const text = event.message.text;
    const state = userState.get(userId);

    if (!state) return;

    if (state.step === "job") {

      state.job = text;
      state.step = "area";

      await reply(event.replyToken, [
        quickReply(
          "ありがとうございます😊\n希望勤務地を教えてください。",
          ["関東","関西","東海","九州","全国"]
        )
      ]);

      return;
    }

    if (state.step === "area") {

      state.area = text;
      state.step = "timing";

      await reply(event.replyToken, [
        quickReply(
          "ありがとうございます😊\n転職時期を教えてください。",
          ["すぐに","1か月以内","3か月以内","半年以内","良い求人があれば"]
        )
      ]);

      return;
    }

    if (state.step === "timing") {

      state.timing = text;

      await reply(event.replyToken, [
        {
          type:"text",
          text:
`ご回答ありがとうございます😊

希望職種：${state.job}
希望勤務地：${state.area}
転職時期：${state.timing}

条件に合うお仕事をご案内します。`
        }
      ]);

      userState.delete(userId);

      return;
    }
  }
}

function quickReply(text, options) {

  return {
    type:"text",
    text:text,
    quickReply:{
      items: options.map(o => ({
        type:"action",
        action:{
          type:"message",
          label:o,
          text:o
        }
      }))
    }
  }
}

async function reply(replyToken, messages) {

  await fetch("https://api.line.me/v2/bot/message/reply",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":"Bearer "+process.env.LINE_CHANNEL_ACCESS_TOKEN
    },
    body:JSON.stringify({
      replyToken,
      messages
    })
  });
}