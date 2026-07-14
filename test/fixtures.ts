// 웹훅 페이로드 픽스처 (설계서 §3.3 · Meta 공식 예시 형태)

export const commentEvent = {
  object: "instagram",
  entry: [
    {
      id: "17841400000000000",
      time: 1720900000,
      changes: [
        {
          field: "comments",
          value: {
            id: "COMMENT_1",
            text: "빛 신청합니다",
            media: { id: "MEDIA_1" },
            from: { id: "USER_A", username: "user_a" },
          },
        },
      ],
    },
  ],
};

export const commentNoKeyword = {
  object: "instagram",
  entry: [
    {
      changes: [
        {
          field: "comments",
          value: { id: "COMMENT_2", text: "예쁘네요", media: { id: "MEDIA_1" }, from: { id: "USER_B" } },
        },
      ],
    },
  ],
};

export const dmEvent = {
  object: "instagram",
  entry: [
    {
      id: "17841400000000000",
      messaging: [
        {
          sender: { id: "USER_C" },
          recipient: { id: "ME" },
          message: { mid: "MID_1", text: "e북 주세요" },
        },
      ],
    },
  ],
};

export const dmEcho = {
  object: "instagram",
  entry: [
    {
      messaging: [
        {
          sender: { id: "ME" },
          recipient: { id: "USER_C" },
          message: { mid: "MID_2", text: "안녕하세요", is_echo: true },
        },
      ],
    },
  ],
};

export const storyReplyEvent = {
  object: "instagram",
  entry: [
    {
      messaging: [
        {
          sender: { id: "USER_D" },
          recipient: { id: "ME" },
          message: { mid: "MID_3", text: "🔥", reply_to: { story: { id: "STORY_1" } } },
        },
      ],
    },
  ],
};
